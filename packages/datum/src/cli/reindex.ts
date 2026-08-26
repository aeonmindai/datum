import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import { indexRepo } from "../index/index.js";
import { readProjectFile } from "./project.js";

const exec = promisify(execFile);
const deflate = promisify(gzip);

/**
 * Keeping the code graph current without anybody remembering to.
 *
 * The graph was correct as of whatever commit somebody last indexed by hand, and every answer said
 * so — which is honest and still useless, because the moment after a commit the honest answer is
 * "I describe code you no longer have". Measured on the real repository: a typical commit changes 2
 * files of 965, so the map is wrong about 2 files and right about 963, and nothing tells you which.
 *
 * Two things had to be true before automating it, and neither was:
 *
 *   - a hook cannot reach a deployed instance's database, so refreshing had to become an HTTP call
 *   - indexing every commit without retention writes 27 GB a month and fills the volume in 11 days
 *
 * So this posts an artifact over HTTP with an ordinary API key, and the server prunes. The hook that
 * calls it is three lines and holds no logic, because logic in a git hook is logic nobody tests.
 */

export interface ReindexResult {
  repo: string;
  commit: string;
  dirty: boolean;
  symbols: number;
  edges: number;
  bytes: number;
  gzipped: number;
  index_id: string;
  pruned: string[];
  ms: number;
  /** True when this commit was already on record. Not an error: see `reindex`. */
  already: boolean;
}

/** One reindex at a time per repository. A busy branch can fire several hooks within a second, and
 *  three concurrent full indexes of the same tree is waste, not parallelism. */
