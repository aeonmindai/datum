import type { Evidence } from "../domain/types.js";

/**
 * Preference learning — the shapes, the tier ladder, and the reserved names.
 *
 * The tiers are the ones migration 010 declares, and the thresholds are not ours to choose: the
 * database CHECK `preference_tier_matches_corroboration` refuses any row whose tier disagrees with
 * its `distinct_humans` count, so this table is a mirror of the schema rather than a second opinion
 * about it. A number nobody can explain is a number nobody will act on, and acting on it is the
 * entire point.
 *
 *   personal  repeated by exactly one human      -> their preference, guidance
 *   team      corroborated by exactly two        -> guidance, corroborated
 *   org       three or more distinct humans      -> a rule the org holds, binding
 */

export const PREFERENCE_TIERS = ["personal", "team", "org"] as const;
export type PreferenceTier = (typeof PREFERENCE_TIERS)[number];

/** Strength order. Only used to answer "is this a strengthening or a downgrade?". */
export const TIER_RANK: Record<PreferenceTier, number> = { personal: 1, team: 2, org: 3 };

/**
 * A preference is only a preference if it recurred. `preference_requires_repetition` refuses
 * anything below two occasions, so this is the floor rather than a tunable default: asking the
 * promoter for a lower threshold would just generate candidates the table throws away.
 */
export const MIN_OCCASIONS = 2;

/**
 * The predicate every promoted preference is asserted under.
 *
 * Deliberately preference-shaped. A read of `/v1/ask?predicate=prefers` returns learned
 * preferences and nothing else, so a preference can never be mistaken for an asserted fact about
 * the world — which matters most in the case where it is wrong.
 */
export const PREFERENCE_PREDICATE = "prefers";

/**
 * Assertion subjects are `preference:<signature>`. The signature is unique per correction, so two
 * different preferences in one scope can never collide on subject+predicate, and a preference can
 * never contradict a fact someone asserted about the same subject.
 */
export const PREFERENCE_SUBJECT_PREFIX = "preference:";

/**
 * Reserved. A human rejecting a learned preference is itself a thing a human did, so it is recorded
 * as a feedback event — but under this predicate, which the promoter skips.
 *
 * Without that skip the escape hatch feeds the machine it exists to stop: two humans rejecting the
 * same wrong preference would corroborate each other, and the store would promote "people reject
 * this" into a rule of its own. `POST /v1/feedback` therefore refuses this predicate outright.
 */
export const REJECTION_PREDICATE = "rejected_learned_preference";

/** What the promoter did, one entry per preference it created or strengthened. */
export interface PreferencePromotion {
  preference_id: string;
  scope: string;
  signature: string;
  subject: string;
  predicate: string;
  statement: string;
  tier: PreferenceTier;
  /** The tier this replaced, or null when the preference is new. */
  previous_tier: PreferenceTier | null;
  /** The preference row this supersedes. Never deleted, so the tier history stays walkable. */
  supersedes: string | null;
  occasions: number;
  distinct_humans: number;
  binding: boolean;
  assertion_id: string;
  /** The assertion this superseded, if it strengthened an existing preference. */
  supersedes_assertion: string | null;
  /** The actual humans, named. `evidence.human` is built from exactly this list. */
  humans: string[];
  occasion_ids: string[];
  event_ids: string[];
}

/** A live preference as the delivery path sees it, already resolved along the scope chain. */
export interface ActivePreference {
  id: string;
  scope: string;
  signature: string;
  subject: string;
  predicate: string;
  statement: string;
  tier: PreferenceTier;
  occasions: number;
  distinct_humans: number;
  first_seen: string;
  last_seen: string;
  evidence_events: string[];
  assertion_id: string | null;
  /** From the assertion: true only at org tier. Several people independently, or nobody binding. */
  binding: boolean;
  /** The assertion's evidence: the humans, the occasions, the event ids. Null if unasserted. */
  citation: Evidence | null;
  /** The preference row this one replaced, so "when did this become an org rule?" is answerable. */
  supersedes: string | null;
  created_at: string;
  /** Hops from the requested scope: 0 is the scope itself. Nearest wins. */
  distance: number;
}

/** A `datum.preferences` row, as stored. */
export interface PreferenceRow {
  id: string;
  scope: string;
  signature: string;
  subject: string;
  predicate: string;
  statement: string;
  tier: PreferenceTier;
  occasions: number;
  distinct_humans: number;
  first_seen: string;
  last_seen: string;
  evidence_events: string[];
  assertion_id: string | null;
  status: "active" | "retired" | "rejected";
  supersedes: string | null;
  superseded_by: string | null;
  created_at: string;
}
