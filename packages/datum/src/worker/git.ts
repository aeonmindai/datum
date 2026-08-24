import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);

/**
 * Resolving an evidence commit against reality.
 *
 * Two paths, in this order: a local clone if one is configured for the repo, then the GitHub
 * API. If neither can answer, the outcome is `unresolvable` and nothing is promoted — which is
 * the whole point. A verification worker that guesses is worse than no worker, because it
 * launders unverified claims into `measured` ones.
 */

export interface ContainmentCheck {
  /**
   * Could we see the repository at all?
   *
   * This is the difference between "we looked and the commit is not there" and "we were not
   * allowed to look", and conflating them is how a truth store starts telling lies. GitHub
   * answers 404 for a private repo you cannot read, which is byte-identical to 404 for a
   * commit that does not exist — so a claim about a private repo would be marked `refuted`,
   * i.e. actively false, when the honest answer is that we do not know. Only a check with
   * `readable: true` may ever produce a refutation.
   */
  readable: boolean;
  /**
   * The repository's default branch, and whether the commit has actually landed on it.
   *
   * This exists because of a failure reproduced during this project's own construction. Arc's
   * headline measurement — 757.5 tok/s — sits on a commit 21 ahead of `master` on an unmerged
   * release branch. Datum verified it, promoted it to `measured`, and then read back
   * indistinguishably from a number that had shipped. A brief written from that output quoted
   * branch-only work as mainline, which is exactly the failure that cost Arc three sessions.
   *
   * The measurement is real, so refusing it would be wrong. What was missing is that a claim's
   * containment is part of what the claim MEANS: "757.5 on release/openrouter-ready" and "757.5 on
   * master" are different facts, and only one of them describes the product.
   */
  default_branch: string | null;
  on_default_branch: boolean | null;
  /** Does the commit resolve to a commit object at all? */
  exists: boolean;
  /** For each ref the evidence claims contains it: does it actually? */
  contained: Record<string, boolean>;
  method: "local-mirror" | "github-api" | "none";
  detail: Record<string, unknown>;
}

export const UNRESOLVABLE: ContainmentCheck = {
  readable: false,
  default_branch: null,
  on_default_branch: null,
  exists: false,
  contained: {},
  method: "none",
  detail: {
    reason: "no_verification_path",
    says:
      "No local clone is configured for this repo and no GitHub token is set, so the commit " +
      "cannot be resolved. Nothing is promoted on an unresolved claim.",
  },
};

