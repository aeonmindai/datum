/**
 * Preference learning — what a human corrected, how often, and by how many people.
 *
 * The design lives in `migrations/010_preferences.sql`; this is its runtime. Four decisions carry
 * the whole subsystem, and each is structural rather than a filter someone can forget:
 *
 * 1. THE SIGNAL IS THE REPETITION, NOT THE CONTENT. Nothing here interprets what a human said.
 *    `signature.ts` normalises case and whitespace and then counts exact matches. The counter is the
 *    instrument, so there is no extraction step and therefore nothing to hallucinate.
 * 2. DEDUPLICATION IS BY OCCASION. `UNIQUE (actor, signature, occasion)` makes mem0's 808 copies of
 *    one hallucinated preference arithmetically impossible rather than merely discouraged.
 * 3. CONFIDENCE IS EARNED BY CORROBORATION. `promote.ts` is the sibling of `worker/verify.ts`: one
 *    report earns nothing, repetition earns a personal preference, distinct humans raise the scope
 *    of authority. Only an org-wide preference is `binding`.
 * 4. EVERY PREFERENCE IS AUDITABLE BACK TO ITS OCCASIONS. The promoted assertion names the humans
 *    and cites the event ids, so "why do you think I prefer this?" has an answer with citations —
 *    and `POST /v1/preferences/:id/reject` is the way out when the answer is wrong.
 *
 * And one rule about code rather than data, enforced in `record.ts` by having no path to the tables
 * it forbids: whatever reports feedback must never read what the store has already learned in order
 * to decide what to report. That loop is what manufactured the 808.
 */

export { recordFeedback, type FeedbackInput, type FeedbackRecord } from "./record.js";
export {
  promotePreferences,
  startPreferenceWorker,
  type PreferenceWorkerHandle,
} from "./promote.js";
export { activePreferences } from "./read.js";
export { registerPreferenceRoutes, type PreferenceDeps } from "./routes.js";
export { feedbackSignature, normaliseFeedbackText, rejectionSignature } from "./signature.js";
export {
  MIN_OCCASIONS,
  PREFERENCE_PREDICATE,
  PREFERENCE_SUBJECT_PREFIX,
  PREFERENCE_TIERS,
  REJECTION_PREDICATE,
  TIER_RANK,
  type ActivePreference,
  type PreferencePromotion,
  type PreferenceRow,
  type PreferenceTier,
} from "./types.js";
