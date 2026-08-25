import { loadSource } from "./source.js";
import { RuleSink } from "./types.js";

/**
 * Ownership and branch protection — the two enforcement sources that live partly outside the repo.
 *
 * `CODEOWNERS` on its own is a routing table: GitHub uses it to request reviews, and a requested
 * review that nobody gives blocks nothing. It becomes a rule only when branch protection turns
 * "review requested" into "merge refused". So a CODEOWNERS line is emitted as advisory until
 * protection is read and says otherwise, and the assertion says which of the two it is.
 *
 * Branch protection is read over the network, and the network is allowed to be absent. The skip is
 * recorded as a source so the derivation is honest about what it could not see, and it never fails
 * the run — an unreachable API is not evidence of anything.
 */

const CODEOWNERS_PATHS = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];

export interface OwnershipContext {
  /** Job locators from the workflow deriver, so a required check can cite the job that defines it. */
  jobLocators: Record<string, string>;
  repo: string;
  githubToken?: string | null;
}

export interface BranchProtection {
  branch: string;
  /** True when protection requires at least one approving review. */
  requiresReview: boolean;
  requiredApprovals: number;
  requiresCodeOwnerReview: boolean;
  requiredChecks: string[];
  strictChecks: boolean;
  enforcesAdmins: boolean;
  requiresLinearHistory: boolean;
  allowsForcePushes: boolean;
  /** Present when protection could not be read. Nothing is inferred in that case. */
  unreadable?: string;
}

export interface OwnershipDerivation {
  protection: BranchProtection | null;
  /** Why protection was not read, when it was not. */
  skipped: string | null;
}