export async function checkViaLocalClone(
  dir: string,
  commit: string,
  containedIn: readonly string[],
): Promise<ContainmentCheck> {
  const git = (args: string[]) => exec("git", ["-C", dir, ...args], { timeout: 20_000 });

  // A path that is missing, or is not a git repository, means we cannot see the repo — not that
  // the commit is absent from it. Without this the worker would refute every claim about a repo
  // whose mirror had simply been moved.
  let readable = false;
  try {
    await git(["rev-parse", "--git-dir"]);
    readable = true;
  } catch {
    return {
      readable: false,
      default_branch: null,
      on_default_branch: null,
      exists: false,
      contained: {},
      method: "local-mirror",
      detail: {
        dir,
        reason: "mirror_unreadable",
        says: `${dir} is not a readable git repository, so this claim cannot be checked here.`,
      },
    };
  }

  // The repo's own opinion of its default branch, not a guess. `origin/HEAD` is what the remote
  // says; the fallbacks only run when nobody ever set it.
  let defaultBranch: string | null = null;
  try {
    const { stdout } = await git(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    defaultBranch = stdout.trim().replace(/^refs\/remotes\/origin\//, "") || null;
  } catch {
    for (const guess of ["origin/main", "origin/master", "main", "master"]) {
      try {
        await git(["rev-parse", "--verify", "--quiet", guess]);
        defaultBranch = guess.replace(/^origin\//, "");
        break;
      } catch {
        // keep looking
      }
    }
  }

  let exists = false;
  try {
    const { stdout } = await git(["cat-file", "-t", `${commit}^{commit}`]);
    exists = stdout.trim() === "commit";
  } catch {
    exists = false;
  }

  const contained: Record<string, boolean> = {};
  const containedVia: Record<string, string | null> = {};
  if (exists) {
    for (const ref of containedIn) {
      // "contained in R" is a question about the *shared* repo, not about this checkout. A local
      // branch can be stale, reset or rewritten, so a local `release/x` saying "no" while
      // `origin/release/x` says "yes" is not a refutation — it is a stale local branch. So every
      // spelling of the same branch name is tried and the answers are OR-ed, and the ref that
      // actually answered is recorded so the verification stays auditable.
      //
      // `merge-base --is-ancestor` exits 0 when the commit is reachable from the ref, 1 when it
      // is not, and 128 when the ref does not resolve. Those three must not be conflated.
      const candidates = [
        `refs/remotes/origin/${ref}`,
        `origin/${ref}`,
        `refs/heads/${ref}`,
        ref,
      ];
      let via: string | null = null;
      for (const candidate of candidates) {
        try {
          await git(["merge-base", "--is-ancestor", commit, candidate]);
          via = candidate;
          break;
        } catch {
          // Not an ancestor, or the ref does not exist here. Either way, try the next spelling.
        }
      }
      contained[ref] = via !== null;
      containedVia[ref] = via;
    }
  }

  // Is it actually on the default branch? Asked separately from the claimed refs, because the
  // evidence naming `release/openrouter-ready` is not the same statement as the work having landed.
  let onDefault: boolean | null = null;
  if (exists && defaultBranch) {
    onDefault = false;
    for (const candidate of [`refs/remotes/origin/${defaultBranch}`, `origin/${defaultBranch}`,
                             `refs/heads/${defaultBranch}`, defaultBranch]) {
      try {
        await git(["merge-base", "--is-ancestor", commit, candidate]);
        onDefault = true;
        break;
      } catch {
        // keep trying spellings; a missing ref is not an answer
      }
    }
  }

  return {
    readable,
    default_branch: defaultBranch,
    on_default_branch: onDefault,
    exists,
    contained,
    method: "local-mirror",
    detail: { dir, contained_via: containedVia },
  };
}

/** GitHub's compare payload, narrowed to the two fields the containment answer needs. */
const CompareResponse = z.object({
  status: z.enum(["diverged", "ahead", "behind", "identical"]).optional(),
  ahead_by: z.number().optional(),
  behind_by: z.number().optional(),
});

/** The repo probe is already being made to establish readability; the default branch comes free. */
const RepoResponse = z.object({ default_branch: z.string().optional() });

export async function checkViaGitHub(
  repo: string,
  commit: string,
  containedIn: readonly string[],
  token: string | null,
): Promise<ContainmentCheck> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "datum-verification-worker",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const get = async (path: string): Promise<{ status: number; json: unknown }> => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, json };
  };

  // Ask about the REPOSITORY first. GitHub returns 404 for a repository you are not allowed to
  // see, which is byte-identical to 404 for a repository that does not exist — and a 404 on the
  // commit inside an invisible repo would otherwise be read as "this commit is not real".
  // Confirming we can read the repo is what earns the right to refute anything about it.
  const repoProbe = await get(`/repos/${repo}`);
  const readable = repoProbe.status === 200;
  const detail: Record<string, unknown> = {
    repo_status: repoProbe.status,
    authenticated: token !== null,
  };

  if (!readable) {
    detail.reason = "repo_unreadable";
    detail.says =
      repoProbe.status === 404
        ? `GitHub returns 404 for ${repo}. That means either it does not exist or this instance ` +
          `cannot see it, and those are indistinguishable over the API — so this is unresolvable, ` +
          `not refuted.` +
          (token ? "" : " No DATUM_GITHUB_TOKEN is set; a private repo needs one.")
        : `GitHub answered ${repoProbe.status} for ${repo}, so the claim cannot be checked.`;
    return {
      readable: false,
      default_branch: null,
      on_default_branch: null,
      exists: false,
      contained: {},
      method: "github-api",
      detail,
    };
  }

  const head = await get(`/repos/${repo}/commits/${encodeURIComponent(commit)}`);
  const exists = head.status === 200;
  const contained: Record<string, boolean> = {};
  detail.commit_status = head.status;

  if (exists) {
    for (const ref of containedIn) {
      // compare base...head: when `head` is an ancestor of `base`, GitHub reports the commit
      // as "behind" (or "identical"), with ahead_by 0. That is the containment answer.
      const cmp = await get(
        `/repos/${repo}/compare/${encodeURIComponent(ref)}...${encodeURIComponent(commit)}`,
      );
      const parsed = CompareResponse.safeParse(cmp.json);
      const relation = parsed.success ? parsed.data : null;
      contained[ref] =
        cmp.status === 200 && (relation?.status === "behind" || relation?.status === "identical");
      detail[`compare:${ref}`] = {
        http: cmp.status,
        relation: relation?.status ?? null,
        ahead_by: relation?.ahead_by ?? null,
      };
    }
  }

  // The claimed refs answer "is it where they said". This answers the different and more
  // consequential question: has it actually landed on the branch that defines the product?
  const repoMeta = RepoResponse.safeParse(repoProbe.json);
  const defaultBranch = repoMeta.success ? (repoMeta.data.default_branch ?? null) : null;
  let onDefault: boolean | null = null;
  if (exists && defaultBranch) {
    const cmp = await get(
      `/repos/${repo}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(commit)}`,
    );
    const rel = CompareResponse.safeParse(cmp.json);
    const relation = rel.success ? rel.data : null;
    onDefault =
      cmp.status === 200 && (relation?.status === "behind" || relation?.status === "identical");
    detail[`compare:${defaultBranch} (default)`] = {
      http: cmp.status,
      relation: relation?.status ?? null,
      ahead_by: relation?.ahead_by ?? null,
    };
  }

  return {
    readable,
    default_branch: defaultBranch,
    on_default_branch: onDefault,
    exists,
    contained,
    method: "github-api",
    detail,
  };
}
