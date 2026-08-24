import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { newId } from "../domain/identity.js";
import { assertFact } from "../domain/store.js";
import {
  MIN_OCCASIONS,
  PREFERENCE_PREDICATE,
  PREFERENCE_SUBJECT_PREFIX,
  REJECTION_PREDICATE,
  TIER_RANK,
  type PreferencePromotion,
  type PreferenceRow,
  type PreferenceTier,
} from "./types.js";

/**
 * The promoter — confidence earned by corroboration, exactly as `measured` is earned by
 * verification. This is the same shape as `worker/verify.ts` for the same reason: a claim is logged
 * when it arrives and promoted only after something independent of the claimant supports it.
 *
 * What the verifier does with git, this does with arithmetic. It reads
 * `datum.preference_candidates`, which is pure aggregation over the event log — no interpretation,
 * no model, nothing to hallucinate. One report earns nothing. Repetition by one human earns a
 * personal preference. Corroboration by distinct humans raises the SCOPE of authority, not merely a
 * score, which is what makes the existing scope hierarchy do real work here.
 *
 * Nothing is ever mutated in place. A strengthened preference is a new row that supersedes its
 * predecessor, so "when did this become an org rule?" stays answerable — which is the question mem0
 * could not answer about any of its 808 rows, and precisely why nobody could ever clean them up.
 *
 * This module reads `feedback_events`, `preferences` and `assertions` freely. That is not a
 * violation of the anti-loop rule: the rule constrains what may influence *what gets reported*, and
 * the promoter reports nothing. It is the reader of the counter, never a writer to it. See
 * `record.ts` for the enforced half.
 */

interface CandidateRow {
  scope: string;
  signature: string;
  subject: string;
  predicate: string;
  occasions: number;
  distinct_humans: number;
  tier: PreferenceTier;
  first_seen: string;
  last_seen: string;
  event_ids: string[];
  latest_correction: Record<string, unknown>;
}

interface EventRow {
  id: string;
  actor: string;
  occasion: string;
}

/** The live head for a signature: the row occupying `preferences_one_live_per_signature`. */
const LIVE_SQL = `
  SELECT id, scope, signature, subject, predicate, statement, tier, occasions, distinct_humans,
         first_seen, last_seen, evidence_events, assertion_id, status, supersedes, superseded_by,
         created_at
    FROM datum.preferences
   WHERE scope = $1 AND signature = $2 AND superseded_by IS NULL AND status = 'active'`;

/**
 * The escape hatch, and the reason it holds. A rejection is permanent: `status = 'rejected'`
 * releases the live-slot index, so without this check the next matching event would simply promote
 * the same wrong preference again and a human's "no" would be worth one pass of a background worker.
 * A preference the org has explicitly rejected must never be re-promoted, so it is checked across
 * the whole history of the signature rather than only its live head.
 */
const REJECTED_SQL = `
  SELECT id FROM datum.preferences
   WHERE scope = $1 AND signature = $2 AND status = 'rejected'
   ORDER BY created_at DESC LIMIT 1`;

const EVENTS_SQL = `
  SELECT id, actor, occasion FROM datum.feedback_events
   WHERE id = ANY($1::text[])
   ORDER BY created_at`;

/**
 * The sentence stored on the row and used as the assertion's claim.
 *
 * A string the human supplied is used verbatim, because their own words beat anything composed
 * here. The fallback is the canonical JSON of the correction — literal rather than paraphrased,
 * because paraphrasing is interpretation and interpretation is the step this subsystem refuses to
 * take. Datum does not decide what the human meant; it counts how often they said it.
 */
function renderStatement(candidate: CandidateRow): string {
  const said = candidate.latest_correction ?? {};
  const verbatim = ["statement", "text", "value", "prefer"]
    .map((key) => said[key])
    .find((v): v is string => typeof v === "string" && v.trim().length > 0);
  const body = verbatim ? verbatim.trim() : JSON.stringify(said);
  return `${candidate.subject} — ${candidate.predicate}: ${body}`;
}

