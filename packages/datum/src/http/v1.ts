import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { Rejection, asRejection } from "../domain/errors.js";
import { newId } from "../domain/identity.js";
import { resolveChain, KNOWLEDGE_MODE_PREDICATE, KNOWLEDGE_MODE_SUBJECT } from "../domain/scope.js";
import {
  assertFact,
  byId,
  contradictions,
  createMission,
  currentSequence,
  lineage,
  logRejection,
  missions,
  search,
  take,
} from "../domain/store.js";
import { CONFIDENCE_CLASSES, KINDS, type AssertionRow } from "../domain/types.js";
import { authenticateKey, requirePermission, requireScope, type AuthedKey } from "./auth.js";

/**
 * `/v1` is the real interface. MCP is a facade over it.
 *
 * That split is not stylistic. MCP 2026-07-28 deleted sessions, the initialize handshake, ping,
 * the GET endpoint and Last-Event-ID resumability, and made statelessness normative — which
 * makes presence and heartbeats literally unrepresentable in the protocol. The registry, cursors
 * and projections therefore cannot live in MCP, so they live here.
 */

const ScopeString = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/, "scope must be slash-separated labels");

const EvidenceSchema = z
  .object({
    source: z.string().min(1, "evidence.source is required: no assertion without evidence"),
    repo: z.string().optional(),
    commit: z.string().optional(),
    contained_in: z.array(z.string()).optional(),
    instrument: z.string().optional(),
    protocol: z.string().optional(),
    artifacts: z.array(z.string()).optional(),
    human: z.string().optional(),
  })
  .loose();

const AssertBody = z.object({
  scope: ScopeString,
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.record(z.string(), z.unknown()),
  claim: z.string().nullish(),
  kind: z.enum(KINDS),
  // All four classes are accepted here on purpose. `measured` and `derived` are refused by the
  // database with reason `confidence_is_earned` and a hint saying what to do instead, and that
  // is a far more useful answer than a schema error would be. The API must not pre-empt an
  // invariant with a vaguer message.
  confidence: z.enum(CONFIDENCE_CLASSES).optional(),
  evidence: EvidenceSchema,
  valid_from: z.string().optional(),
  valid_to: z.string().nullish(),
  asserted_by: z.string().min(1).optional(),
  why: z.string().nullish(),
  reopen_if: z.string().nullish(),
  causality: z.string().nullish(),
  supersedes: z.string().nullish(),
});

const SupersedeBody = AssertBody.extend({ supersedes: z.string().min(1) });

const GateSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  op: z.enum([">=", "<=", ">", "<", "=", "!="]),
  target: z.union([z.number(), z.string(), z.boolean()]),
  requires_confidence: z.enum(CONFIDENCE_CLASSES),
  note: z.string().optional(),
});

const MissionBody = z.object({
  scope: ScopeString,
  statement: z.string().min(1),
  state: z.enum(["proposed", "active", "blocked", "closed"]),
  gates: z.array(GateSchema),
  supersedes: z.string().nullish(),
});

const NodeBody = z.object({
  kind: z.enum(["agent", "worktree", "branch", "repo", "webhook", "human", "service"]),
  scope: ScopeString,
  label: z.string().min(1),
  role: z.string().nullish(),
  meta: z.record(z.string(), z.unknown()).optional(),
  id: z.string().nullish(),
});

const ModeBody = z.object({
  scope: ScopeString,
  mode: z.enum(["global", "isolated"]),
});

