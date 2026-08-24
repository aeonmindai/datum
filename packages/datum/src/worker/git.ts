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
  /** Does the commit resolve to a commit object at all? */
  exists: boolean;
  /** For each ref the evidence claims contains it: does it actually? */
  contained: Record<string, boolean>;
  method: "local-mirror" | "github-api" | "none";
  detail: Record<string, unknown>;
}

export const UNRESOLVABLE: ContainmentCheck = {
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

  return { exists, contained, method: "local-mirror", detail: { dir, contained_via: containedVia } };
}

/** GitHub's compare payload, narrowed to the two fields the containment answer needs. */
const CompareResponse = z.object({
  status: z.enum(["diverged", "ahead", "behind", "identical"]).optional(),
  ahead_by: z.number().optional(),
  behind_by: z.number().optional(),
});

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

  const head = await get(`/repos/${repo}/commits/${encodeURIComponent(commit)}`);
  const exists = head.status === 200;
  const contained: Record<string, boolean> = {};
  const detail: Record<string, unknown> = { commit_status: head.status };

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

  return { exists, contained, method: "github-api", detail };
}
