import type { Kind } from "../domain/types.js";

/**
 * Facts read off an artifact rather than typed in by a person.
 *
 * The M2 benchmark failed on coverage, not correctness: three of its four misses were facts
 * nobody had ever asserted. The cheap repair is to type those three in, which teaches to the
 * test and makes the score mean nothing. This subsystem is the other repair — grow coverage
 * mechanically, from artifacts already on disk, so the machinery would equally have covered
 * facts nobody thought to ask about.
 *
 * The line this holds, and the reason it is not the prose extractor: an artifact read here is
 * *machine-authored and machine-checkable*. A `static_assert` is not somebody's opinion about
 * what the code does; the build fails if it is false. That is why these land as assertions at
 * all, and it is exactly why episode text and markdown never do.
 */

/** What an instrument may claim. Deliberately narrower than `Kind`; see `INSTRUMENT_KINDS`. */
export type InstrumentKind = Extract<Kind, "state" | "constraint">;

/**
 * Why only these two.
 *
 * `measured` would be a lie: reading `opt-level = 3` out of a manifest measures nothing, and a
 * store that labels a file read as a measurement has given up the distinction it exists to keep.
 * `rule` belongs to `src/rules`, which already derives org rules from enforcement and would
 * collide here. `target`, `untried`, `failed` and `dead` all require intent no artifact carries.
 *
 * That leaves the true dichotomy for a value written in a file:
 *
 * - `constraint` — the artifact declares every other value invalid, and something fails if one
 *   appears. `static_assert(HEAD_SIZE == 128)` does not compile otherwise; `assert page_size ==
 *   256` does not run otherwise; `timeout-minutes: 20` kills the job at 20.
 * - `state` — the artifact records what the value is at this commit, and nothing refuses a
 *   different one. `const CACHE_GROW_SIZE: usize = 512;` is true today and a commit may change
 *   it tomorrow without anything breaking.
 *
 * The test for `constraint` is the same mechanical one `src/rules` uses for `binding`: violating
 * it fails something.
 */
export const INSTRUMENT_KINDS: readonly InstrumentKind[] = ["state", "constraint"];

export interface InstrumentFact {
  subject: string;
  predicate: string;
  object: Record<string, unknown>;
  claim: string;
  evidence: Record<string, unknown> & { source: string };
  /**
   * Not in the original sketch of this interface, and required: without it every fact would have
   * to share one kind, which would make at least half of them untrue. See `INSTRUMENT_KINDS`.
   */
  kind: InstrumentKind;
  /** Violating this fails something. True for every `constraint`, false for every `state`. */
  binding: boolean;
}

/** Who wrote these rows. A constant, so a re-run is recognised as a duplicate rather than a peer. */
export const INSTRUMENT = "datum-instruments/1";
export const INSTRUMENT_ASSERTED_BY = `agent:${INSTRUMENT}`;

/**
 * `evidence.commit_time` — the commit's own committer date, ISO-8601.
 *
 * This is load-bearing for idempotency, not decoration. `assertionHash` covers `valid_from`, so
 * a fact stamped with `new Date()` hashes differently on every run and each run appends a fresh
 * row. That is the mem0 failure mode with a different trigger: 808 copies of one claim, produced
 * by a loop nobody thought was a loop. Pinning `valid_from` to the commit date makes "read the
 * same commit twice" hash-identical, so the second run is a duplicate by construction.
 */
export const COMMIT_TIME = "commit_time";

/** A candidate before the reader has folded duplicate sites into it. */
export interface FactCandidate {
  subject: string;
  predicate: string;
  object: Record<string, unknown>;
  claim: string;
  kind: InstrumentKind;
  binding: boolean;
  /** `path:line`. An instrument that cannot cite one emits nothing. */
  locator: string;
}
