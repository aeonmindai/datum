import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "../db/pool.js";
import { Rejection } from "../domain/errors.js";
import { assertFact } from "../domain/store.js";
import { readPinnedFacts } from "./pinned.js";
import { readTunableFacts } from "./tunables.js";
import {
  COMMIT_TIME,
  INSTRUMENT,
  type FactCandidate,
  type InstrumentFact,
} from "./types.js";

export {
  COMMIT_TIME,
  INSTRUMENT,
  INSTRUMENT_ASSERTED_BY,
  INSTRUMENT_KINDS,
  type InstrumentFact,
  type InstrumentKind,
} from "./types.js";

const exec = promisify(execFile);

/**
 * Reading facts off artifacts, and refusing to write the ones that cannot be trusted.
 *
 * M2's store-only arm scored 90.9% against a 94.4% bar with **zero wrong answers**. It lost on
 * coverage: three of four misses were facts nobody had asserted. This is the mechanical route to
 * coverage — read what the repo already states about itself — and its whole value depends on not
 * becoming the prose extractor. Two rules hold that line:
 *
 * 1. Every fact cites `file:line` in `evidence.source`, and one that cannot is not emitted.
 * 2. Nothing is `measured` and nothing is `derived`. Reading a file is not measuring; the
 *    verification worker promotes a row once `evidence.commit` resolves, and it is the only
 *    thing that may. The database enforces this independently, and `ingestInstrumentFacts`
 *    reports the constraint name when it fires rather than paraphrasing it.
 */

export interface ReadConfigOptions {
  /** Repository root. Read-only; nothing here writes to the tree. */
  dir: string;
  /** `owner/name`, recorded so the verification worker knows where to resolve the commit. */
  repo: string;
  /** The commit these facts describe. Its committer date becomes `valid_from`. */
  commitSha: string;
}

/**
 * Every fact the readers can find, stamped with the commit they describe.
 *
 * One call describes one repository at one commit. Arc's reference corpus is 53 separate git
 * checkouts behind `research/code` — SGLang, vLLM, FlashInfer and the rest — each at its own
 * pinned commit, so covering those means one call each with that repo's own sha. Passing Arc's
 * sha for a fact read out of SGLang's tree would produce evidence that can never resolve, and a
 * row the worker must refuse forever.
 */
export async function readConfigFacts(opts: ReadConfigOptions): Promise<InstrumentFact[]> {
  // The committer date, which becomes `valid_from`. Shelling out to git as `src/worker/git.ts`
  // does: the date lives in a commit object that may be loose or inside a packfile, and
  // reimplementing zlib and packfile indexing to avoid one exec is the worse trade. Null when git
  // cannot answer — never the wall clock, for the reason `COMMIT_TIME` documents.
  let commitTime: string | null = null;
  try {
    const { stdout } = await exec("git", ["-C", opts.dir, "show", "-s", "--format=%cI", opts.commitSha], {
      timeout: 20_000,
    });
    const iso = stdout.trim().split("\n")[0] ?? "";
    if (iso.length > 0 && Number.isFinite(new Date(iso).getTime())) commitTime = iso;
  } catch {
    commitTime = null;
  }

  const candidates = dedupe([...readPinnedFacts(opts.dir), ...readTunableFacts(opts.dir)]);

  return candidates.map((candidate) => {
    const path = candidate.object.file ?? candidate.object.workflow ?? null;
    return {
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      claim: candidate.claim,
      kind: candidate.kind,
      binding: candidate.binding,
      evidence: {
        source: candidate.locator,
        repo: opts.repo,
        commit: opts.commitSha,
        path: typeof path === "string" ? path : null,
        instrument: INSTRUMENT,
        protocol: "read from the artifact at this commit; not executed, not measured",
        ...(commitTime === null ? {} : { [COMMIT_TIME]: commitTime }),
      },
    };
  });
}

