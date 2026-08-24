import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool.js";
import type { Config } from "../config.js";
import { Rejection } from "../domain/errors.js";
import { newId } from "../domain/identity.js";
import { assertFact } from "../domain/store.js";
import type { AssertionRow } from "../domain/types.js";
import { authenticateKey, requirePermission, requireScope } from "../http/auth.js";
import { sendRejection } from "../http/v1.js";
import { PROPOSAL_STATUSES, type ProposalStatus } from "./extract.js";

/**
 * The review queue's HTTP surface.
 *
 * Proposals get their own routes and appear on none of the others. That separation is the
 * quarantine: `/v1/ask`, `/v1/state` and every MCP tool query `datum.assertions` and have no join
 * to `datum.proposals`, so there is no filter anyone can forget to apply. A caller who wants
 * candidates has to ask for candidates by name.
 *
 * Promotion is an ordinary assert whose evidence is the extractor's citation. That is the
 * substance of the design rather than a detail of it: review means *"confirm this file:line"*,
 * which a human can do in seconds and be right about, instead of *"trust this extractor"*, which
 * nobody can do at all. The proposal's own `extractor_confidence` is not carried across — the
 * assertion earns its confidence through the same triggers as every other write.
 */

const ScopeString = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/, "scope must be slash-separated labels");

