import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { newId } from "../domain/identity.js";
import { assertFact } from "../domain/store.js";
import type { AssertionRow } from "../domain/types.js";
import { checkViaGitHub, checkViaLocalClone, UNRESOLVABLE, type ContainmentCheck } from "./git.js";

/**
 * Deliverable 2 — the verification worker.
 *
 * Invariant 4 says confidence is earned, never claimed. An earlier draft tried to make this a
 * database check on the commit, which is unimplementable — Postgres cannot run git. The design
 * that replaced it is stronger: **an agent cannot assert `measured` at all.** Every agent write
 * lands `unverified`, and this worker promotes it only after confirming the commit resolves and
 * is contained where the evidence claims.
 *
 * Promotion is itself an assertion that supersedes the unverified row, so the history reads:
 * at sequence N we believed this unverified; at N+1 it was measured, by this verification. The
 * outcome is written as its own assertion too, so a refutation is a first-class fact rather
 * than a log line.
 *
 * GitHub Copilot Memory validating citations against the current branch is the only shipped
 * mechanism of this kind found anywhere in the research. This closes exactly the hole that let
 * "branch work quoted as shipped" survive three sessions on Arc.
 */

export type Outcome = "confirmed" | "refuted" | "unresolvable";

export interface VerificationResult {
  assertion_id: string;
  outcome: Outcome;
  verification_id: string;
  /** Set when the row was promoted: the id of the new `measured` assertion. */
  promoted_to: string | null;
  method: ContainmentCheck["method"];
  detail: Record<string, unknown>;
}

const OUTCOME_SUBJECT_PREFIX = "assertion:";
export const VERIFICATION_PREDICATE = "verification_outcome";

interface Candidate extends AssertionRow {
  last_outcome: Outcome | null;
  last_checked_at: string | null;
  last_reason: string | null;
}

/**
 * Rows eligible for a verification attempt: live, still `unverified`, and either never checked
 * or checked long enough ago to be worth retrying. A row whose evidence carries no commit is
 * checked exactly once — nothing about it will change until someone asserts again — which is
 * why `no_commit_in_evidence` is excluded from the retry window rather than backed off.
 */
