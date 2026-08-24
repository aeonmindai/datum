import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool.js";
import type { Config } from "../config.js";
import { isDuplicateHash, Rejection } from "../domain/errors.js";
import { newId } from "../domain/identity.js";
import { assertFact } from "../domain/store.js";
import { KINDS, type AssertionRow, type Evidence } from "../domain/types.js";
import { authenticateKey, requirePermission, requireScope } from "../http/auth.js";
import { sendRejection } from "../http/v1.js";
import { PROPOSAL_STATUSES, type ProposalStatus } from "./extract.js";

/**
 * The review queue's HTTP surface.
 *
 * Proposals get their own routes and appear on none of the others. That separation *is* the
 * quarantine: `/v1/ask`, `/v1/state` and every MCP tool query `datum.assertions` and have no join
 * to `datum.proposals`, so there is no filter anyone can forget to apply. A caller who wants
 * candidates has to ask for candidates by name, and what they get back says so.
 *
 * Promotion is an ordinary assert whose evidence is the extractor's citation. That is the
 * substance of the design rather than a detail of it: review means *"confirm this file:line"*,
 * which a human can do in seconds and be right about, instead of *"trust this extractor"*, which
 * nobody can do at all. The proposal's own `extractor_confidence` is deliberately not carried
 * across — the assertion earns its class through the same triggers as every other write.
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
     * `confirmed-by-human` means a specific person and `human_evidence_names_a_human` enforces
     * that in the database regardless of what this route would prefer.
     */
    human: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .default({});

const RejectBody = z.object({
  /**
   * Required, and not as ceremony. A rejected proposal with no reason teaches the next reviewer
   * nothing and teaches whoever tunes the extractor less than nothing, so the queue refills with
   * the same bad pattern forever.
   */
  reason: z.string().min(1),
});

const IdParam = z.object({ id: z.string().min(1) });