export interface V1Deps {
  db: Db;
  config: Config;
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Rejection({
      reason: "malformed_request",
      message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      detail: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

export async function sendRejection(
  deps: V1Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
  ctx: { actor: string | null; scope?: string; subject?: string; predicate?: string },
): Promise<void> {
  const rejection = asRejection(err);
  if (!rejection) {
    request.log.error({ err }, "unhandled error");
    await reply.code(500).send({ ok: false, reason: "internal", message: "Unexpected error." });
    return;
  }
  // Every refusal is recorded, because "what did the store refuse and why" is a product
  // surface, not a debug log.
  if (request.method !== "GET") {
    await logRejection(deps.db, {
      actor: ctx.actor,
      route: `${request.method} ${request.url.split("?")[0]}`,
      rejection,
      scope: ctx.scope ?? null,
      subject: ctx.subject ?? null,
      predicate: ctx.predicate ?? null,
    });
  }
  await reply.code(rejection.http).send(rejection.toBody());
}

export function registerV1(app: FastifyInstance, deps: V1Deps): void {
  const { db, config } = deps;

  const auth = async (
    request: FastifyRequest,
    permission: "read" | "assert" | "supersede" | "admin",
    scope?: string,
  ): Promise<AuthedKey> => {
    const key = await authenticateKey(db, request.headers.authorization);
    requirePermission(key, permission);
    if (scope) requireScope(key, scope);
    return key;
  };

  app.post("/v1/assert", async (request, reply) => {
    let actor: string | null = null;
    let body: z.output<typeof AssertBody> | null = null;
    try {
      body = parse(AssertBody, request.body);
      const key = await auth(request, "assert", body.scope);
      actor = key.label;
      const result = await assertFact(
        db,
        {
          ...body,
          asserted_by: body.asserted_by ?? `key:${key.label}`,
          causality: body.causality ?? newId("evt"),
        },
        { role: "app" },
      );
      return reply.code(result.created ? 201 : 200).send({
        ok: true,
        created: result.created,
        assertion: result.assertion,
        // Say it plainly rather than letting a caller assume it got what it wanted.
        note:
          result.assertion.confidence === "unverified"
            ? "landed as unverified. the verification worker promotes it to measured once evidence.commit resolves and is contained where claimed."
            : undefined,
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, {
        actor,
        scope: body?.scope,
        subject: body?.subject,
        predicate: body?.predicate,
      });
    }
  });

  app.post("/v1/supersede", async (request, reply) => {
    let actor: string | null = null;
    let body: z.output<typeof SupersedeBody> | null = null;
    try {
      body = parse(SupersedeBody, request.body);
      const key = await auth(request, "supersede", body.scope);
      actor = key.label;
      const result = await assertFact(
        db,
        {
          ...body,
          asserted_by: body.asserted_by ?? `key:${key.label}`,
          causality: body.causality ?? newId("evt"),
        },
        { role: "app" },
      );
      return reply.code(result.created ? 201 : 200).send({
        ok: true,
        created: result.created,
        assertion: result.assertion,
        superseded: body.supersedes,
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, {
        actor,
        scope: body?.scope,
        subject: body?.subject,
        predicate: body?.predicate,
      });
    }
  });

  const AskQuery = z.object({
    scope: ScopeString,
    subject: z.string().optional(),
    predicate: z.string().optional(),
    kind: z.enum(KINDS).optional(),
    q: z.string().optional(),
    as_of: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });

  app.get("/v1/ask", async (request, reply) => {
    try {
      const query = parse(AskQuery, request.query);
      await auth(request, "read", query.scope);
      // Exact-first: the structured filter is an index seek. Full text is second, and only
      // when asked for. Embeddings are third and not in v0 — and would never be returned as
      // a fact regardless.
      if (query.q) {
        const rows = await search(db, query.scope, query.q, query.limit ?? 25);
        return reply.send({ ok: true, matched_by: "full-text", assertions: rows });
      }
      const result = await take(db, {
        scope: query.scope,
        subject: query.subject ?? null,
        predicate: query.predicate ?? null,
        kind: query.kind ?? null,
        asOf: query.as_of ?? null,
        limit: query.limit ?? 50,
      });
      return reply.send({ ok: true, matched_by: "exact", ...result });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.get("/v1/why/:id", async (request, reply) => {
    try {
      const params = parse(z.object({ id: z.string().min(1) }), request.params);
      const row = await byId(db, params.id);
      if (!row) throw new Rejection({ reason: "not_found", message: `no assertion ${params.id}` });
      await auth(request, "read", row.scope);
      const [chain, conflicts] = await Promise.all([
        lineage(db, params.id),
        db.query<{ id: string; a_id: string; b_id: string; status: string }>(
          "app",
          `SELECT id, a_id, b_id, status FROM datum.contradictions
            WHERE a_id = $1 OR b_id = $1 ORDER BY detected_at DESC`,
          [params.id],
        ),
      ]);
      const verification = row.verification_id
        ? await db.one(
            "app",
            `SELECT id, outcome, checker, checked_at, detail FROM datum.verifications WHERE id = $1`,
            [row.verification_id],
          )
        : null;
      return reply.send({
        ok: true,
        assertion: row,
        evidence: row.evidence,
        verification,
        lineage: chain,
        contradictions: conflicts.rows,
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.get("/v1/state", async (request, reply) => {
    try {
      const query = parse(z.object({ scope: ScopeString }), request.query);
      await auth(request, "read", query.scope);
      const [{ chain, mode, modeScope }, sequence, missionRows, open] = await Promise.all([
        resolveChain(db, query.scope),
        currentSequence(db),
        missions(db, query.scope),
        contradictions(db, { status: "open", limit: 500 }),
      ]);
      const counts = await db.query<{ confidence: string; n: string }>(
        "app",
        `SELECT confidence, count(*)::text AS n FROM datum.assertions
          WHERE superseded_by IS NULL AND scope = ANY($1::text[])
          GROUP BY confidence`,
        [chain],
      );
      const binding = await db.one<{ n: string }>(
        "app",
        `SELECT count(*)::text AS n FROM datum.assertions
          WHERE superseded_by IS NULL AND binding AND scope = ANY($1::text[])`,
        [chain],
      );
      const byConfidence: Record<string, number> = {};
      for (const c of counts.rows) byConfidence[c.confidence] = Number(c.n);
      return reply.send({
        ok: true,
        org: config.org,
        scope: query.scope,
        mode,
        mode_declared_at: modeScope,
        chain,
        sequence,
        live_by_confidence: byConfidence,
        live_total: Object.values(byConfidence).reduce((a, b) => a + b, 0),
        binding_rules: Number(binding?.n ?? 0),
        open_contradictions: open.length,
        missions: missionRows,
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.get("/v1/missions", async (request, reply) => {
    try {
      const query = parse(z.object({ scope: ScopeString }), request.query);
      await auth(request, "read", query.scope);
      return reply.send({ ok: true, missions: await missions(db, query.scope) });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.post("/v1/missions", async (request, reply) => {
    let body: z.output<typeof MissionBody> | null = null;
    try {
      body = parse(MissionBody, request.body);
      const key = await auth(request, "assert", body.scope);
      const mission = await createMission(db, {
        ...body,
        supersedes: body.supersedes ?? null,
        asserted_by: `key:${key.label}`,
      });
      return reply.code(201).send({ ok: true, mission });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null, scope: body?.scope });
    }
  });

  app.get("/v1/nodes", async (request, reply) => {
    try {
      const query = parse(
        z.object({ scope: ScopeString.optional(), kind: z.string().optional() }),
        request.query,
      );
      const key = await authenticateKey(db, request.headers.authorization);
      requirePermission(key, "read");
      const scope = query.scope ?? key.scope;
      requireScope(key, scope);
      const { rows } = await db.query(
        "app",
        `SELECT * FROM datum.nodes
          WHERE retired_at IS NULL
            AND (scope = $1 OR scope LIKE $1 || '/%')
            AND ($2::text IS NULL OR kind = $2)
          ORDER BY last_seen DESC NULLS LAST, created_at DESC`,
        [scope, query.kind ?? null],
      );
      return reply.send({ ok: true, nodes: rows });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.post("/v1/nodes", async (request, reply) => {
    let body: z.output<typeof NodeBody> | null = null;
    try {
      body = parse(NodeBody, request.body);
      await auth(request, "assert", body.scope);
      const id = body.id ?? newId("n");
      // Registering a node in a scope is how a scope comes into existence: `datum link` creates
      // proj/<name> by registering the repo, rather than needing a separate route for it.
      await db.query(
        "app",
        `INSERT INTO datum.scopes (path, kind, label, created_by)
         VALUES ($1, $2, $3, 'node registration')
         ON CONFLICT (path) DO NOTHING`,
        [
          body.scope,
          body.scope.includes("/proj/") && body.scope.split("/").length === 4 ? "proj" : "custom",
          body.label,
        ],
      );
      const { rows } = await db.query(
        "app",
        `INSERT INTO datum.nodes (id, kind, scope, label, role, meta, heartbeat_at, last_seen)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb, now(), now())
         -- Registration is a heartbeat: the same worktree re-announcing itself updates its
         -- liveness rather than creating a second row.
         ON CONFLICT (kind, scope, label) WHERE retired_at IS NULL DO UPDATE
            SET heartbeat_at = now(), last_seen = now(),
                role = excluded.role, meta = excluded.meta
         RETURNING *`,
        [id, body.kind, body.scope, body.label, body.role ?? null, JSON.stringify(body.meta ?? {})],
      );
      return reply.code(201).send({ ok: true, node: rows[0] });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null, scope: body?.scope });
    }
  });

  /**
   * Flipping global/isolated writes an assertion rather than setting a flag, which buys three
   * things: "when did this project start reading global facts?" becomes a query, an as-of read
   * reconstructs what the project could see at that time, and nothing is rewritten on flip back.
   */
  app.post("/v1/mode", async (request, reply) => {
    let body: z.output<typeof ModeBody> | null = null;
    try {
      body = parse(ModeBody, request.body);
      const key = await auth(request, "assert", body.scope);
      const current = await db.one<{ id: string }>(
        "app",
        `SELECT id FROM datum.assertions
          WHERE superseded_by IS NULL AND scope = $1 AND subject = $2 AND predicate = $3
          ORDER BY asserted_at DESC LIMIT 1`,
        [body.scope, KNOWLEDGE_MODE_SUBJECT, KNOWLEDGE_MODE_PREDICATE],
      );
      const result = await assertFact(
        db,
        {
          scope: body.scope,
          subject: KNOWLEDGE_MODE_SUBJECT,
          predicate: KNOWLEDGE_MODE_PREDICATE,
          object: { value: body.mode },
          claim: `knowledge mode for ${body.scope} is ${body.mode}`,
          kind: "state",
          evidence: { source: `POST /v1/mode by key:${key.label}` },
          asserted_by: `key:${key.label}`,
          supersedes: current?.id ?? null,
        },
        { role: "app" },
      );
      const resolved = await resolveChain(db, body.scope);
      return reply.code(201).send({ ok: true, assertion: result.assertion, ...resolved });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null, scope: body?.scope });
    }
  });

  app.get("/v1/contradictions", async (request, reply) => {
    try {
      const query = parse(
        z.object({ status: z.string().optional(), limit: z.coerce.number().optional() }),
        request.query,
      );
      await auth(request, "read");
      const rows = await contradictions(db, {
        status: query.status === "all" ? undefined : (query.status ?? "open"),
        limit: query.limit ?? 100,
      });
      const expanded = await Promise.all(
        rows.map(async (c) => ({
          ...c,
          a: await byId(db, c.a_id),
          b: await byId(db, c.b_id),
        })),
      );
      return reply.send({ ok: true, contradictions: expanded });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });
}

export type { AssertionRow };