const CANDIDATE_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (target_assertion_id)
           target_assertion_id, outcome, checked_at, detail->>'reason' AS reason
      FROM datum.verifications
     ORDER BY target_assertion_id, checked_at DESC
  )
  SELECT a.*, l.outcome AS last_outcome, l.checked_at AS last_checked_at, l.reason AS last_reason
    FROM datum.assertions a
    LEFT JOIN latest l ON l.target_assertion_id = a.id
   WHERE a.confidence = 'unverified'
     AND a.superseded_by IS NULL
     AND (
       l.target_assertion_id IS NULL
       OR (l.reason IS DISTINCT FROM 'no_commit_in_evidence'
           AND l.checked_at < now() - ($2::int * interval '1 millisecond'))
     )
   ORDER BY a.asserted_at ASC
   LIMIT $1`;

async function check(config: Config, row: AssertionRow): Promise<ContainmentCheck> {
  const commit = typeof row.evidence?.commit === "string" ? row.evidence.commit.trim() : "";
  const repo = typeof row.evidence?.repo === "string" ? row.evidence.repo.trim() : "";
  const containedIn = Array.isArray(row.evidence?.contained_in)
    ? row.evidence.contained_in.filter((r): r is string => typeof r === "string")
    : [];

  if (!commit) {
    return {
      // Nothing was read and nothing was concluded: a claim with no commit is not false, it is
      // simply unverifiable until someone asserts again with one.
      readable: false,
      exists: false,
      contained: {},
      method: "none",
      detail: {
        reason: "no_commit_in_evidence",
        says:
          "This claim carries no evidence.commit, so it can never be promoted. Assert again " +
          "with a commit, or leave it as testimony.",
      },
    };
  }

  const mirror = repo ? config.gitMirrors[repo] : undefined;
  if (mirror) return checkViaLocalClone(mirror, commit, containedIn);
  if (repo && config.githubToken) return checkViaGitHub(repo, commit, containedIn, config.githubToken);
  // Public repos answer unauthenticated too, but only if the operator opted into any outbound
  // call at all by naming a repo we can reach. Without a repo there is nothing to ask.
  if (repo) return checkViaGitHub(repo, commit, containedIn, null);
  return UNRESOLVABLE;
}

function judge(c: ContainmentCheck): { outcome: Outcome; why: string } {
  if (c.method === "none") return { outcome: "unresolvable", why: String(c.detail.says ?? "") };
  // Only a check that could actually read the repository is allowed to refute anything. "We
  // were not allowed to look" and "we looked and it is not there" are different answers, and a
  // store that reports the first as the second is doing exactly what it exists to prevent:
  // publishing a confident claim it cannot support.
  if (!c.readable) {
    return {
      outcome: "unresolvable",
      why: String(c.detail.says ?? "the repository could not be read, so nothing was concluded"),
    };
  }
  if (!c.exists) {
    return { outcome: "refuted", why: "evidence.commit does not resolve to a commit object" };
  }
  const broken = Object.entries(c.contained)
    .filter(([, ok]) => !ok)
    .map(([ref]) => ref);
  if (broken.length > 0) {
    return {
      outcome: "refuted",
      why: `the commit is not contained in ${broken.join(", ")}, which the evidence claims`,
    };
  }
  return { outcome: "confirmed", why: "commit resolves and is contained where claimed" };
}

export async function verifyOne(
  db: Db,
  config: Config,
  row: Candidate,
): Promise<VerificationResult> {
  const containment = await check(config, row);
  const { outcome, why } = judge(containment);
  const verificationId = newId("v");

  await db.query(
    "verifier",
    `INSERT INTO datum.verifications (id, target_assertion_id, outcome, checker, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      verificationId,
      row.id,
      outcome,
      `worker:verification@${config.org}`,
      JSON.stringify({
        ...containment.detail,
        method: containment.method,
        exists: containment.exists,
        contained: containment.contained,
        why,
        ...(containment.method === "none" ? {} : { reason: containment.detail.reason ?? null }),
      }),
    ],
  );

  let promotedTo: string | null = null;
  if (outcome === "confirmed") {
    // The promotion supersedes the unverified row rather than editing it, so an as-of read
    // still reconstructs what we believed before the evidence was checked.
    const promoted = await assertFact(
      db,
      {
        scope: row.scope,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        claim: row.claim,
        kind: row.kind,
        binding: row.binding,
        confidence: "measured",
        evidence: { ...row.evidence, verified_by: verificationId, verified_via: containment.method },
        valid_from: row.valid_from,
        valid_to: row.valid_to,
        asserted_by: `worker:verification@${config.org}`,
        supersedes: row.id,
        why: row.why,
        reopen_if: row.reopen_if,
        causality: row.causality,
        verification_id: verificationId,
      },
      { role: "verifier" },
    );
    promotedTo = promoted.assertion.id;
  }

  // The outcome is itself an assertion. It came off an instrument (git), so it is `measured`
  // and carries the verification that produced it. A later re-check supersedes it rather than
  // colliding with it.
  if (row.last_outcome !== outcome) {
    const prior = await db.one<{ id: string }>(
      "verifier",
      `SELECT id FROM datum.assertions
        WHERE superseded_by IS NULL AND scope = $1 AND subject = $2 AND predicate = $3
        ORDER BY asserted_at DESC LIMIT 1`,
      [row.scope, `${OUTCOME_SUBJECT_PREFIX}${row.id}`, VERIFICATION_PREDICATE],
    );
    await assertFact(
      db,
      {
        scope: row.scope,
        subject: `${OUTCOME_SUBJECT_PREFIX}${row.id}`,
        predicate: VERIFICATION_PREDICATE,
        object: { value: outcome, why, method: containment.method },
        claim: `verification of ${row.id}: ${outcome} — ${why}`,
        kind: "state",
        confidence: "measured",
        evidence: {
          source: `datum verification worker, verification ${verificationId}`,
          instrument: containment.method,
          repo: typeof row.evidence?.repo === "string" ? row.evidence.repo : undefined,
          commit: typeof row.evidence?.commit === "string" ? row.evidence.commit : undefined,
          protocol: "resolve evidence.commit, then assert containment for every claimed ref",
        },
        asserted_by: `worker:verification@${config.org}`,
        supersedes: prior?.id ?? null,
        verification_id: verificationId,
      },
      { role: "verifier" },
    );
  }

  return {
    assertion_id: row.id,
    outcome,
    verification_id: verificationId,
    promoted_to: promotedTo,
    method: containment.method,
    detail: { why, contained: containment.contained, ...containment.detail },
  };
}

export async function runVerificationPass(
  db: Db,
  config: Config,
  opts: { limit?: number; recheckMs?: number } = {},
): Promise<VerificationResult[]> {
  const { rows } = await db.query<Candidate>("verifier", CANDIDATE_SQL, [
    opts.limit ?? config.verifyBatchSize,
    opts.recheckMs ?? 3_600_000,
  ]);
  const results: VerificationResult[] = [];
  for (const row of rows) {
    try {
      results.push(await verifyOne(db, config, row));
    } catch (err) {
      console.error(`[verify] ${row.id}: ${(err as Error).message}`);
    }
  }
  return results;
}

export interface WorkerHandle {
  stop(): void;
}

export function startVerificationWorker(db: Db, config: Config): WorkerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const results = await runVerificationPass(db, config);
      const promoted = results.filter((r) => r.promoted_to);
      const refuted = results.filter((r) => r.outcome === "refuted");
      if (results.length > 0) {
        console.log(
          `[verify] checked ${results.length}: ${promoted.length} promoted to measured, ` +
            `${refuted.length} refuted`,
        );
      }
    } catch (err) {
      console.error(`[verify] pass failed: ${(err as Error).message}`);
    }
    if (!stopped) timer = setTimeout(tick, config.verifyIntervalMs);
  };

  timer = setTimeout(tick, 1_000);
  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
