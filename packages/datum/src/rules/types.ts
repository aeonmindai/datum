import type { AssertInput } from "../domain/types.js";

/**
 * Enforcement-derived rules.
 *
 * The whole subsystem turns on one mechanical definition, taken from the design doc so that
 * `binding` is derivable instead of a judgement call:
 *
 *   > A rule is binding if violating it fails something. Otherwise it is advice.
 *
 * Everything here exists to answer that question about a specific line of a specific config file,
 * and to refuse to answer when it cannot point at one.
 */

/** Who wrote these rows. Kept as a constant so a re-run supersedes rather than duplicates. */
export const RULES_INSTRUMENT = "datum-rules/1";
export const RULES_ASSERTED_BY = `agent:${RULES_INSTRUMENT}`;

/**
 * The extractor label on unenforced-doctrine proposals. Namespaced away from the prose extractor:
 * `datum.proposals` is unique on (scope, subject, predicate, extractor, status), so two extractors
 * that disagree about the same claim coexist instead of one silently losing the insert.
 */
export const DOCTRINE_EXTRACTOR = "rules/doctrine-scan";

/**
 * How hard the prose is trying to be a rule. Ranked, because a report of 400 "must"s buries the
 * three "never"s that actually matter — and the "never"s are the ones that rot dangerously.
 */
export const DOCTRINE_STRENGTHS = ["absolute", "prohibition", "obligation"] as const;
export type DoctrineStrength = (typeof DOCTRINE_STRENGTHS)[number];

/**
 * A rule written in prose that nothing mechanically enforces.
 *
 * Deliberately NOT an assertion. Deciding that an imperative sentence is a real org rule is a
 * human's call, and an extractor that promoted its own readings into the record is precisely the
 * failure mode `datum.proposals` was built to contain.
 */
export interface UnenforcedFinding {
  /** The imperative sentence, unwrapped to a single line. */
  statement: string;
  /** `path:line` — the citation a reviewer checks. Always populated. */
  source: string;
  /** Repo-relative path of the document. */
  file: string;
  /** 1-based line of the sentence's first character. */
  line: number;
  /** Nearest enclosing markdown heading, so a reader knows which rule this belongs to. */
  heading: string | null;
  strength: DoctrineStrength;
  /** The word that made this imperative — the reason it was picked up at all. */
  marker: string;
  /**
   * The thing the imperative is actually about: the distinctive token nearest the marker.
   *
   * This, and not the whole token set, is what gets cross-checked. `never \`cudnn\`` sits in a
   * sentence that also says `--features "cuda flash-attn"`, and `cuda` does appear in CI — so
   * absolving the sentence because *some* token matched would silently declare the cudnn ban
   * enforced by the very command that builds without it.
   */
  target: string;
  /** Every distinctive token found, for a reviewer to judge the reading. */
  tokens: string[];
  /**
   * How strongly the surrounding document presents itself as rules: a file called `DOCTRINE.md`
   * under a heading "Hard invariants" is far likelier to be doctrine than the same sentence in a
   * session log. Used for ranking only — a low score is still reported, never dropped.
   */
  doctrinal: number;
  /** Other places the same sentence is written. A rule repeated six times and enforced nowhere. */
  also_at: string[];
  /** Why the conclusion is "nothing enforces this". */
  why: string;
}

export interface DeriveRulesOptions {
  /** Filesystem root of the repository to derive from. */
  dir: string;
  /** `owner/repo`, used for evidence and for the branch-protection lookup. */
  repo: string;
  scope: string;
  /**
   * Optional GitHub token. Branch protection is the only source that needs the network; without a
   * token it is skipped and the skip is recorded, never guessed at.
   */
  githubToken?: string | null;
}

export interface DeriveRulesResult {
  rules: AssertInput[];
  unenforced: UnenforcedFinding[];
  /** Every file (and API resource) that was actually read, repo-relative. */
  sources: string[];
}

/**
 * A rule candidate before it becomes an `AssertInput`.
 *
 * `locator` is mandatory and there is no code path that fills it in later: a rule that cannot name
 * the line enforcing it is not emitted at all, because "some config somewhere denies this" is the
 * kind of unfalsifiable claim this store exists to refuse.
 */
export interface RuleCandidate {
  subject: string;
  predicate: string;
  object: Record<string, unknown>;
  claim: string;
  kind: "rule" | "constraint";
  binding: boolean;
  /** `path:line`, or `api:...#pointer` for a GitHub API resource that has no file. */
  locator: string;
  /** The verbatim text at `locator`. Feeds the doctrine cross-check corpus. */
  enforcerText: string;
  /** Set when `binding` is false: what would have to be true for it to bind. */
  why?: string;
  /** A second locator that made a warning binding, e.g. the CI step passing `-D warnings`. */
  enforcedBy?: string;
}

/** Accumulates candidates and the files they came from, so every deriver looks the same. */
export class RuleSink {
  readonly candidates: RuleCandidate[] = [];
  readonly sources = new Set<string>();
  /** Locators rejected for having no line. Surfaced in tests rather than swallowed. */
  readonly dropped: Array<{ subject: string; predicate: string; reason: string }> = [];

  add(candidate: RuleCandidate): void {
    // The one gate that makes the acceptance criterion structural instead of aspirational.
    if (!hasLocator(candidate.locator)) {
      this.dropped.push({
        subject: candidate.subject,
        predicate: candidate.predicate,
        reason: `locator ${JSON.stringify(candidate.locator)} names no line`,
      });
      return;
    }
    this.candidates.push(candidate);
  }

  read(rel: string): void {
    this.sources.add(rel);
  }
}

/**
 * `path:123` for files; `api:<resource>#<pointer>` for the GitHub API, which has no file to cite.
 * The API form is admitted only because a branch-protection setting is the strongest enforcement
 * there is, and a pointer into a named resource is as checkable as a line number.
 */
export function hasLocator(locator: string): boolean {
  if (/^api:[^\s#]+#\S+$/.test(locator)) return true;
  return /^[^\s:][^:]*:\d+$/.test(locator);
}
