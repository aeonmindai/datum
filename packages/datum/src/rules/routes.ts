import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db, DbRole } from "../db/pool.js";
import { Rejection } from "../domain/errors.js";
import { newId } from "../domain/identity.js";
import { take } from "../domain/store.js";
import type { AssertionRow } from "../domain/types.js";
import { authenticateKey, requirePermission, requireScope } from "../http/auth.js";
import { sendRejection } from "../http/v1.js";
import { DOCTRINE_EXTRACTOR, type UnenforcedFinding } from "./types.js";

/**
 * The read surface for derived rules.
 *
 * Two endpoints, because they answer two different questions and must never be merged:
 *
 *   `GET /v1/rules`            — what the machines actually enforce, from `datum.assertions`.
 *   `GET /v1/rules/unenforced` — what a human wrote down that nothing checks, from
 *                                `datum.proposals`.
 *
 * The second is a report, not a record. Unenforced doctrine lives in the proposal queue precisely
 * because "this sentence is a real org rule" is a judgement, and a store that promoted an
 * extractor's reading of prose into its own facts is the thing this product exists not to be.
 */

const ScopeString = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/, "scope must be slash-separated labels");

const RulesQuery = z.object({
  scope: ScopeString,
  binding: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const UnenforcedQuery = z.object({
  scope: ScopeString,
  strength: z.enum(["absolute", "prohibition", "obligation"]).optional(),
  status: z.enum(["pending", "accepted", "rejected", "superseded"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export interface RulesDeps {
  db: Db;
  config: Config;
}

export function registerRulesRoutes(app: FastifyInstance, deps: RulesDeps): void {
  const { db } = deps;

  app.get("/v1/rules", async (request, reply) => {
    try {
      // Authenticate, then validate, then scope-check — the same order as `/v1`, and for the same
      // reason: parsing first lets an anonymous caller map the request schema by reading 400s.
      const key = await authenticateKey(db, request.headers.authorization);
      requirePermission(key, "read");
      const query = parse(RulesQuery, request.query);
      requireScope(key, query.scope);

      const limit = query.limit ?? 500;
      // Two calls into `datum.take` rather than new SQL, so nearest-scope-wins, live-only and the
      // contested/inputs_unresolvable flags all behave identically to `/v1/ask`. A rules listing
      // that resolved scopes differently from every other read would be its own bug.
      const [rules, constraints] = await Promise.all([
        take(db, { scope: query.scope, kind: "rule", limit }),
        take(db, { scope: query.scope, kind: "constraint", limit }),
      ]);

      let rows = [...rules.assertions, ...constraints.assertions];
      if (query.binding) rows = rows.filter((r) => r.binding === (query.binding === "true"));
      rows.sort(compareRules);
      rows = rows.slice(0, limit);

      const binding = rows.filter((r) => r.binding);
      return reply.send({
        ok: true,
        scope: query.scope,
        mode: rules.mode,
        chain: rules.chain,
        counts: {
          binding: binding.length,
          advisory: rows.length - binding.length,
          total: rows.length,
        },
        // Stated on every response so a caller never has to infer what `binding` means.
        binding_means: "violating it fails something: a CI job, a lint at error/deny level, a merge",
        rules: rows,
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.get("/v1/rules/unenforced", async (request, reply) => {
    try {
      const key = await authenticateKey(db, request.headers.authorization);
      requirePermission(key, "read");
      const query = parse(UnenforcedQuery, request.query);
      requireScope(key, query.scope);

      // Scope prefix rather than the inherited chain: an unenforced-doctrine report is about the
      // documents under a scope, and inheriting a parent's findings would attribute another
      // project's un-policed rules to this one.
      const { rows } = await db.query<ProposalRow>(
        "app",
        `SELECT id, scope, subject, predicate, object, claim, kind, citation, status,
                extractor_confidence, created_at, reviewed_by, reviewed_at, review_note, promoted_to
           FROM datum.proposals
          WHERE extractor = $1
            AND (scope = $2 OR scope LIKE $2 || '/%')
            AND status = $3
            AND ($4::text IS NULL OR citation->>'strength' = $4)
          ORDER BY
            CASE citation->>'strength'
              WHEN 'absolute' THEN 0 WHEN 'prohibition' THEN 1 ELSE 2 END,
            citation->>'source'
          LIMIT $5`,
        [DOCTRINE_EXTRACTOR, query.scope, query.status ?? "pending", query.strength ?? null, query.limit ?? 500],
      );

      return reply.send({
        ok: true,
        scope: query.scope,
        extractor: DOCTRINE_EXTRACTOR,
        count: rows.length,
        // Said out loud, because the whole value of this endpoint is that it is NOT the record.
        note:
          "doctrine with no mechanical enforcement. these are proposals, not assertions: nothing " +
          "here is a fact about the org until a human confirms the citation and promotes it.",
        unenforced: rows,
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });
}

interface ProposalRow {
  id: string;
  scope: string;
  subject: string;
  predicate: string;
  object: Record<string, unknown>;
  claim: string | null;
  kind: string;
  citation: Record<string, unknown>;
  status: string;
  extractor_confidence: string | null;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  promoted_to: string | null;
}

/** Binding first, then nearest scope, then newest — the order a reader wants: teeth before advice. */
function compareRules(a: AssertionRow, b: AssertionRow): number {
  if (a.binding !== b.binding) return a.binding ? -1 : 1;
  if (a.scope_depth !== b.scope_depth) return b.scope_depth - a.scope_depth;
  if (a.asserted_at !== b.asserted_at) return b.asserted_at < a.asserted_at ? -1 : 1;
  return a.subject.localeCompare(b.subject);
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new Rejection({
      reason: "malformed_request",
      message: parsed.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; "),
      detail: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

/** How sure the scanner is of itself, per imperative strength. Deliberately not the assertion
 *  confidence vocabulary: a proposal has earned nothing, and reusing those words here would invite
 *  promoting the label along with the row. */
const SELF_CONFIDENCE: Record<string, number> = {
  absolute: 0.9,
  prohibition: 0.7,
  obligation: 0.5,
};

export interface PersistUnenforcedResult {
  created: number;
  /** Already present from an earlier run. A re-scan must never manufacture a second copy. */
  skipped: number;
}

/**
 * Write unenforced-doctrine findings to the proposal queue.
 *
 * The subject is `doctrine/<file>#L<line>`, which makes a re-run of the scanner idempotent: the same
 * sentence at the same line collides with `proposal_identity` and is skipped rather than duplicated.
 * That constraint is the one that makes 808 copies of a single claim impossible, so this code leans
 * on it instead of checking first and racing.
 *
 * It leans on it by catching the violation rather than by `ON CONFLICT`, because `proposal_identity`
 * is declared `DEFERRABLE` and Postgres refuses a deferrable constraint as an `ON CONFLICT` arbiter
 * ("does not support deferrable unique constraints as arbiters"). A `WHERE NOT EXISTS` pre-check
 * would sidestep the error and reintroduce the race the constraint exists to close, so the insert is
 * attempted and 23505 is read as "already recorded".
 */
export async function persistUnenforced(
  db: Db,
  opts: { scope: string; repo: string },
  findings: readonly UnenforcedFinding[],
  role: DbRole = "app",
): Promise<PersistUnenforcedResult> {
  let created = 0;
  for (const finding of findings) {
    try {
      await db.query(
        role,
        `INSERT INTO datum.proposals
         (id, scope, subject, predicate, object, claim, kind, citation, extractor, extractor_confidence)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10)`,
        [
          newId("prop"),
          opts.scope,
          `doctrine/${finding.file}#L${finding.line}`,
          "unenforced_rule",
          JSON.stringify({
            repo: opts.repo,
            file: finding.file,
            line: finding.line,
            heading: finding.heading,
            strength: finding.strength,
            marker: finding.marker,
            tokens: finding.tokens,
          }),
          finding.statement,
          // A prohibition constrains what may happen; an obligation is a rule about what must.
          finding.strength === "obligation" ? "rule" : "constraint",
          JSON.stringify({
            source: finding.source,
            statement: finding.statement,
            heading: finding.heading,
            strength: finding.strength,
            marker: finding.marker,
            target: finding.target,
            tokens: finding.tokens,
            doctrinal: finding.doctrinal,
            also_at: finding.also_at,
            why_unenforced: finding.why,
          }),
          DOCTRINE_EXTRACTOR,
          SELF_CONFIDENCE[finding.strength] ?? 0.5,
        ],
      );
      created++;
    } catch (err) {
      // 23505 is the constraint doing its job. Anything else is a real failure and must surface.
      if ((err as { code?: string }).code !== "23505") throw err;
    }
  }
  return { created, skipped: findings.length - created };
}
