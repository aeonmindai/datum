import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";

const exec = promisify(execFile);

/**
 * The local end of `datum link`.
 *
 * Many worktrees of one repo are **one project with many nodes**, not many projects. So the
 * project identity comes from the git remote, and the worktree contributes a node — which is
 * what turns "141 worktrees" from a forensic exercise into a query.
 */

export interface ProjectFile {
  scope: string;
  server: string;
  key_env?: string;
  repo?: string;
  node_id?: string;
}

export const PROJECT_FILE = ".datum.toml";

/** A deliberately tiny reader for a file this tool is the only writer of. Bringing in a TOML
 *  parser to read four flat string keys would be the wrong trade. */
export function parseProjectFile(text: string): Partial<ProjectFile> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out as Partial<ProjectFile>;
}

export function renderProjectFile(p: ProjectFile): string {
  return [
    "# Written by `datum link`. Safe to commit: it contains no secret.",
    "# The API key is read from the environment variable named by key_env.",
    "",
    `scope = "${p.scope}"`,
    `server = "${p.server}"`,
    `key_env = "${p.key_env ?? "DATUM_KEY"}"`,
    ...(p.repo ? [`repo = "${p.repo}"`] : []),
    ...(p.node_id ? [`node_id = "${p.node_id}"`] : []),
    "",
  ].join("\n");
}

export async function readProjectFile(dir = process.cwd()): Promise<Partial<ProjectFile> | null> {
  try {
    return parseProjectFile(await readFile(resolve(dir, PROJECT_FILE), "utf8"));
  } catch {
    return null;
  }
}

export async function writeProjectFile(p: ProjectFile, dir = process.cwd()): Promise<string> {
  const path = resolve(dir, PROJECT_FILE);
  await writeFile(path, renderProjectFile(p), "utf8");
  return path;
}

export interface GitIdentity {
  remote: string | null;
  /** "owner/repo", when the remote is recognisable. */
  repo: string | null;
  /** The project label: the repo name, lowercased and scope-safe. */
  project: string | null;
  branch: string | null;
  head: string | null;
  worktree: string;
  dirty: boolean;
}

export async function gitIdentity(dir = process.cwd()): Promise<GitIdentity> {
  const git = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await exec("git", ["-C", dir, ...args], { timeout: 10_000 });
      return stdout.trim();
    } catch {
      return null;
    }
  };

  const remote = await git(["remote", "get-url", "origin"]);
  let repo: string | null = null;
  if (remote) {
    // git@host:owner/repo.git | https://host/owner/repo(.git) | ssh://git@host/owner/repo
    const cleaned = remote.replace(/\.git$/, "");
    const match = /[:/]([^/:]+)\/([^/]+)$/.exec(cleaned);
    if (match) repo = `${match[1]}/${match[2]}`;
  }
  const project = repo
    ? repo.split("/")[1]!.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")
    : null;

  return {
    remote,
    repo,
    project,
    branch: await git(["rev-parse", "--abbrev-ref", "HEAD"]),
    head: await git(["rev-parse", "HEAD"]),
    worktree: (await git(["rev-parse", "--show-toplevel"])) ?? dir,
    dirty: ((await git(["status", "--porcelain"])) ?? "") !== "",
  };
}
