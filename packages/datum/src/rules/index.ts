import type { AssertInput } from "../domain/types.js";
import { resolveHeadCommit } from "./source.js";
import { deriveWorkflowRules } from "./workflows.js";
import { deriveLintRules } from "./lint.js";
import { deriveOwnershipRules } from "./ownership.js";
import { deriveManifestRules } from "./manifests.js";
import { scanDoctrine } from "./doctrine.js";
import {
  RULES_ASSERTED_BY,
  RULES_INSTRUMENT,
  RuleSink,
  type DeriveRulesOptions,
  type DeriveRulesResult,
  type RuleCandidate,
} from "./types.js";

export { registerRulesRoutes, persistUnenforced } from "./routes.js";
export {
  DOCTRINE_EXTRACTOR,
  DOCTRINE_STRENGTHS,
  RULES_ASSERTED_BY,
  RULES_INSTRUMENT,
  hasLocator,
  type DoctrineStrength,
  type UnenforcedFinding,
  type DeriveRulesOptions,
  type DeriveRulesResult,
} from "./types.js";
export { scanDoctrine, distinctiveTokens, type DoctrineScan } from "./doctrine.js";
export { strongestEnforcement, type ToolEnforcement } from "./lint.js";
export type { CiEscalation } from "./workflows.js";
export type { BranchProtection } from "./ownership.js";

/**
 * Derive the org's rules from the things that enforce them.
 *
 * Order matters and is not arbitrary. Workflows run first because a CI invocation decides what a
 * lint config *means* — `cargo clippy -- -D warnings` is the difference between a warn-level lint
 * being a rule and being a suggestion. Branch protection runs before CODEOWNERS for the same
 * reason: an ownership line only binds if a missing owner review refuses a merge. The doctrine scan
 * runs last, because it cross-checks against everything the earlier passes derived.
 *
 * Everything lands as `unverified`. An agent may not assert `measured` — the verification worker
 * earns that, and it can only do so if `evidence.commit` is present, which is why HEAD is read
 * straight out of `.git` rather than left blank.
 */
export async function deriveRules(opts: DeriveRulesOptions): Promise<DeriveRulesResult> {
  const sink = new RuleSink();

  const { escalations, jobLocators } = deriveWorkflowRules(opts.dir, sink);
  const ownership = await deriveOwnershipRules(opts.dir, sink, {
    jobLocators,
    repo: opts.repo,
    githubToken: opts.githubToken ?? null,
  });
  deriveLintRules(opts.dir, sink, escalations);
  deriveManifestRules(opts.dir, sink);

  const deduped = dedupe(sink.candidates);
  const doctrine = scanDoctrine({ dir: opts.dir }, deduped);
  const commit = resolveHeadCommit(opts.dir);

  const sources = [...sink.sources, ...doctrine.sources];
  if (ownership.skipped) sources.push(`skipped:branch-protection (${ownership.skipped})`);

  return {
    rules: deduped.map((candidate) => toAssertion(candidate, opts, commit, ownership.skipped)),
    unenforced: doctrine.findings,
    sources: [...new Set(sources)].sort(),
  };
}

/**
 * Collapse candidates that share `(subject, predicate)`.
 *
 * Invariant 3's exclusion constraint refuses two live rows with the same scope, subject and
 * predicate over overlapping validity once confidence reaches `measured`. Two workflows can
 * legitimately define a job of the same name, or the same lint can be set in two configs, so the
 * collision is real. Dropping the second silently would lose a genuine enforcement site, so the
 * extra locators are folded into the survivor's evidence as `also_at`.
 */
function dedupe(candidates: readonly RuleCandidate[]): RuleCandidate[] {
  const byKey = new Map<string, RuleCandidate>();
  const extras = new Map<string, string[]>();
  for (const candidate of candidates) {
    const key = `${candidate.subject}\u0000${candidate.predicate}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }
    extras.set(key, [...(extras.get(key) ?? []), candidate.locator]);
    // The stronger claim wins: if any site makes this binding, it is binding, and the site that
    // does the binding is the one worth citing.
    if (candidate.binding && !existing.binding) {
      byKey.set(key, candidate);
    }
  }
  const out: RuleCandidate[] = [];
  for (const [key, candidate] of byKey) {
    const also = extras.get(key);
    out.push(also ? { ...candidate, object: { ...candidate.object, also_at: also } } : candidate);
  }
  return out;
}

function toAssertion(
  candidate: RuleCandidate,
  opts: DeriveRulesOptions,
  commit: string | null,
  protectionSkipped: string | null,
): AssertInput {
  return {
    scope: opts.scope,
    subject: candidate.subject,
    predicate: candidate.predicate,
    object: candidate.object,
    claim: candidate.claim,
    kind: candidate.kind,
    binding: candidate.binding,
    // An agent may only write `unverified` or `confirmed-by-human`. Reading a config file is not
    // measurement: the file could describe a workflow nobody runs, and only the verification worker
    // is allowed to promote the row once its commit resolves.
    confidence: "unverified",
    evidence: {
      source: candidate.locator,
      repo: opts.repo,
      commit: commit ?? undefined,
      instrument: RULES_INSTRUMENT,
      // The mechanical definition, restated per row so the answer to "why is this binding" never
      // requires reading this file.
      protocol: "binding iff violating it fails something",
      enforced_by: candidate.enforcedBy,
      branch_protection_unread: protectionSkipped ?? undefined,
    },
    asserted_by: RULES_ASSERTED_BY,
    why: candidate.why,
  };
}