/**
 * Fold sites that state the identical fact, and keep sites that disagree apart.
 *
 * SGLang asserts `page_size == 64` at four lines of one file. That is one fact with four
 * citations, so the extras become `also_at` — the convention `src/rules/index.ts` already uses.
 * Two sites claiming *different* values for the same subject are not folded: they survive as
 * separate candidates so `ingestInstrumentFacts` refuses the second out loud. A reader that
 * silently kept the first would be choosing between two truths by file order.
 */
function dedupe(candidates: readonly FactCandidate[]): FactCandidate[] {
  const byKey = new Map<string, { candidate: FactCandidate; also: string[] }>();

  for (const candidate of candidates) {
    const key = `${candidate.subject}\u0000${candidate.predicate}\u0000${String(candidate.object.value)}`;
    const existing = byKey.get(key);
    if (existing) existing.also.push(candidate.locator);
    else byKey.set(key, { candidate, also: [] });
  }

  return [...byKey.values()].map(({ candidate, also }) =>
    also.length > 0 ? { ...candidate, object: { ...candidate.object, also_at: also } } : candidate,
  );
}

export interface IngestOptions {
  scope: string;
  facts: readonly InstrumentFact[];
  assertedBy: string;
}

export interface IngestResult {
  asserted: number;
  /** Already on record with identical content. A re-run at the same commit is all duplicates. */
  duplicates: number;
  /** Every fact not written, with the reason. Never silently dropped. */
  refused: Array<{ subject: string; reason: string }>;
}

/**
 * Write instrument facts, at `unverified`, or say why not.
 *
 * `confidence` is never set. `assertFact` defaults it to `unverified`, and that default is the
 * correct value for a file read — so the argument is omitted rather than passed explicitly, which
 * keeps this function unable to request `measured` even by accident. If it did, the database's
 * `confidence_is_earned` trigger would refuse the insert, and that refusal would arrive here as a
 * `Rejection` and be reported under its constraint name like any other.
 */
export async function ingestInstrumentFacts(db: Db, opts: IngestOptions): Promise<IngestResult> {
  const result: IngestResult = { asserted: 0, duplicates: 0, refused: [] };
  const seen = new Set<string>();

  for (const fact of opts.facts) {
    const commitTime = fact.evidence[COMMIT_TIME];
    if (typeof commitTime !== "string" || commitTime.length === 0) {
      // Without a fixed `valid_from` the content hash moves every run, so re-reading the same
      // commit would append rather than deduplicate. Refusing is the only outcome that keeps
      // "re-running is idempotent" true rather than approximately true.
      result.refused.push({ subject: fact.subject, reason: "no_commit_time" });
      continue;
    }
    if (!/:\d+$/.test(fact.evidence.source)) {
      // The verification worker resolves `evidence.commit` against the repo and checks the claim
      // is where it says it is. A source with no line is unresolvable, so the row could never be
      // promoted and would sit at `unverified` forever, indistinguishable from a guess.
      result.refused.push({ subject: fact.subject, reason: "no_locator" });
      continue;
    }

    const key = `${fact.subject}\u0000${fact.predicate}`;
    if (seen.has(key)) {
      result.refused.push({ subject: fact.subject, reason: "conflicting_value_in_batch" });
      continue;
    }
    seen.add(key);

    try {
      const { created } = await assertFact(db, {
        scope: opts.scope,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        claim: fact.claim,
        kind: fact.kind,
        binding: fact.binding,
        evidence: { ...fact.evidence, source: fact.evidence.source },
        valid_from: commitTime,
        asserted_by: opts.assertedBy,
      });
      if (created) result.asserted++;
      else result.duplicates++;
    } catch (err) {
      // The constraint name, not a paraphrase of it. `Rejection.reason` is what Postgres reported.
      if (err instanceof Rejection) {
        result.refused.push({ subject: fact.subject, reason: err.reason });
        continue;
      }
      throw err;
    }
  }

  return result;
}