async function promoteOne(
  db: Db,
  candidate: CandidateRow,
  actor: string,
): Promise<PreferencePromotion | null> {
  const rejected = await db.one<{ id: string }>("app", REJECTED_SQL, [
    candidate.scope,
    candidate.signature,
  ]);
  if (rejected) return null;

  const live = await db.one<PreferenceRow>("app", LIVE_SQL, [candidate.scope, candidate.signature]);

  if (
    live &&
    live.tier === candidate.tier &&
    live.occasions === candidate.occasions &&
    live.distinct_humans === candidate.distinct_humans
  ) {
    // Idempotence. Nothing about the evidence changed, so there is nothing to record; a second row
    // here would be a duplicate that cites the same events, which is the failure mode by name.
    return null;
  }

  if (live && TIER_RANK[candidate.tier] < TIER_RANK[live.tier]) {
    // Unreachable while the event log is append-only, which it is: counts only ever rise. Left in
    // because if it ever does fire, history has been lost, and silently downgrading an org-wide
    // rule on the strength of a shrunken count is the one outcome worse than doing nothing.
    return null;
  }

  const { rows: events } = await db.query<EventRow>("app", EVENTS_SQL, [candidate.event_ids]);
  const humans = [...new Set(events.map((e) => e.actor))];
  const occasionIds = [...new Set(events.map((e) => e.occasion))];
  // `human_evidence_names_a_human` refuses a `confirmed-by-human` row with no named human, and it
  // is right to: a preference nobody can be named for is exactly the kind of row that becomes
  // unfalsifiable. Bailing here keeps that a data-integrity guarantee rather than a runtime crash.
  if (humans.length === 0) return null;

  const statement = renderStatement(candidate);
  const preferenceId = newId("pref");
  // A preference several people independently hold is a rule; one person's is guidance. `binding`
  // means "violating this fails something", and only an org-wide preference has earned that.
  const binding = candidate.tier === "org";

  return db.tx("app", async (client) => {
    if (live) {
      // Stamp the predecessor BEFORE inserting the successor. `preferences_one_live_per_signature`
      // is a partial unique index over (scope, signature) WHERE superseded_by IS NULL AND
      // status = 'active', so the old row has to leave that index before the new one can enter it.
      // The FK on `superseded_by` is DEFERRABLE INITIALLY DEFERRED exactly so this order is legal:
      // it points at a row that does not exist yet and is checked at COMMIT.
      await client.query(`UPDATE datum.preferences SET superseded_by = $2 WHERE id = $1`, [
        live.id,
        preferenceId,
      ]);
    }

    const promoted = await assertFact(
      db,
      {
        scope: candidate.scope,
        subject: `${PREFERENCE_SUBJECT_PREFIX}${candidate.signature}`,
        predicate: PREFERENCE_PREDICATE,
        object: {
          statement,
          about_subject: candidate.subject,
          about_predicate: candidate.predicate,
          correction: candidate.latest_correction,
          tier: candidate.tier,
          occasions: candidate.occasions,
          distinct_humans: candidate.distinct_humans,
        },
        claim: statement,
        kind: "rule",
        binding,
        // A human did say this, repeatedly. It is testimony, and it is labelled as testimony —
        // which is also why it can never satisfy a mission gate demanding `measured`. Corroboration
        // raises how widely a preference applies; it never upgrades it into an instrument reading.
        confidence: "confirmed-by-human",
        evidence: {
          source: `${candidate.occasions} occasions: ${occasionIds.join(", ")}`,
          human: humans.join(", "),
          instrument: "datum preference promoter",
          protocol:
            "count distinct occasions per (scope, signature) over datum.feedback_events; " +
            "tier from the count of distinct actors: 1 personal, 2 team, 3+ org",
          // The audit trail mem0 lacked. Every preference resolves back to the exact events that
          // produced it, so "why do you think I prefer this?" has a real answer with citations.
          events: candidate.event_ids,
          occasions: occasionIds,
          humans,
          first_seen: candidate.first_seen,
          last_seen: candidate.last_seen,
        },
        asserted_by: actor,
        supersedes: live?.assertion_id ?? null,
        why:
          `${candidate.occasions} occasions from ${humans.length} distinct ` +
          `human${humans.length === 1 ? "" : "s"} earned tier ${candidate.tier}`,
        causality: newId("evt"),
      },
      { role: "app", client },
    );

    await client.query(
      `INSERT INTO datum.preferences
         (id, scope, signature, subject, predicate, statement, tier, occasions, distinct_humans,
          first_seen, last_seen, evidence_events, assertion_id, status, supersedes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text[],$13,'active',$14)`,
      [
        preferenceId,
        candidate.scope,
        candidate.signature,
        candidate.subject,
        candidate.predicate,
        statement,
        candidate.tier,
        candidate.occasions,
        candidate.distinct_humans,
        candidate.first_seen,
        candidate.last_seen,
        candidate.event_ids,
        promoted.assertion.id,
        live?.id ?? null,
      ],
    );

    return {
      preference_id: preferenceId,
      scope: candidate.scope,
      signature: candidate.signature,
      subject: candidate.subject,
      predicate: candidate.predicate,
      statement,
      tier: candidate.tier,
      previous_tier: live?.tier ?? null,
      supersedes: live?.id ?? null,
      occasions: candidate.occasions,
      distinct_humans: candidate.distinct_humans,
      binding,
      assertion_id: promoted.assertion.id,
      supersedes_assertion: live?.assertion_id ?? null,
      humans,
      occasion_ids: occasionIds,
      event_ids: candidate.event_ids,
    };
  });
}