export interface ProposalRow {
  id: string;
  scope: string;
  subject: string;
  predicate: string;
  object: unknown;
  claim: string | null;
  kind: string;
  citation: Record<string, unknown>;
  extractor: string;
  /** `numeric` arrives as a string from pg; it is a review hint, never arithmetic. */
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

/** Zod issues become a named rejection, so a bad request reads like every other refusal. */
function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Rejection({
      reason: "malformed_request",
      message: parsed.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; "),
      detail: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

export function registerProposalRoutes(app: FastifyInstance, deps: ProposalRoutesDeps): void {
  const { db } = deps;

  const auth = async (request: FastifyRequest, permission: "read" | "assert") => {
    // Authenticate before validating, for the same reason `src/http/v1.ts` does: parsing first
    // lets an anonymous caller map the request schema by reading 400s off an endpoint they have
    // no right to touch at all.
    const key = await authenticateKey(db, request.headers.authorization);
    requirePermission(key, permission);
    return key;
  };

  const load = async (id: string): Promise<ProposalRow> => {
    const row = await db.one<ProposalRow>(
      "app",
      `SELECT ${COLUMNS} FROM datum.proposals WHERE id = $1`,
      [id],
    );
    if (!row) throw new Rejection({ reason: "not_found", message: `no proposal ${id}` });
    return row;
  };

  app.get("/v1/proposals", async (request, reply) => {
    try {
      const key = await auth(request, "read");
      const filter = parse(ListQuery, request.query);
      if (filter.scope) requireScope(key, filter.scope);
      // Absent an explicit scope the listing is bounded by the key's own subtree rather than
      // widened to everything. A scope-bound token is one of the few published mitigations that
      // actually works against memory injection, and a review queue is precisely the surface an
      // injected claim wants to reach — it is the one place a human is primed to say yes.
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
        // Named `proposals`, never `assertions`, so no caller can mistake this array for the
        // record. A proposal carries no confidence class, so it can never satisfy a gate.
        proposals: rows.rows,
        note: "candidates awaiting review. not assertions, not reachable from /v1/ask or /mcp.",
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.post("/v1/proposals/:id/promote", async (request, reply) => {
    let actor: string | null = null;
    let proposal: ProposalRow | null = null;
    try {
      // Promotion writes an assertion, so it takes the permission that writes assertions. There
      // is no separate "review" grant: a reviewer who could promote without being allowed to
      // assert would be a hole straight through the scope model.
      const key = await auth(request, "assert");
      actor = key.label;
      const params = parse(IdParam, request.params);
      const body = parse(PromoteBody, request.body ?? {});

      proposal = await load(params.id);
      requireScope(key, proposal.scope);
      if (proposal.status !== "pending") {
        throw new Rejection({
          reason: "malformed_request",
          message: `proposal ${proposal.id} is ${proposal.status}, not pending`,
          detail: { status: proposal.status, promoted_to: proposal.promoted_to },
        });
      }

      const source = proposal.citation["source"];
      if (typeof source !== "string" || source.trim().length === 0) {
        throw new Rejection({
          reason: "evidence_required",
          message: "proposal citation names no source; there is nothing for a reviewer to confirm",
        });
      }
      // `jsonb` can hold a scalar or an array; an assertion's object cannot. Parsing rather than
      // asserting keeps a hand-written row from reaching `assertFact` with the wrong shape.
      const object = z.record(z.string(), z.unknown()).safeParse(proposal.object);
      if (!object.success) {
        throw new Rejection({
          reason: "malformed_request",
          message: "proposal object is not a JSON object",
        });
      }
      // `kind` is checked against the shared list rather than asserted across, so a value the
      // proposals CHECK allows but `assertions` would refuse fails here with a named reason
      // instead of as a raw constraint violation halfway through a transaction.
      const kind = KINDS.find((k) => k === proposal?.kind);
      if (!kind) {
        throw new Rejection({
          reason: "kind_known",
          message: `proposal kind ${proposal.kind} is not an assertion kind`,
        });
      }

      // The citation *is* the evidence. Nothing is synthesised, and the extractor's opinion of
      // itself is left behind: a proposal has earned nothing that an assertion may inherit.
      const evidence: Evidence = { ...proposal.citation, source };
      if (body.human) evidence.human = body.human;

      const row = proposal;
      const promoted = await db.tx("app", async (client) => {
        let assertion: AssertionRow;
        try {
          const result = await assertFact(
            db,
            {
              scope: row.scope,
              subject: row.subject,
              predicate: row.predicate,
              object: object.data,
              claim: row.claim,
              kind,
              evidence,
              confidence: body.human ? "confirmed-by-human" : "unverified",
              asserted_by: `key:${key.label}`,
              causality: newId("evt"),
              why: `promoted from proposal ${row.id}`,
            },
            { client },
          );
          assertion = result.assertion;
        } catch (err) {
          // Enlisted in our transaction, `assertFact` does not swallow a duplicate hash — and it
          // should not, because the violation has already poisoned this transaction. Reaching
          // here means two reviewers promoted the same proposal within the same millisecond
          // (`valid_from` and `why` are both in the content hash, so nothing slower collides).
          // The transaction rolls back, the proposal stays pending, and the loser retries.
          if (!isDuplicateHash(err)) throw err;
          throw new Rejection({
            reason: "malformed_request",
            message: `proposal ${row.id} is being promoted concurrently; retry`,
          });
        }

        // `AND status = 'pending'` is what makes double-promotion impossible even if two
        // reviewers click at once. It is kept even though the row was read as pending moments
        // ago, because that read is not a lock.
        const updated = await client.query(
          `UPDATE datum.proposals
              SET status = 'accepted', promoted_to = $2, reviewed_by = $3,
                  reviewed_at = now(), review_note = $4
            WHERE id = $1 AND status = 'pending'`,
          [row.id, assertion.id, `key:${key.label}`, body.note ?? null],
        );
        if (updated.rowCount !== 1) {
          throw new Rejection({
            reason: "malformed_request",
            message: `proposal ${row.id} was reviewed concurrently`,
          });
        }
        return assertion;
      });

      return reply.code(201).send({
        ok: true,
        proposal: row.id,
        assertion: promoted,
        note:
          promoted.confidence === "unverified"
            ? "landed as unverified. name a human to record this as confirmed-by-human."
            : undefined,
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, {
        actor,
        scope: proposal?.scope,
        subject: proposal?.subject,
        predicate: proposal?.predicate,
      });
    }
  });

  app.post("/v1/proposals/:id/reject", async (request, reply) => {
    let actor: string | null = null;
    let proposal: ProposalRow | null = null;
    try {
      const key = await auth(request, "assert");
      actor = key.label;
      const params = parse(IdParam, request.params);
      const body = parse(RejectBody, request.body ?? {});

      proposal = await load(params.id);
      requireScope(key, proposal.scope);

      const updated = await db.query(
        "app",
        `UPDATE datum.proposals
            SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3
          WHERE id = $1 AND status = 'pending'`,
        [proposal.id, `key:${key.label}`, body.reason],
      );
      if (updated.rowCount !== 1) {
        throw new Rejection({
          reason: "malformed_request",
          message: `proposal ${proposal.id} is ${proposal.status}, not pending`,
          detail: { status: proposal.status },
        });
      }
      return reply.send({
        ok: true,
        proposal: proposal.id,
        status: "rejected",
        reason: body.reason,
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, {
        actor,
        scope: proposal?.scope,
        subject: proposal?.subject,
        predicate: proposal?.predicate,
      });
    }
  });
}
