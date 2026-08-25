import { sha256Hex } from "../domain/identity.js";

/**
 * The signature: how Datum decides that two corrections are the same correction.
 *
 * This is the most dangerous function in the subsystem, so the rule it implements is deliberately
 * small enough to hold in your head, and it lives in exactly one place.
 */

/**
 * Normalise one field of feedback: NFKC, lowercase, collapse whitespace runs, trim.
 *
 * That is the whole rule. `"use tabs"`, `"Use  tabs"` and `"USE TABS\n"` are the same correction
 * and must collide, or the repetition count undercounts and nothing is ever learned.
 *
 * What is NOT here is the important part: no stemming, no synonyms, no edit distance, no
 * embeddings, no clustering. Fuzzy matching is where a preference store starts inventing agreement
 * that was never there — two humans who said *different* things get merged into one row, the
 * distinct-human count goes up, the tier is promoted on the strength of that guess, and nothing in
 * the row records that a guess happened. That is the mechanism behind mem0's 808 copies of one
 * hallucinated "User prefers Vim": a customer audit of 10,134 production entries found 97.8% junk,
 * and upgrading the model did not help because the extraction step, not the model, was the defect.
 *
 * Exact match over a normalised key cannot manufacture a second human. Under-counting is a missed
 * preference, which costs a repeated correction. Over-counting is a fabricated org-wide rule, which
 * costs the credibility of every other row in the store. Those are not symmetric, so this errs one
 * way on purpose.
 */
export function normaliseFeedbackText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Canonical form of the correction, normalised the same way and with object keys sorted at every
 * depth, so the hash is stable across writers and across key order.
 *
 * Array order is preserved rather than sorted: in a list, order is meaning. `["a","b"]` and
 * `["b","a"]` are different corrections and get different signatures.
 */
function canonicalCorrection(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(normaliseFeedbackText(value));
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalCorrection).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [normaliseFeedbackText(k), canonicalCorrection(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(",")}}`;
}

/**
 * `subject|predicate|sha256(correction)`, all normalised.
 *
 * The hash is never truncated. A truncated hash collides at the birthday bound, and a collision
 * here does not lose data — it *merges two distinct preferences and adds their humans together*,
 * which is exactly the fabricated-corroboration failure this design exists to refuse. Sixteen extra
 * bytes of index are cheaper than one invented org rule.
 */
export function feedbackSignature(input: {
  subject: string;
  predicate: string;
  correction: Record<string, unknown>;
}): string {
  // `|` separates the fields, so it must not be able to appear inside one: without escaping,
  // subject `a|b` with predicate `c` and subject `a` with predicate `b|c` produce the same key,
  // which is a collision between two genuinely different pieces of feedback.
  const fields = [input.subject, input.predicate].map((field) =>
    normaliseFeedbackText(field).replace(/[\\|]/g, (c) => `\\${c}`),
  );
  return [...fields, sha256Hex(canonicalCorrection(input.correction))].join("|");
}

/**
 * The signature a rejection counter-event is filed under: keyed to the exact preference row, and
 * therefore never the signature of the preference being rejected.
 *
 * Filing a rejection under the rejected preference's own signature would make saying "no" *raise*
 * that preference's occasion count — a human's objection strengthening the thing they objected to.
 * Already normalised, so it survives `recordFeedback` unchanged whichever path writes it.
 */
export function rejectionSignature(preferenceId: string): string {
  return normaliseFeedbackText(`rejected|${preferenceId}`);
}
