import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { asRejection, Rejection } from "../domain/errors.js";
import { byId, contradictions, currentSequence, lineage, missions, take } from "../domain/store.js";
import { PERMISSIONS } from "./auth.js";
import {
  SESSION_COOKIE,
  checkPassword,
  loginAttemptsRemaining,
  mintKey,
  recordFailedLogin,
  signSession,
  verifySession,
} from "./auth.js";

/**
 * The admin panel's backend. §13 items 1–7.
 *
 * The panel is the only way a human sees the store, so it carries the load Linear and Discord
 * will carry later. Two screens are load-bearing rather than decorative: the contradiction queue,
 * and the log of refused writes — the second because it is the only screen that shows a sceptic
 * the invariants biting in real time.
 */

export interface AdminDeps {
  db: Db;
  config: Config;
  adminHash: string;
  verification: { configured: boolean; method: "local-mirror" | "github-api" | "none" };
}

const ScopeString = z.string().regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/);

function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return request.ip;
}

export function registerAdmin(app: FastifyInstance, deps: AdminDeps): void {
  const { db, config } = deps;

  const guard = (request: FastifyRequest): void => {
    if (!verifySession(config, request.cookies[SESSION_COOKIE])) {
      throw new Rejection({ reason: "unauthorized", message: "Sign in to /admin." });
    }
  };

  const fail = async (reply: FastifyReply, err: unknown): Promise<FastifyReply> => {
    const rejection = asRejection(err);
    if (!rejection) {
      app.log.error({ err }, "admin route failed");
      return reply.code(500).send({ ok: false, reason: "internal", message: "Unexpected error." });
    }
    return reply.code(rejection.http).send(rejection.toBody());
  };

  app.post("/admin/api/login", async (request, reply) => {
    const parsed = z.object({ password: z.string().min(1) }).safeParse(request.body);
    const ip = clientIp(request);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, reason: "malformed_request", message: "password required" });
    }
    const { remaining, retryAfterSeconds } = await loginAttemptsRemaining(db, config, ip);
    if (remaining <= 0) {
      return reply.code(429).send({
        ok: false,
        reason: "unauthorized",
        message: `Too many failed attempts. Try again in ${retryAfterSeconds}s.`,
        detail: { retry_after_seconds: retryAfterSeconds },
      });
    }
    if (!(await checkPassword(deps.adminHash, parsed.data.password))) {
      // Every failure is an assertion in the store: the panel dogfoods the product.
      await recordFailedLogin(db, config, ip);
      return reply.code(401).send({
        ok: false,
        reason: "unauthorized",
        message: "Wrong password.",
        detail: { attempts_remaining: remaining - 1 },
      });
    }
    const expires = Date.now() + config.sessionTtlSeconds * 1000;
    return reply
      .setCookie(SESSION_COOKIE, signSession(config, expires), {
        httpOnly: true,
        secure: config.publicUrl.startsWith("https://"),
        sameSite: "strict",
        path: "/",
        maxAge: config.sessionTtlSeconds,
      })
      .code(204)
      .send();
  });

  app.post("/admin/api/logout", async (_request, reply) =>
    reply.clearCookie(SESSION_COOKIE, { path: "/" }).code(204).send(),
  );

  app.get("/admin/api/me", async (request, reply) => {
    try {
      guard(request);
      const [seq, version] = await Promise.all([
        currentSequence(db),
        db.one<{ v: string }>("app", "SELECT current_setting('server_version') AS v"),
      ]);
      return reply.send({
        authenticated: true,
        org: config.org,
        scope_root: config.orgScope,
        postgres: version?.v ?? "unknown",
        sequence: seq,
        verification: deps.verification,
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---- API keys: the panel's reason to exist in v0 -------------------------------------
  app.get("/admin/api/keys", async (request, reply) => {
    try {
      guard(request);
      const { rows } = await db.query(
        "app",
        `SELECT id, prefix, label, scope, permissions, expires_at, created_by, created_at,
                last_used_at, use_count, revoked_at
           FROM datum.api_keys ORDER BY created_at DESC`,
      );
      return reply.send({ keys: rows });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/admin/api/keys", async (request, reply) => {
    try {
      guard(request);
      const body = z
        .object({
          label: z.string().min(1),
          scope: ScopeString,
          permissions: z.array(z.enum(PERMISSIONS)).min(1),
          expires_at: z.string().nullish(),
        })
        .parse(request.body);
      const minted = await mintKey(db, {
        label: body.label,
        scope: body.scope,
        permissions: body.permissions,
        expiresAt: body.expires_at ?? null,
        createdBy: "admin",
      });
      const key = await db.one(
        "app",
        `SELECT id, prefix, label, scope, permissions, expires_at, created_by, created_at,
                last_used_at, use_count, revoked_at FROM datum.api_keys WHERE id = $1`,
        [minted.id],
      );
      // Shown exactly once. It is not stored anywhere in recoverable form.
      return reply.code(201).send({ key, secret: minted.secret });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/admin/api/keys/:id/revoke", async (request, reply) => {
    try {
      guard(request);
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const res = await db.query(
        "app",
        `UPDATE datum.api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
        [id],
      );
      if (res.rowCount === 0) {
        throw new Rejection({ reason: "not_found", message: "No live key with that id." });
      }
      return reply.code(204).send();
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---- browse, with the scope tree so inheritance is legible ---------------------------
  app.get("/admin/api/scopes", async (request, reply) => {
    try {
      guard(request);
      const { rows } = await db.query(
        "app",
        `SELECT s.path, s.kind, s.depth, s.label,
                (SELECT count(*) FROM datum.assertions a
                  WHERE a.scope = s.path AND a.superseded_by IS NULL)::int AS assertions
           FROM datum.scopes s
          UNION
         SELECT DISTINCT a.scope AS path, 'custom' AS kind, a.scope_depth AS depth, NULL AS label,
                count(*) FILTER (WHERE a.superseded_by IS NULL)::int AS assertions
           FROM datum.assertions a
          WHERE NOT EXISTS (SELECT 1 FROM datum.scopes s2 WHERE s2.path = a.scope)
          GROUP BY a.scope, a.scope_depth
          ORDER BY path`,
      );
      return reply.send({ scopes: rows });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/admin/api/assertions", async (request, reply) => {
    try {
      guard(request);
      const q = z
        .object({
          scope: z.string().optional(),
          subject: z.string().optional(),
          predicate: z.string().optional(),
          kind: z.string().optional(),
          confidence: z.string().optional(),
          live: z.enum(["true", "false"]).optional(),
          q: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .parse(request.query);
      const limit = q.limit ?? 50;
      const offset = q.offset ?? 0;
      const params = [
        q.scope ?? null,
        q.subject ?? null,
        q.predicate ?? null,
        q.kind ?? null,
        q.confidence ?? null,
        q.live === "false" ? null : true,
        q.q && q.q.trim() !== "" ? q.q : null,
        limit,
        offset,
      ];
      const where = `
        WHERE ($1::text IS NULL OR a.scope = $1 OR a.scope LIKE $1 || '/%')
          AND ($2::text IS NULL OR a.subject   = $2)
          AND ($3::text IS NULL OR a.predicate = $3)
          AND ($4::text IS NULL OR a.kind      = $4)
          AND ($5::text IS NULL OR a.confidence = $5)
          AND ($6::boolean IS NULL OR a.superseded_by IS NULL)
          AND ($7::text IS NULL OR a.claim_fts @@ websearch_to_tsquery('english', $7))`;
      const [rows, total] = await Promise.all([
        db.query(
          "app",
          `SELECT a.id, a.hash, a.scope, a.scope_depth, a.subject, a.predicate, a.object, a.claim,
                  a.kind, a.binding, a.confidence, a.evidence, a.valid_from, a.valid_to,
                  a.asserted_at, a.asserted_by, a.supersedes, a.superseded_by, a.superseded_at,
                  a.why, a.reopen_if, a.causality, a.derived_from, a.verification_id, a.created_at,
                  EXISTS (SELECT 1 FROM datum.contradictions k
                           WHERE k.status='open' AND (k.a_id=a.id OR k.b_id=a.id)) AS contested
             FROM datum.assertions a ${where}
            ORDER BY a.asserted_at DESC LIMIT $8 OFFSET $9`,
          params,
        ),
        db.one<{ n: string }>(
          "app",
          `SELECT count(*)::text AS n FROM datum.assertions a ${where}`,
          params.slice(0, 7),
        ),
      ]);
      return reply.send({ rows: rows.rows, total: Number(total?.n ?? 0) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/admin/api/assertions/:id", async (request, reply) => {
    try {
      guard(request);
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const assertion = await byId(db, id);
      if (!assertion) throw new Rejection({ reason: "not_found", message: "No such assertion." });
      const [chain, conflicts, verification] = await Promise.all([
        lineage(db, id),
        db.query(
          "app",
          `SELECT * FROM datum.contradictions WHERE a_id=$1 OR b_id=$1 ORDER BY detected_at DESC`,
          [id],
        ),
        assertion.verification_id
          ? db.one(
              "app",
              `SELECT id, outcome, checker, checked_at, detail FROM datum.verifications WHERE id=$1`,
              [assertion.verification_id],
            )
          : Promise.resolve(null),
      ]);
      return reply.send({
        assertion,
        lineage: chain,
        contradictions: conflicts.rows,
        verification,
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // The as-of control: what did we believe at sequence N.
  app.get("/admin/api/take", async (request, reply) => {
    try {
      guard(request);
      const q = z
        .object({
          scope: ScopeString,
          subject: z.string().optional(),
          predicate: z.string().optional(),
          kind: z.string().optional(),
          as_of: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(request.query);
      const result = await take(db, {
        scope: q.scope,
        subject: q.subject ?? null,
        predicate: q.predicate ?? null,
        kind: q.kind ?? null,
        asOf: q.as_of ?? null,
        limit: q.limit ?? 100,
      });
      return reply.send(result);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---- the contradiction queue: if we ship one screen, this is it ----------------------
  app.get("/admin/api/contradictions", async (request, reply) => {
    try {
      guard(request);
      const q = z
        .object({ status: z.string().optional(), limit: z.coerce.number().optional() })
        .parse(request.query);
      const rows = await contradictions(db, {
        status: !q.status || q.status === "all" ? undefined : q.status,
        limit: q.limit ?? 200,
      });
      const expanded = await Promise.all(
        rows.map(async (c) => ({ ...c, a: await byId(db, c.a_id), b: await byId(db, c.b_id) })),
      );
      return reply.send({ contradictions: expanded });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/admin/api/contradictions/:id/resolve", async (request, reply) => {
    try {
      guard(request);
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const body = z
        .object({
          status: z.enum(["resolved", "unreproducible"]),
          resolution: z.string().min(1),
        })
        .parse(request.body);
      const res = await db.query(
        "app",
        `UPDATE datum.contradictions
            SET status = $2, resolution = $3, resolved_by = 'admin', resolved_at = now()
          WHERE id = $1 AND status = 'open'`,
        [id, body.status, body.resolution],
      );
      if (res.rowCount === 0) {
        throw new Rejection({ reason: "not_found", message: "No open contradiction with that id." });
      }
      return reply.code(204).send();
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/admin/api/missions", async (request, reply) => {
    try {
      guard(request);
      const q = z.object({ scope: ScopeString.optional() }).parse(request.query);
      // With a scope, resolve it the way an agent would: nearest-scope-wins up the chain.
      // Without one, the panel means "every mission in the store". Defaulting to the org root's
      // chain instead would render an empty screen on an instance whose missions all live in
      // scopes the root does not walk into — a panel that says "All scopes" and shows none is
      // worse than one that says nothing.
      if (q.scope) return reply.send({ missions: await missions(db, q.scope) });

      const scopes = await db.query<{ scope: string }>(
        "app",
        `SELECT DISTINCT scope FROM datum.missions WHERE superseded_by IS NULL ORDER BY scope`,
      );
      const all = [];
      for (const row of scopes.rows) all.push(...(await missions(db, row.scope)));
      // One mission can be reachable from several scopes in the chain; show each once.
      const seen = new Set<string>();
      return reply.send({
        missions: all.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true))),
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---- what the store refused, and why ------------------------------------------------
  app.get("/admin/api/rejections", async (request, reply) => {
    try {
      guard(request);
      const q = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }).parse(
        request.query,
      );
      const [rows, byReason] = await Promise.all([
        db.query("app", `SELECT * FROM datum.rejections ORDER BY at DESC LIMIT $1`, [q.limit ?? 100]),
        db.query<{ reason: string; n: string }>(
          "app",
          `SELECT reason, count(*)::text AS n FROM datum.rejections
            WHERE at > now() - interval '24 hours' GROUP BY reason ORDER BY 2 DESC`,
        ),
      ]);
      return reply.send({
        rejections: rows.rows,
        by_reason_24h: byReason.rows.map((r) => ({ reason: r.reason, count: Number(r.n) })),
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/admin/api/nodes", async (request, reply) => {
    try {
      guard(request);
      const { rows } = await db.query(
        "app",
        `SELECT * FROM datum.nodes ORDER BY last_seen DESC NULLS LAST, created_at DESC LIMIT 500`,
      );
      return reply.send({ nodes: rows });
    } catch (err) {
      return fail(reply, err);
    }
  });
}