export async function promotePreferences(
  db: Db,
  opts: { minOccasions?: number; actor?: string } = {},
): Promise<PreferencePromotion[]> {
  // Clamped, not defaulted. `preference_requires_repetition` refuses anything below two occasions,
  // so a lower threshold would only generate candidates the table then throws away — and would read
  // to whoever set it as though single reports were being learned.
  const minOccasions = Math.max(MIN_OCCASIONS, opts.minOccasions ?? MIN_OCCASIONS);
  const actor = opts.actor ?? "worker:preferences";

  const { rows } = await db.query<CandidateRow>(
    "app",
    `SELECT scope, signature, subject, predicate, occasions, distinct_humans, tier,
            first_seen, last_seen, event_ids, latest_correction
       FROM datum.preference_candidates($1)
      ORDER BY scope, signature`,
    [minOccasions],
  );

  const promotions: PreferencePromotion[] = [];
  for (const candidate of rows) {
    // A rejection is a human action and is recorded as one, but promoting it would rebuild the loop
    // from the other side: two humans rejecting the same wrong preference would corroborate each
    // other and the store would learn "people reject this" as a rule in its own right.
    if (candidate.predicate === REJECTION_PREDICATE) continue;
    try {
      const promotion = await promoteOne(db, candidate, actor);
      if (promotion) promotions.push(promotion);
    } catch (err) {
      const e = err as { code?: string; constraint?: string } | null;
      // A concurrent pass won the live slot. The partial unique index doing its job, not a fault.
      if (e?.code === "23505" && e.constraint === "preferences_one_live_per_signature") continue;
      console.error(
        `[preferences] ${candidate.scope} ${candidate.signature}: ${(err as Error).message}`,
      );
    }
  }
  return promotions;
}

export interface PreferenceWorkerHandle {
  stop(): void;
}

/**
 * The promoter on an interval, mirroring `startVerificationWorker`.
 *
 * It shares `verifyIntervalMs` because it is the same kind of job on the same cadence — a periodic
 * pass that promotes rows which have earned it — and one knob an operator can reason about beats two
 * they have to keep in step.
 */
export function startPreferenceWorker(db: Db, config: Config): PreferenceWorkerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const promoted = await promotePreferences(db, {
        actor: `worker:preferences@${config.org}`,
      });
      // Only when something changed. Most passes find nothing, and a worker that logs every idle
      // pass trains its operator to stop reading it — while "an org-wide rule was just learned
      // about your codebase" is precisely the line that must be read.
      if (promoted.length > 0) {
        const tiers = promoted
          .map((p) => (p.previous_tier ? `${p.previous_tier}->${p.tier}` : `new ${p.tier}`))
          .join(", ");
        console.log(`[preferences] promoted ${promoted.length}: ${tiers}`);
      }
    } catch (err) {
      console.error(`[preferences] pass failed: ${(err as Error).message}`);
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
