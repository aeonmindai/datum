import { createHash } from "node:crypto";
import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

export const newAssertionId = (): string => `a_${ulid()}`;
export const newId = (prefix: string): string => `${prefix}_${ulid()}`;

/**
 * The canonical body an assertion's hash is taken over.
 *
 * `asserted_at`, `asserted_by` and `causality` are deliberately excluded: two agents
 * stating the identical claim with the identical evidence are stating the same datum, so
 * `assert` is idempotent regardless of who called it and how many times. What IS included
 * is `supersedes`, so a correction is never confused with the thing it corrects, and
 * `valid_from`, so the same reading taken at two times is two facts.
 */
export interface CanonicalBody {
  scope: string;
  subject: string;
  predicate: string;
  object: unknown;
  kind: string;
  binding: boolean;
  confidence: string;
  evidence: unknown;
  valid_from: string;
  valid_to: string | null;
  supersedes: string | null;
  why: string | null;
  reopen_if: string | null;
}

/** JSON with object keys sorted at every depth, so the hash is stable across writers. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function assertionHash(body: CanonicalBody): string {
  return `sha256:${createHash("sha256").update(canonicalize(body), "utf8").digest("hex")}`;
}

export const sha256Hex = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");