async function withLock<T>(gitDir: string, fn: () => Promise<T>): Promise<T | null> {
  const lock = resolve(gitDir, "datum-reindex.lock");
  try {
    // wx fails if it exists: the check and the claim are one syscall, so two hooks racing cannot
    // both win.
    await writeFile(lock, `${process.pid}\n`, { flag: "wx" });
  } catch {
    return null;
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", dir, ...args], { maxBuffer: 1 << 24 });
  return stdout.trim();
}

export async function reindex(opts: {
  dir?: string;
  server?: string;
  scope?: string;
  repo?: string;
  key?: string;
}): Promise<ReindexResult | null> {
  const dir = opts.dir ?? process.cwd();
  const project = await readProjectFile(dir);

  const server = (opts.server ?? project?.server ?? process.env["DATUM_URL"] ?? "").replace(
    /\/+$/,
    "",
  );
  const scope = opts.scope ?? project?.scope;
  const keyEnv = project?.key_env ?? "DATUM_KEY";
  const key = opts.key ?? process.env[keyEnv] ?? process.env["DATUM_KEY"];

  if (!server) throw new Error("no server: run `datum link` or pass --server");
  if (!scope) throw new Error("no scope: run `datum link` or pass --scope");
  if (!key) throw new Error(`no API key: set ${keyEnv}`);

  const gitDir = resolve(dir, await git(dir, ["rev-parse", "--git-dir"]));

  return withLock(gitDir, async () => {
    const started = Date.now();
    const commitSha = await git(dir, ["rev-parse", "HEAD"]);
    const status = await git(dir, ["status", "--porcelain"]);
    const dirty = status !== "";

    let repo = opts.repo ?? project?.repo;
    if (!repo) {
      const origin = await git(dir, ["remote", "get-url", "origin"]).catch(() => "");
      const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(origin);
      repo = m?.[1];
    }
    if (!repo) throw new Error("could not determine owner/repo: pass --repo");

    const artifact = await indexRepo({ dir, repo, commitSha });
    const body = JSON.stringify(artifact);
    const packed = await deflate(Buffer.from(body, "utf8"));

    const res = await fetch(`${server}/v1/graph/index?scope=${encodeURIComponent(scope)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: packed,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* a non-JSON body is handled below, by status */
    }
    const out = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};

    // An index already on record for this commit is NOT a failure. `post-checkout` fires when a ref
    // moves without the tree changing, so a hook that treated this as an error would write one to
    // the log on every branch switch - and a log that cries wolf is a log nobody reads, which puts
    // us back to a stale graph that nobody notices. Indexes are never mutated, so "already there"
    // is the desired end state and the run is a no-op.
    const already =
      res.status === 400 &&
      typeof out["reason"] === "string" &&
      /already indexed/i.test(String(out["message"] ?? out["says"] ?? ""));

    if (!res.ok && !already) {
      // The reason travels. A hook that prints "failed" teaches an operator to ignore hooks.
      throw new Error(`server refused the index (${res.status}): ${text.slice(0, 400)}`);
    }

    const detail =
      out["detail"] && typeof out["detail"] === "object"
        ? (out["detail"] as Record<string, unknown>)
        : {};

    return {
      already,
      repo,
      commit: commitSha,
      dirty,
      symbols: artifact.symbols.length,
      edges: artifact.edges.length,
      bytes: body.length,
      gzipped: packed.length,
      index_id:
        typeof out["index_id"] === "string"
          ? out["index_id"]
          : typeof detail["index_id"] === "string"
            ? detail["index_id"]
            : "",
      pruned: Array.isArray(out["pruned"]) ? (out["pruned"] as string[]) : [],
      ms: Date.now() - started,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The hooks.
// ---------------------------------------------------------------------------------------------

/**
 * Three lines and a background call. Everything that can go wrong — no key, server down, a dirty
 * tree, a second hook already running — is handled in `datum reindex`, where it can be tested.
 *
 * The hook must NEVER fail the git operation that triggered it. A commit that aborts because a
 * cache refresh failed is a hook that gets deleted by whoever hits it, and then the graph is stale
 * again and nobody knows.
 */
const HOOK_MARKER = "# datum:reindex";

function hookBody(cli: string): string {
  return `#!/bin/sh
${HOOK_MARKER} — refreshes the code graph after this ref moved.
# Written by \`datum watch --install\`. Delete this file, or run \`datum watch --uninstall\`.
#
# Backgrounded and silenced on purpose: this must never fail the git operation that ran it.
# Output goes to .git/datum-reindex.log; concurrent runs are dropped by a lock, not queued.
LOG="$(git rev-parse --git-dir)/datum-reindex.log"
( ${cli} reindex --quiet >>"$LOG" 2>&1 & ) >/dev/null 2>&1
exit 0
`;
}

const HOOKS = ["post-commit", "post-merge", "post-checkout", "post-rewrite"] as const;

export async function installHooks(opts: {
  dir?: string;
  cli?: string;
}): Promise<{ installed: string[]; skipped: Array<{ hook: string; why: string }>; log: string }> {
  const dir = opts.dir ?? process.cwd();
  const gitDir = resolve(dir, await git(dir, ["rev-parse", "--git-dir"]));
  const hooksDir = resolve(gitDir, "hooks");
  await mkdir(hooksDir, { recursive: true });

  // `datum` on PATH is the normal case, but a repo checked out beside a source tree may only have
  // the tsx entrypoint. Resolve once, at install time, so the hook itself needs no discovery.
  const cli = opts.cli ?? "datum";

  const installed: string[] = [];
  const skipped: Array<{ hook: string; why: string }> = [];
  const body = hookBody(cli);

  for (const hook of HOOKS) {
    const path = resolve(hooksDir, hook);
    const existing = await readFile(path, "utf8").catch(() => null);
    if (existing !== null && !existing.includes(HOOK_MARKER)) {
      // Somebody else's hook. Overwriting it would be the kind of silent damage this project
      // exists to refuse, so it is reported and left alone.
      skipped.push({ hook, why: "a hook already exists here and is not ours" });
      continue;
    }
    await writeFile(path, body, "utf8");
    await chmod(path, 0o755);
    installed.push(hook);
  }

  return { installed, skipped, log: resolve(gitDir, "datum-reindex.log") };
}

export async function uninstallHooks(opts: {
  dir?: string;
}): Promise<{ removed: string[]; left: string[] }> {
  const dir = opts.dir ?? process.cwd();
  const gitDir = resolve(dir, await git(dir, ["rev-parse", "--git-dir"]));
  const removed: string[] = [];
  const left: string[] = [];
  for (const hook of HOOKS) {
    const path = resolve(gitDir, "hooks", hook);
    const existing = await readFile(path, "utf8").catch(() => null);
    if (existing === null) continue;
    if (existing.includes(HOOK_MARKER)) {
      await rm(path, { force: true });
      removed.push(hook);
    } else {
      left.push(hook);
    }
  }
  return { removed, left };
}

/** So `datum watch --status` can say whether the graph is actually being kept current. */
export async function hookStatus(opts: {
  dir?: string;
}): Promise<{ hooks: Array<{ hook: string; ours: boolean; present: boolean }>; logTail: string }> {
  const dir = opts.dir ?? process.cwd();
  const gitDir = resolve(dir, await git(dir, ["rev-parse", "--git-dir"]));
  const hooks: Array<{ hook: string; ours: boolean; present: boolean }> = [];
  for (const hook of HOOKS) {
    const text = await readFile(resolve(gitDir, "hooks", hook), "utf8").catch(() => null);
    hooks.push({ hook, present: text !== null, ours: text?.includes(HOOK_MARKER) ?? false });
  }
  const log = await readFile(resolve(gitDir, "datum-reindex.log"), "utf8").catch(() => "");
  return { hooks, logTail: log.split("\n").slice(-8).join("\n").trim() };
}

/** Used by the installer to record which binary the hook will call, so `--status` can say it. */
export const hookFingerprint = (cli: string): string =>
  createHash("sha256").update(hookBody(cli), "utf8").digest("hex").slice(0, 12);

export const HOOK_NAMES = HOOKS;
export { dirname };
