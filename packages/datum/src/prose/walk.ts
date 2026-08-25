import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

/**
 * File discovery for the prose subsystems, with a hard byte budget.
 *
 * Both consumers need the same three properties and for the same reason. The read path
 * (`searchProse`) runs inside an HTTP request against a corpus that may be tens of megabytes,
 * so an unbounded walk is a stall. The write path (`extractProposals`) runs as a batch job but
 * still must not be able to blow up memory on a repository nobody vetted. And both must be
 * *deterministic*: two identical queries a second apart have to read the same files, or a
 * citation stops being reproducible, which is the only thing the prose channel is selling.
 *
 * So: sort by path, take files while they fit the budget, skip any single file that does not
 * fit rather than truncating it. Truncating a file mid-way would emit citations whose line
 * numbers depend on the budget, and a partial read that silently drops the second half of a
 * document is exactly the kind of quiet incompleteness this project refuses elsewhere.
 */

/**
 * Prose only. Source files are deliberately excluded: code is subsystem 1's territory, where
 * a parser produces facts rather than citations, and letting the text search wander into 715
 * `.rs` files would spend the whole byte budget on the one input that has a better instrument.
 */
export const PROSE_EXTENSIONS: Record<string, true> = {
  ".md": true,
  ".markdown": true,
  ".mdx": true,
  ".txt": true,
  ".rst": true,
  ".adoc": true,
  ".org": true,
};

/** Directories that are build output, dependency trees, or VCS internals. */
const PRUNED_DIRS: Record<string, true> = {
  ".git": true,
  ".hg": true,
  ".svn": true,
  "node_modules": true,
  "target": true,
  "dist": true,
  "build": true,
  "out": true,
  ".next": true,
  ".turbo": true,
  ".venv": true,
  "venv": true,
  "__pycache__": true,
  ".mypy_cache": true,
  ".pytest_cache": true,
  ".cache": true,
  "vendor": true,
  "site-packages": true,
};

/** A ceiling on directory entries visited, so a pathological tree cannot hang a request. */
const MAX_ENTRIES = 200_000;

export interface ProseFile {
  /** The path as it will appear in every citation: `join(root, ...)` of the root given to us. */
  path: string;
  size: number;
}

/**
 * Symlinks are never followed. `readdir(withFileTypes)` reports a symlinked directory as
 * `isSymbolicLink()` and not `isDirectory()`, so declining to recurse into anything that is not
 * a real directory closes the cycle risk without a visited-inode set.
 */
async function walk(dir: string, out: ProseFile[], counter: { seen: number }): Promise<void> {
  if (counter.seen >= MAX_ENTRIES) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // An unreadable directory is not an error worth failing a query over; it is simply not
    // part of the corpus, and the caller learns that from the absence of citations under it.
    return;
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    counter.seen += 1;
    if (counter.seen >= MAX_ENTRIES) break;
    if (entry.isDirectory()) {
      if (!Object.hasOwn(PRUNED_DIRS, entry.name) && !entry.name.startsWith(".")) {
        dirs.push(join(dir, entry.name));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (!Object.hasOwn(PROSE_EXTENSIONS, extname(entry.name).toLowerCase())) continue;
    const path = join(dir, entry.name);
    try {
      const info = await stat(path);
      out.push({ path, size: info.size });
    } catch {
      // Vanished between readdir and stat. Skip it.
    }
  }
  // Breadth-then-depth keeps the recursion shallow enough that a deep tree cannot overflow.
  for (const child of dirs) await walk(child, out, counter);
}

/**
 * Every prose file under `roots`, sorted by path, truncated to fit `maxBytes`.
 *
 * A root may be a single file, which is what makes the tests able to pin behaviour to one
 * fixture without building a directory.
 */
export async function collectProseFiles(
  roots: readonly string[],
  maxBytes: number,
): Promise<ProseFile[]> {
  const found: ProseFile[] = [];
  const counter = { seen: 0 };
  for (const root of roots) {
    let info: Stats;
    try {
      info = await stat(root);
    } catch {
      continue;
    }
    if (info.isFile()) {
      if (Object.hasOwn(PROSE_EXTENSIONS, extname(root).toLowerCase())) {
        found.push({ path: root, size: info.size });
      }
      continue;
    }
    if (info.isDirectory()) await walk(root, found, counter);
  }

  // Overlapping roots would otherwise index the same file twice, which double-counts its
  // lines in the BM25 document frequencies and skews every score in the result.
  const seen = new Set<string>();
  const unique = found
    .filter((f) => {
      const key = resolve(f.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const selected: ProseFile[] = [];
  let budget = maxBytes;
  for (const file of unique) {
    if (budget <= 0) break;
    if (file.size > budget) continue;
    selected.push(file);
    budget -= file.size;
  }
  return selected;
}

export interface ProseDocument {
  path: string;
  /** Split on `\r?\n`, so a line's text never carries a stray carriage return. */
  lines: string[];
}

/** Bounded concurrency: enough to hide I/O latency, not enough to exhaust file descriptors. */
const READ_CONCURRENCY = 8;

export async function readProseFiles(files: readonly ProseFile[]): Promise<ProseDocument[]> {
  const docs: Array<ProseDocument | null> = new Array(files.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= files.length) return;
      const file = files[index];
      if (!file) return;
      try {
        const text = await readFile(file.path, "utf8");
        docs[index] = { path: file.path, lines: text.split(/\r?\n/) };
      } catch {
        // Unreadable or not valid UTF-8. Not part of the corpus.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, () => worker()),
  );
  return docs.filter((d): d is ProseDocument => d !== null);
}

/** The document title of last resort, used when a file has no heading above a match. */
export function fileLabel(path: string): string {
  const name = basename(path);
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}