const ListQuery = z.object({
  status: z.enum(PROPOSAL_STATUSES).optional(),
  scope: ScopeString.optional(),
  extractor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const PromoteBody = z
  .object({
    /**
     * The named human vouching for the citation. Supplying one is what makes the assertion
     * `confirmed-by-human`; without it the promotion lands `unverified`, because
     * "confirmed-by-human" means a specific person and the database enforces that.
     */
    human: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict()
  .default({});

const RejectBody = z
  .object({
    /**
     * Required, and not as ceremony. A rejected proposal with no reason teaches the next
     * reviewer nothing and teaches whoever tunes the extractor less than nothing, so the queue
     * would fill with the same bad pattern forever.
     */
    reason: z.string().min(1),
  })
  .strict();

const IdParam = z.object({ id: z.string().min(1) });

export interface ProposalRow {
  id: string;
  scope: string;
  subject: string;
  predicate: string;
  object: unknown;
  claim: string | null;
  kind: string;
  citation: { source?: string } & Record<string, unknown>;
  extractor: string;
  extractor_confidence: string | null;
  status: ProposalStatus;
  promoted_to: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

const COLUMNS = `id, scope, subject, predicate, object, claim, kind, citation, extractor,
  extractor_confidence, status, promoted_to, reviewed_by, reviewed_at, review_note, created_at`;

export interface ProposalRoutesDeps {
  db: Db;
  config: Config;
}

export function registerProposalRoutes(app: FastifyInstance, deps: ProposalRoutesDeps): void {
  const { db } = deps;

  const auth = async (
    request: Parameters<Parameters<FastifyInstance["get"]>[1]>[0],
    permission: "read" | "assert",
  ) => {
    // Authenticate before validating, for the same reason `src/http/v1.ts` does: parsing first
    // lets an anonymous caller map the request schema by reading 400s off an endpoint they have
    // no right to touch at all.
    const key = await authenticateKey(db, request.headers.authorization);
    requirePermission(key, permission);
    return key;
  };

  app.get("/v1/proposals", async (request, reply) => {
    try {
      const key = await auth(request, "read");
      const query = ListQuery.safeParse(request.query);
      if (!query.success) {
        throw new Rejection({
          reason: "malformed_request",
          message: query.error.issues
            .map((i) => `${i.path.join(".") || "query"}: ${i.message}`)
            .join("; "),
          detail: { issues: query.error.issues },
        });
      }
      const filter = query.data;
      if (filter.scope) requireScope(key, filter.scope);
      // Absent an explicit scope the listing is bounded by the key's own subtree rather than
      // widened to everything: a scope-bound token is one of the few published mitigations that
      // actually works against memory injection, and a review queue is exactly the surface an
      // injected claim wants to reach.
      const subtree = filter.scope ?? key.scope;
      const rows = await db.query<ProposalRow>(
        "app",
        `SELECT ${COLUMNS} FROM datum.proposals
          WHERE (scope = $1 OR scope LIKE $1 || '/%')
            AND ($2::text IS NULL OR status = $2)
            AND ($3::text IS NULL OR extractor = $3)
          ORDER BY created_at DESC, id DESC
          LIMIT $4`,
        [subtree, filter.status ?? null, filter.extractor ?? null, filter.limit ?? 100],
      );
      return reply.send({
        ok: true,
        // Named so no caller can mistake this array for the record. A proposal has no
        // confidence class, so it can never satisfy a mission gate.
        proposals: rows.rows,
        note: "candidates awaiting review. not assertions, not reachable from /v1/ask or /mcp.",
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.post("/v1/proposals/:id/promote", async (request, reply) => {
    let actor: string | null = null;
    let row: ProposalRow | null = null;
    try {
      // Promotion writes an assertion, so it takes the permission that writes assertions. There
      // is no separate "review" grant, because a reviewer who could promote without being allowed
      // to assert would be a hole in the scope model.
      const key = await auth(request, "assert");
      actor = key.label;
      const params = IdParam.parse(request.params);
      const body = PromoteBody.parse(request.body ?? {});

      row = await db.one<ProposalRow>(
        "app",
        `SELECT ${COLUMNS} FROM datum.proposals WHERE id = $1`,
        [params.id],
      );
      if (!row) {
        throw new Rejection({ reason: "not_found", message: `no proposal ${params.id}` });
      }
      requireScope(key, row.scope);
      if (row.status !== "pending") {
        throw new Rejection({
          reason: "malformed_request",
          message: `proposal ${row.id} is ${row.status}, not pending`,
          detail: { status: row.status, promoted_to: row.promoted_to },
        });
      }

      const citation = row.citation;
      if (typeof citation.source !== "string" || citation.source.trim().length === 0) {
        throw new Rejection({
          reason: "evidence_required",
          message: "proposal citation has no source; nothing to confirm",
        });
      }

      const proposal = row;
      const promoted = await db.tx("app", async (client) => {
        const { assertion, created } = await assertFact(
          db,
          {
            scope: proposal.scope,
            subject: proposal.subject,
            predicate: proposal.predicate,
            object: proposal.object,
            claim: proposal.claim ?? undefined,
            kind: proposal.kind as AssertionRow["kind"],
            // The citation *is* the evidence. Nothing is synthesised here, and the extractor's
            // self-assessment is deliberately left behind: it earned nothing.
            evidence: body.human ? { ...citation, human: body.human } : { ...citation },
            confidence: body.human ? "confirmed-by-human" : "unverified",
            asserted_by: `key:${key.label}`,
            causality: newId("evt"),
            why: `promoted from proposal ${proposal.id}`,
          },
          { client },
        );

        if (!created) {
          // `assertFact` recognised the content hash. It did so on a separate connection after
          // the INSERT inside this transaction raised a unique violation, which leaves our
          // transaction aborted, so rewind before the UPDATE. The outcome is the right one: an
          // identical fact is already on record and this proposal points at it.
          await client.query("ROLLBACK TO SAVEPOINT before_assert");
        }

        // `AND status = 'pending'` is what makes double-promotion impossible even if two
        // reviewers click at once: the second UPDATE matches nothing and the transaction that
        // lost is the one that rolls back.
        const updated = await client.query(
          `UPDATE datum.proposals
              SET status = 'accepted', promoted_to = $2, reviewed_by = $3,
                  reviewed_at = now(), review_note = $4
            WHERE id = $1 AND status = 'pending'`,
          [proposal.id, assertion.id, `key:${key.label}`, body.note ?? null],
        );
        if (updated.rowCount === 0) {
          throw new Rejection({
            reason: "malformed_request",
            message: `proposal ${proposal.id} was reviewed concurrently`,
          });
        }
        return assertion;
      });

      return reply.code(201).send({
        ok: true,
        proposal: proposal.id,
        assertion: promoted,
        note:
          promoted.confidence === "unverified"
            ? "landed as unverified. name a human to record this as confirmed-by-human."
            : undefined,
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, {
        actor,
        scope: row?.scope,
        subject: row?.subject,
        predicate: row?.predicate,
      });
    }
  });

  app.post("/v1/proposals/:id/reject", async (request, reply) => {
    let actor: string | null = null;
    let row: ProposalRow | null = null;
    try {
      const key = await auth(request, "assert");
      actor = key.label;
      const params = IdParam.parse(request.params);
      const body = RejectBody.parse(request.body ?? {});

      row = await db.one<ProposalRow>(
        "app",
        `SELECT ${COLUMNS} FROM datum.proposals WHERE id = $1`,
        [params.id],
      );
      if (!row) {
        throw new Rejection({ reason: "not_found", message: `no proposal ${params.id}` });
      }
      requireScope(key, row.scope);

      const updated = await db.query(
        "app",
        `UPDATE datum.proposals
            SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3
          WHERE id = $1 AND status = 'pending'`,
        [row.id, `key:${key.label}`, body.reason],
      );
      if (updated.rowCount === 0) {
        throw new Rejection({
          reason: "malformed_request",
          message: `proposal ${row.id} is ${row.status}, not pending`,
          detail: { status: row.status },
        });
      }
      return reply.send({ ok: true, proposal: row.id, status: "rejected", reason: body.reason });
    } catch (err) {
      return sendRejection(deps, request, reply, err, {
        actor,
        scope: row?.scope,
        subject: row?.subject,
        predicate: row?.predicate,
      });
    }
  });
}