export async function deriveOwnershipRules(
  dir: string,
  sink: RuleSink,
  ctx: OwnershipContext,
): Promise<OwnershipDerivation> {
  // Protection first: whether a CODEOWNERS line binds depends on the answer.
  const { protection, skipped } = await readProtection(ctx);
  if (protection && !protection.unreadable) emitProtection(sink, protection, ctx);

  const ownersBind = protection?.requiresReview === true && protection.requiresCodeOwnerReview;

  for (const rel of CODEOWNERS_PATHS) {
    const file = loadSource(dir, rel);
    if (!file) continue;
    sink.read(rel);
    for (const [index, raw] of file.lines.entries()) {
      const line = raw.replace(/#.*$/, "").trim();
      if (line.length === 0) continue;
      const parts = line.split(/\s+/);
      const pattern = parts[0]!;
      const owners = parts.slice(1).filter((o) => o.startsWith("@") || o.includes("@"));
      if (owners.length === 0) continue;
      sink.add({
        subject: `ownership/${pattern}`,
        predicate: "owned_by",
        object: {
          pattern,
          owners,
          config: rel,
          requires_code_owner_review: protection?.requiresCodeOwnerReview ?? null,
          protected_branch: protection?.branch ?? null,
        },
        claim: `\`${pattern}\` is owned by ${owners.join(", ")}`,
        kind: "rule",
        binding: ownersBind,
        locator: `${rel}:${index + 1}`,
        enforcerText: raw.trim(),
        why: ownersBind
          ? undefined
          : skipped
            ? `branch protection was not read (${skipped}), so it is unknown whether a missing owner review blocks a merge`
            : "branch protection does not require code-owner review, so a requested review blocks nothing",
        enforcedBy: ownersBind ? `api:repos/${ctx.repo}/branches/${protection!.branch}/protection#required_pull_request_reviews.require_code_owner_reviews` : undefined,
      });
    }
  }

  return { protection, skipped };
}

function emitProtection(sink: RuleSink, protection: BranchProtection, ctx: OwnershipContext): void {
  const resource = `repos/${ctx.repo}/branches/${protection.branch}/protection`;
  sink.read(`api:${resource}`);

  // Each required check gets its own subject rather than one row holding an array. Same subject with
  // a different object would collide on invariant 3's (scope, subject, predicate) exclusion key the
  // moment the verification worker promoted these rows off `unverified`.
  for (const context of protection.requiredChecks) {
    const jobLocator = ctx.jobLocators[context];
    sink.add({
      subject: `branch/${ctx.repo}/${protection.branch}/check/${context}`,
      predicate: "required",
      object: {
        repo: ctx.repo,
        branch: protection.branch,
        check: context,
        strict: protection.strictChecks,
        defined_at: jobLocator ?? null,
      },
      claim: `\`${context}\` must pass before anything merges to \`${protection.branch}\``,
      kind: "rule",
      binding: true,
      // Prefer the workflow line that defines the job: a required check whose citation is the job
      // itself is checkable by reading the repo, which an API pointer alone is not.
      locator: jobLocator ?? `api:${resource}#required_status_checks.contexts`,
      enforcerText: `required status check: ${context}`,
      enforcedBy: `api:${resource}#required_status_checks.contexts`,
    });
  }

  const facts: Array<{ predicate: string; value: unknown; pointer: string; claim: string; binding: boolean }> = [
    {
      predicate: "requires_review",
      value: { approvals: protection.requiredApprovals, code_owner_review: protection.requiresCodeOwnerReview },
      pointer: "required_pull_request_reviews",
      claim: `merging to \`${protection.branch}\` requires ${protection.requiredApprovals} approving review(s)`,
      binding: protection.requiresReview,
    },
    {
      predicate: "enforces_admins",
      value: protection.enforcesAdmins,
      pointer: "enforce_admins.enabled",
      claim: protection.enforcesAdmins
        ? `protection on \`${protection.branch}\` applies to administrators too`
        : `administrators can bypass protection on \`${protection.branch}\``,
      binding: protection.enforcesAdmins,
    },
    {
      predicate: "requires_linear_history",
      value: protection.requiresLinearHistory,
      pointer: "required_linear_history.enabled",
      claim: `\`${protection.branch}\` ${protection.requiresLinearHistory ? "requires" : "does not require"} linear history`,
      binding: protection.requiresLinearHistory,
    },
    {
      predicate: "allows_force_push",
      value: protection.allowsForcePushes,
      pointer: "allow_force_pushes.enabled",
      claim: `force pushes to \`${protection.branch}\` are ${protection.allowsForcePushes ? "allowed" : "refused"}`,
      binding: !protection.allowsForcePushes,
    },
  ];

  for (const fact of facts) {
    sink.add({
      subject: `branch/${ctx.repo}/${protection.branch}`,
      predicate: fact.predicate,
      object: { repo: ctx.repo, branch: protection.branch, value: fact.value },
      claim: fact.claim,
      kind: "constraint",
      binding: fact.binding,
      locator: `api:${resource}#${fact.pointer}`,
      enforcerText: `${fact.pointer} = ${JSON.stringify(fact.value)}`,
      why: fact.binding ? undefined : "the setting is off, so nothing is enforced by it",
    });
  }
}

/**
 * Read branch protection for the repo's default branch.
 *
 * Requires a token with admin rights on the repo — the endpoint 404s otherwise, and a 404 here is
 * indistinguishable from "no protection configured". That ambiguity is reported rather than resolved
 * by assumption: claiming a branch is unprotected because we were not allowed to look is exactly the
 * confident-but-unsupported answer this store exists to refuse.
 */
async function readProtection(
  ctx: OwnershipContext,
): Promise<{ protection: BranchProtection | null; skipped: string | null }> {
  if (!ctx.githubToken) {
    return { protection: null, skipped: "no github token supplied" };
  }
  if (!/^[^/]+\/[^/]+$/.test(ctx.repo)) {
    return { protection: null, skipped: `repo ${JSON.stringify(ctx.repo)} is not owner/name` };
  }

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${ctx.githubToken}`,
    "user-agent": "datum-rules",
    "x-github-api-version": "2022-11-28",
  };

  try {
    const repoResponse = await fetch(`https://api.github.com/repos/${ctx.repo}`, { headers });
    if (!repoResponse.ok) {
      return { protection: null, skipped: `GET /repos/${ctx.repo} returned ${repoResponse.status}` };
    }
    const repoBody = (await repoResponse.json()) as { default_branch?: unknown };
    const branch = typeof repoBody.default_branch === "string" ? repoBody.default_branch : "main";

    const url = `https://api.github.com/repos/${ctx.repo}/branches/${encodeURIComponent(branch)}/protection`;
    const response = await fetch(url, { headers });
    if (response.status === 404) {
      return {
        protection: null,
        skipped: `branch ${branch} reports no protection, or the token lacks admin rights (404 is both)`,
      };
    }
    if (!response.ok) {
      return { protection: null, skipped: `GET ${url} returned ${response.status}` };
    }
    const body = (await response.json()) as ProtectionResponse;
    const reviews = body.required_pull_request_reviews;
    return {
      protection: {
        branch,
        requiresReview: reviews !== undefined && reviews !== null,
        requiredApprovals: Number(reviews?.required_approving_review_count ?? 0),
        requiresCodeOwnerReview: reviews?.require_code_owner_reviews === true,
        requiredChecks: Array.isArray(body.required_status_checks?.contexts)
          ? body.required_status_checks!.contexts.filter((c): c is string => typeof c === "string")
          : [],
        strictChecks: body.required_status_checks?.strict === true,
        enforcesAdmins: body.enforce_admins?.enabled === true,
        requiresLinearHistory: body.required_linear_history?.enabled === true,
        allowsForcePushes: body.allow_force_pushes?.enabled === true,
      },
      skipped: null,
    };
  } catch (err) {
    // Offline, DNS failure, proxy refusal: none of these are facts about the repository.
    return { protection: null, skipped: `github api unreachable: ${(err as Error).message}` };
  }
}

interface ProtectionResponse {
  required_status_checks?: { strict?: boolean; contexts?: unknown[] } | null;
  required_pull_request_reviews?: {
    required_approving_review_count?: number;
    require_code_owner_reviews?: boolean;
  } | null;
  enforce_admins?: { enabled?: boolean } | null;
  required_linear_history?: { enabled?: boolean } | null;
  allow_force_pushes?: { enabled?: boolean } | null;
}
