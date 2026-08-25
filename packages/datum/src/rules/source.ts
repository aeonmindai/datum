import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Reading files in a way that keeps line numbers.
 *
 * Every off-the-shelf YAML/TOML/JSON parser throws away the line a value came from, and the line is
 * the entire deliverable here — a derived rule that cannot cite `file:line` is not emitted. So the
 * parsers in this directory are hand-written, line-indexed, and deliberately cover only the subset
 * of each format that enforcement config actually uses.
 */

export interface SourceFile {
  /** Repo-relative, POSIX separators, because it goes into `evidence.source`. */
  rel: string;
  abs: string;
  text: string;
  /** 0-indexed array; `lines[n - 1]` is line `n`. */
  lines: string[];
}

/**
 * Directories never worth scanning. `.claude` is here for a concrete reason: the Arc corpus carries
 * 23,374 markdown files under it, all vendored third-party agent skills. Scanning them would swamp
 * the doctrine report with other people's imperatives.
 */
const SKIP_DIRS: Record<string, true> = {
  ".git": true,
  ".claude": true,
  ".venv": true,
  ".mypy_cache": true,
  ".pytest_cache": true,
  ".ruff_cache": true,
  __pycache__: true,
  node_modules: true,
  target: true,
  dist: true,
  build: true,
  vendor: true,
  ".next": true,
  ".turbo": true,
  ".cargo": true,
};

export function toRel(dir: string, abs: string): string {
  return relative(dir, abs).split(sep).join("/");
}

export function loadSource(dir: string, rel: string): SourceFile | null {
  const abs = join(dir, rel);
  let text: string;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    text = readFileSync(abs, "utf8");
  } catch {
    // A missing config is the normal case, not an error: most repos have most of these absent.
    return null;
  }
  return { rel, abs, text, lines: text.split("\n") };
}

export interface WalkOptions {
  /** Lowercased extensions including the dot, e.g. `[".md"]`. */
  extensions?: readonly string[];
  /** Exact basenames to collect regardless of extension. */
  basenames?: readonly string[];
  /** Depth limit relative to `dir`; 0 means "only files directly in `dir`". */
  maxDepth?: number;
  /** Repo-relative directory prefixes to restrict the walk to. */
  only?: readonly string[];
}

/** Repo-relative paths, sorted, so a derivation run is deterministic across machines. */
export function walk(dir: string, opts: WalkOptions = {}): string[] {
  const found: string[] = [];
  const exts = opts.extensions;
  const names = opts.basenames;
  const maxDepth = opts.maxDepth ?? 64;

  const descend = (abs: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) {
        if (depth >= maxDepth) continue;
        if (SKIP_DIRS[entry.name]) continue;
        descend(child, depth + 1);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const lower = entry.name.toLowerCase();
      const extOk = exts ? exts.some((e) => lower.endsWith(e)) : false;
      const nameOk = names ? names.includes(entry.name) : false;
      if (!exts && !names) {
        found.push(toRel(dir, child));
      } else if (extOk || nameOk) {
        found.push(toRel(dir, child));
      }
    }
  };

  if (opts.only) {
    for (const prefix of opts.only) descend(join(dir, prefix), 0);
  } else {
    descend(dir, 0);
  }
  found.sort();
  return found;
}

/**
 * Blank out `#` comments while preserving every column, so a later line/column lookup on the
 * stripped text still lands on the same place in the original. Quote-aware, because
 * `extend-ignore-re = ["setp\\.ne\\.b32"]` and `run: echo "::error::#1"` both contain a `#` that is
 * not a comment.
 */
export function blankHashComments(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return `${line.slice(0, i)}${" ".repeat(line.length - i)}`;
  }
  return line;
}

/**
 * The commit these rules describe, read straight out of `.git` rather than by shelling out.
 *
 * It matters because `evidence.commit` is what lets the verification worker ever promote one of
 * these rows off `unverified`; a rule with no commit is permanently untouchable by it. Returns null
 * rather than guessing when the ref cannot be resolved.
 */
export function resolveHeadCommit(dir: string): string | null {
  const head = loadSource(dir, ".git/HEAD");
  if (!head) return null;
  const raw = head.text.trim();
  if (/^[0-9a-f]{40}$/i.test(raw)) return raw.toLowerCase();
  const match = /^ref:\s*(\S+)$/.exec(raw);
  if (!match) return null;
  const ref = match[1]!;
  const direct = loadSource(dir, `.git/${ref}`);
  if (direct && /^[0-9a-f]{40}$/i.test(direct.text.trim())) return direct.text.trim().toLowerCase();
  const packed = loadSource(dir, ".git/packed-refs");
  if (!packed) return null;
  for (const line of packed.lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 2 && parts[1] === ref && /^[0-9a-f]{40}$/i.test(parts[0]!)) {
      return parts[0]!.toLowerCase();
    }
  }
  return null;
}
