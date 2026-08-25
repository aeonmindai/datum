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
import { activePreferences } from "../preferences/index.js";
import { searchProse } from "../prose/index.js";
import { episodeStats, getSession, searchEpisodes } from "../episodes/read.js";
import { resumeState } from "../episodes/resume.js";
import { recallEpisodes } from "../episodes/recall.js";
import { whyPath, whySymbol } from "../episodes/why.js";
// Aliased: `report`, `claim` and `fleet` are ordinary words this file already uses for other
// things, and a collision here would be resolved silently by the bundler rather than loudly.
import {
  claim as fleetClaim,
  fleet as fleetView,
  release as fleetRelease,
  report as fleetReport,
} from "../fleet/index.js";

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
    // Order matters and it is a security property, not a style choice: authenticate BEFORE
    // validating input. Parsing first lets an anonymous caller probe the request schema by
    // reading 400s, and makes the same endpoint answer 400 to a stranger and 401 to a
    // half-configured client, which is exactly backwards.
    const key = await authenticateKey(db, request.headers.authorization);
    requirePermission(key, permission);
    if (scope) requireScope(key, scope);
    return key;
  };

  /**
   * The trust-graded tail of a read.
   *
   * Only consulted when the store came back empty and only when prose roots are configured, so a
   * deployment that wants the record and nothing else gets exactly that. Results are citations,
   * retrieved live and never persisted: this is the difference between "Datum knows this" and
   * "Datum found this written down somewhere", and collapsing the two would undo the reason the
   * store is trustworthy in the first place.
   */
  const proseFallback = async (
    probe: string,
    storeHits: number,
  ): Promise<{ from_prose?: unknown[]; from_prose_note?: string }> => {
    if (storeHits > 0 || config.proseRoots.length === 0 || probe.trim() === "") return {};
    const hits = await searchProse({
      roots: [...config.proseRoots],
      query: probe,
      limit: 5,
    }).catch(() => []);
    if (hits.length === 0) return {};
    return {
      from_prose: hits,
      from_prose_note:
        "not on datum. these are citations from prose, retrieved live and never stored. " +
        "they carry no confidence class and cannot satisfy a mission gate.",
    };
  };

  app.post("/v1/assert", async (request, reply) => {
    let actor: string | null = null;
    let body: z.output<typeof AssertBody> | null = null;
    try {
      const key = await auth(request, "assert");
      body = parse(AssertBody, request.body);
      requireScope(key, body.scope);
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
      const key = await auth(request, "supersede");
      body = parse(SupersedeBody, request.body);
      requireScope(key, body.scope);
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
      const key = await auth(request, "read");
      const query = parse(AskQuery, request.query);
      requireScope(key, query.scope);
      // Exact-first: the structured filter is an index seek. Full text is second, and only
      // when asked for. Embeddings are third and not in v0 — and would never be returned as
      // a fact regardless.
      if (query.q) {
        const rows = await search(db, query.scope, query.q, query.limit ?? 25);
        return reply.send({
          ok: true,
          matched_by: "full-text",
          assertions: rows,
          ...(await proseFallback(query.q, rows.length)),
        });
      }
      const result = await take(db, {
        scope: query.scope,
        subject: query.subject ?? null,
        predicate: query.predicate ?? null,
        kind: query.kind ?? null,
        asOf: query.as_of ?? null,
        limit: query.limit ?? 50,
      });
      // The store answered, or it did not. Either way what comes back below is kept in its own
      // key and is NEVER merged into `assertions` — nothing retrieved from prose is written to the
      // store, so the store cannot rot, the confidence taxonomy stays at four classes, and a
      // from_prose hit can no more satisfy a mission gate than testimony can.
      const probe = [query.subject, query.predicate].filter(Boolean).join(" ");
      return reply.send({
        ok: true,
        matched_by: "exact",
        ...result,
        ...(await proseFallback(probe, result.assertions.length)),
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.get("/v1/why/:id", async (request, reply) => {
    try {
      const key = await auth(request, "read");
      const params = parse(z.object({ id: z.string().min(1) }), request.params);
      const row = await byId(db, params.id);
      if (!row) throw new Rejection({ reason: "not_found", message: `no assertion ${params.id}` });
      requireScope(key, row.scope);
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
      const key = await auth(request, "read");
      const query = parse(z.object({ scope: ScopeString }), request.query);
      requireScope(key, query.scope);
      const [{ chain, mode, modeScope }, sequence, missionRows, open, prefs, resume] = await Promise.all([
        resolveChain(db, query.scope),
        currentSequence(db),
        missions(db, query.scope),
        contradictions(db, { status: "open", limit: 500 }),
        // Delivered without being asked for, and that is the entire mechanism. A preference an
        // agent has to know to request is a preference it will not request, and the repetition it
        // was learned from continues. `state` is what an agent reads before it starts work, so
        // this is where a learned correction has to appear if it is ever going to stop recurring.
        activePreferences(db, query.scope),
        // Same argument for where we left off. An agent that has to know to ask "was there a
        // previous session" will not ask, and will re-derive what it was already told.
        resumeState(db, { scope: query.scope }),
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
        preferences: prefs,
        resume,
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.get("/v1/missions", async (request, reply) => {
    try {
      const key = await auth(request, "read");
      const query = parse(z.object({ scope: ScopeString }), request.query);
      requireScope(key, query.scope);
      return reply.send({ ok: true, missions: await missions(db, query.scope) });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.post("/v1/missions", async (request, reply) => {
    let body: z.output<typeof MissionBody> | null = null;
    try {
      const key = await auth(request, "assert");
      body = parse(MissionBody, request.body);
      requireScope(key, body.scope);
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
      const key = await authenticateKey(db, request.headers.authorization);
      requirePermission(key, "read");
      const query = parse(
        z.object({ scope: ScopeString.optional(), kind: z.string().optional() }),
        request.query,
      );
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
      const key = await auth(request, "assert");
      body = parse(NodeBody, request.body);
      requireScope(key, body.scope);
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
      const key = await auth(request, "assert");
      body = parse(ModeBody, request.body);
      requireScope(key, body.scope);
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
      await auth(request, "read");
      const query = parse(
        z.object({ status: z.string().optional(), limit: z.coerce.number().optional() }),
        request.query,
      );
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

  // ---- episodes: what was said ---------------------------------------------------------------
  //
  // Separate routes from `/v1/ask` on purpose. `ask` answers "what is true" and refuses to guess;
  // these answer "what was said" and are allowed to, because the return value is a dated,
  // attributed quote rather than a number. Mixing them would put a fuzzy match behind an endpoint
  // whose whole contract is exactness.
  app.get("/v1/episodes", async (request, reply) => {
    try {
      const key = await auth(request, "read");
      const query = parse(
        z.object({
          scope: ScopeString.optional(),
          q: z.string().optional(),
          actor: z.string().optional(),
          role: z.enum(["human", "agent", "system"]).optional(),
          branch: z.string().optional(),
          session: z.string().optional(),
          since: z.string().optional(),
          until: z.string().optional(),
          limit: z.coerce.number().int().positive().max(500).optional(),
        }),
        request.query,
      );
      const scope = query.scope ?? key.scope;
      requireScope(key, scope);
      const hits = await searchEpisodes(db, {
        scope,
        ...(query.q === undefined ? {} : { text: query.q }),
        ...(query.actor === undefined ? {} : { actor: query.actor }),
        ...(query.role === undefined ? {} : { role: query.role }),
        ...(query.branch === undefined ? {} : { branch: query.branch }),
        ...(query.session === undefined ? {} : { session: query.session }),
        ...(query.since === undefined ? {} : { since: query.since }),
        ...(query.until === undefined ? {} : { until: query.until }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      // `matched` rides along on every hit. A caller that cannot tell an exact hit from a rescued
      // typo has been handed a guess dressed as a fact, which is the failure this store exists
      // to refuse - so the tier is part of the payload, not a debug detail.
      return reply.send({
        ok: true,
        episodes: hits.map((h) => ({ ...h.episode, matched: h.matched, rank: h.rank })),
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  // Separate from /v1/episodes on purpose. That route honours a query exactly, which is right for
  // a caller that knows the words it wants. This one takes a QUESTION, phrased the way people
  // phrase questions, and does the interpreting - including reading a date out of it, because a
  // measured 14 of 14 retrieval failures named a time the search was ignoring.
  app.get("/v1/recall", async (request, reply) => {
    try {
      const key = await auth(request, "read");
      const query = parse(
        z.object({
          scope: ScopeString.optional(),
          question: z.string().min(1),
          limit: z.coerce.number().int().positive().max(100).optional(),
        }),
        request.query,
      );
      const scope = query.scope ?? key.scope;
      requireScope(key, scope);
      const r = await recallEpisodes(db, {
        scope,
        question: query.question,
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      return reply.send({
        ok: true,
        note: r.note,
        plan: r.plan,
        episodes: r.hits.map((h) => ({
          ...h.episode,
          tier: h.tier,
          score: h.score,
          matched_terms: h.matched_terms,
        })),
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.get("/v1/episodes/:session", async (request, reply) => {
    try {
      await auth(request, "read");
      const params = parse(z.object({ session: z.string().min(1) }), request.params);
      const query = parse(
        z.object({
          around: z.coerce.number().int().min(0).optional(),
          limit: z.coerce.number().int().positive().max(500).optional(),
        }),
        request.query,
      );
      const rows = await getSession(db, params.session, {
        ...(query.around === undefined ? {} : { around: query.around }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      return reply.send({ ok: true, session: params.session, episodes: rows });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.get("/v1/episodes-stats", async (request, reply) => {
    try {
      const key = await auth(request, "read");
      const query = parse(z.object({ scope: ScopeString.optional() }), request.query);
      const scope = query.scope ?? key.scope;
      requireScope(key, scope);
      return reply.send({ ok: true, stats: await episodeStats(db, scope) });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  // ---- why is this code like this ------------------------------------------------------------
  app.get("/v1/why-code", async (request, reply) => {
    try {
      const key = await auth(request, "read");
      const query = parse(
        z.object({
          scope: ScopeString.optional(),
          symbol: z.string().optional(),
          path: z.string().optional(),
          repo: z.string().optional(),
          limit: z.coerce.number().int().positive().max(200).optional(),
        }),
        request.query,
      );
      if (!query.symbol && !query.path) {
        throw new Rejection({
          reason: "malformed_request",
          message: "name a `symbol` or a `path` to ask about",
        });
      }
      const scope = query.scope ?? key.scope;
      requireScope(key, scope);
      const result = query.symbol
        ? await whySymbol(db, {
            scope,
            symbol: query.symbol,
            ...(query.repo === undefined ? {} : { repo: query.repo }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
          })
        : await whyPath(db, {
            scope,
            path: query.path as string,
            ...(query.limit === undefined ? {} : { limit: query.limit }),
          });
      return reply.send({ ok: true, why: result });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  // ---- where were we ------------------------------------------------------------------------
  app.get("/v1/resume", async (request, reply) => {
    try {
      const key = await auth(request, "read");
      const query = parse(
        z.object({
          scope: ScopeString.optional(),
          session: z.string().optional(),
          limit: z.coerce.number().int().positive().max(100).optional(),
          staleHours: z.coerce.number().nonnegative().optional(),
        }),
        request.query,
      );
      const scope = query.scope ?? key.scope;
      requireScope(key, scope);
      const state = await resumeState(db, {
        scope,
        ...(query.session === undefined ? {} : { session: query.session }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.staleHours === undefined ? {} : { staleHours: query.staleHours }),
      });
      return reply.send({ ok: true, resume: state });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  // ---- the fleet ----------------------------------------------------------------------------
  app.get("/v1/fleet", async (request, reply) => {
    try {
      const key = await auth(request, "read");
      const query = parse(
        z.object({
          scope: ScopeString.optional(),
          stale: z.coerce.number().int().positive().optional(),
          includeStale: z.coerce.boolean().optional(),
        }),
        request.query,
      );
      const scope = query.scope ?? key.scope;
      requireScope(key, scope);
      const members = await fleetView(db, {
        scope,
        ...(query.stale === undefined ? {} : { staleSeconds: query.stale }),
        ...(query.includeStale === undefined ? {} : { includeStale: query.includeStale }),
      });
      // A node that has never beaten reports Infinity, which JSON renders as null. Send a number
      // so a client comparing ages does not have to special-case the absence of one.
      return reply.send({
        ok: true,
        fleet: members.map((m) => ({
          ...m,
          seconds_ago: Number.isFinite(m.seconds_ago) ? m.seconds_ago : -1,
        })),
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.post("/v1/nodes/:id/activity", async (request, reply) => {
    try {
      const key = await auth(request, "assert");
      const params = parse(z.object({ id: z.string().min(1) }), request.params);
      const body = parse(
        z.object({
          scope: ScopeString.optional(),
          statement: z.string().min(1),
          mission_id: z.string().nullish(),
        }),
        request.body,
      );
      const scope = body.scope ?? key.scope;
      requireScope(key, scope);
      const out = await fleetReport(db, {
        node_id: params.id,
        scope,
        statement: body.statement,
        ...(body.mission_id === undefined ? {} : { mission_id: body.mission_id }),
      });
      return reply.code(201).send({ ok: true, ...out });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.post("/v1/nodes/:id/claims", async (request, reply) => {
    try {
      const key = await auth(request, "assert");
      const params = parse(z.object({ id: z.string().min(1) }), request.params);
      const body = parse(
        z.object({
          scope: ScopeString.optional(),
          paths: z.array(z.string().min(1)).min(1),
          intent: z.string().nullish(),
        }),
        request.body,
      );
      const scope = body.scope ?? key.scope;
      requireScope(key, scope);
      const out = await fleetClaim(db, {
        node_id: params.id,
        scope,
        paths: body.paths,
        ...(body.intent === undefined ? {} : { intent: body.intent }),
      });
      // 200 rather than 201: a claim is advisory and re-claiming is a no-op, so "created" is the
      // wrong idea. The interesting part of the response is who else is already here.
      return reply.send({ ok: true, ...out });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.delete("/v1/nodes/:id/claims", async (request, reply) => {
    try {
      await auth(request, "assert");
      const params = parse(z.object({ id: z.string().min(1) }), request.params);
      const body = parse(
        z.object({ paths: z.array(z.string().min(1)).optional() }),
        request.body ?? {},
      );
      const out = await fleetRelease(db, {
        node_id: params.id,
        ...(body.paths === undefined ? {} : { paths: body.paths }),
      });
      return reply.send({ ok: true, ...out });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });
}

export type { AssertionRow };
