import type { Db } from "../db/pool.js";
import { asRejection } from "../domain/errors.js";
import { newId } from "../domain/identity.js";
import { feedbackSignature, normaliseFeedbackText } from "./signature.js";

/**
 * Recording feedback — the reporting path, and the one place the anti-loop rule is enforced.
 *
 * THE ANTI-LOOP RULE. Whatever reports feedback must not read what the store has already learned in
 * order to decide what to report. Feedback is a pure function of what the human actually did.
 *
 * It is enforced here by construction, and you can check the enforcement by reading the imports at
 * the top of this file: nothing in this module reaches `datum.preferences` or `datum.assertions`, at
 * all, on any path. There is no query to remove and no flag to forget. That closure is what mem0
 * did not have — its recall step fed its extraction step, so a hallucinated "User prefers Vim" was
 * re-read, re-extracted and re-stored 808 times, each copy looking to the next pass like fresh
 * independent evidence for the same claim.
 *
 * The counts this function returns are read from `feedback_events` *after* the write has already
 * been decided, and only from `feedback_events`. They are a report to the caller about how much
 * repetition has accumulated, never an input to what gets reported, and they cannot carry anything
 * the promoter produced back into the reporting path — because nothing the promoter produced is
 * reachable from here.
 */

export interface FeedbackInput {
  scope: string;
  /** The human who gave the feedback. Distinct humans are what turn a quirk into a rule. */
  actor: string;
  subject: string;
  predicate: string;
  /** What the human wanted instead. Stored verbatim; never parsed into a claim about the world. */
  correction: Record<string, unknown>;
  /** A session, a PR, a review. THIS is the unit of repetition. */
  occasion: string;
  signature?: string;
  raw?: string | null;
  citation?: Record<string, unknown>;
}

export interface FeedbackRecord {
  id: string;
  /** False when `feedback_one_per_occasion` refused a repeat inside the same occasion. */
  created: boolean;
  occasions: number;
  distinctHumans: number;
  /** The key the counting happened under, derived when the caller did not supply one. */
  signature: string;
}

const ONE_PER_OCCASION = "feedback_one_per_occasion";

interface CountsRow {
  event_id: string | null;
  occasions: number;
  distinct_humans: number;
}

/**
 * `count(*)` is the occasion count, not an approximation of it: `UNIQUE (actor, signature, occasion)`
 * makes one row per human per occasion the only possible shape, so rows and occasions are the same
 * number. This is the identical arithmetic `datum.preference_candidates` performs, kept in step with
 * it deliberately — a caller told "3 occasions" must not then watch the promoter disagree.
 */
const COUNTS_SQL = `
  SELECT (SELECT existing.id
            FROM datum.feedback_events existing
           WHERE existing.actor = $3 AND existing.signature = $2 AND existing.occasion = $4) AS event_id,
         count(*)::int                  AS occasions,
         count(DISTINCT f.actor)::int   AS distinct_humans
    FROM datum.feedback_events f
   WHERE f.scope = $1 AND f.signature = $2`;

export async function recordFeedback(db: Db, input: FeedbackInput): Promise<FeedbackRecord> {
  // A caller-supplied signature is normalised with the same rule as a derived one. The column is
  // documented as a normalised key, and two callers writing `Style:Tabs` and `style:tabs` have to
  // land on one key or the repetition is silently split in half and nothing is ever learned.
  const supplied = input.signature ? normaliseFeedbackText(input.signature) : "";
  const signature = supplied.length > 0 ? supplied : feedbackSignature(input);
  const id = newId("fb");

  // No "does this already exist?" lookup in front of the INSERT, matching `assertFact`: the
  // constraint is the thing that decides, on every path, so there is no window in which a
  // pre-check's answer and the database's answer can differ.
  let created = true;
  try {
    await db.query(
      "app",
      `INSERT INTO datum.feedback_events
         (id, scope, actor, signature, subject, predicate, correction, raw, occasion, citation)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb)`,
      [
        id,
        input.scope,
        input.actor,
        signature,
        input.subject,
        input.predicate,
        JSON.stringify(input.correction),
        input.raw ?? null,
        input.occasion,
        JSON.stringify(input.citation ?? {}),
      ],
    );
  } catch (err) {
    const e = err as { code?: string; constraint?: string } | null;
    const duplicate =
      !!e && typeof e === "object" && e.code === "23505" && e.constraint === ONE_PER_OCCASION;
    // Not an error. One human saying the same thing five times in one session is one datum, and
    // this constraint is what makes 808 copies arithmetically impossible rather than merely
    // discouraged. Reporting it as a failure would push callers towards retrying around it.
    if (!duplicate) throw asRejection(err) ?? err;
    created = false;
  }

  const counts = await db.one<CountsRow>("app", COUNTS_SQL, [
    input.scope,
    signature,
    input.actor,
    input.occasion,
  ]);

  return {
    id: counts?.event_id ?? id,
    created,
    occasions: counts?.occasions ?? 0,
    distinctHumans: counts?.distinct_humans ?? 0,
    signature,
  };
}
