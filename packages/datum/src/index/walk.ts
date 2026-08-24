import { readFile, readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { LANGUAGE_BY_EXTENSION, SKIP_DIRS } from "./filters.js";
import type { LanguageId } from "./parser.js";

/** One file the indexer intends to parse, with its language already decided. */
export interface DiscoveredFile {
  /** Repo-relative, forward slashes, no leading `./`. The path convention of the whole artifact. */
  path: string;
  absolute: string;
  language: LanguageId;
  bytes: number;
}

export interface DiscoveryResult {
  files: DiscoveredFile[];
  skippedLarge: string[];
  skippedDirs: number;
  /** Directories that could not be read at all — a permission problem must not look like an empty repo. */
  unreadable: string[];
}

/**
 * Discovery is breadth-first over directory entries and never follows symlinks.
 *
 * The symlink rule is not paranoia about cycles: a symlink pointing into an excluded directory
 * would reintroduce the duplicate-tree problem that `SKIP_DIRS` exists to prevent, and it would do
 * it invisibly.
 */
export async function discover(
  dir: string,
  opts: {
    include?: readonly string[];
    exclude?: readonly string[];
    maxFileBytes: number;
  },
): Promise<DiscoveryResult> {
  const files: DiscoveredFile[] = [];
  const skippedLarge: string[] = [];
  const unreadable: string[] = [];
  let skippedDirs = 0;

  const include = compileMatchers(opts.include);
  const exclude = compileMatchers(opts.exclude);

  const queue: string[] = [""];
  while (queue.length > 0) {
    const rel = queue.pop() as string;
    let entries;
    try {
      entries = await readdir(rel === "" ? dir : join(dir, rel), { withFileTypes: true });
    } catch {
      unreadable.push(rel);
      continue;
    }
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      // A symlink is neither followed nor parsed; see the note above.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          skippedDirs++;
          continue;
        }
        if (exclude !== null && exclude.some((re) => re.test(`${childRel}/`))) {
          skippedDirs++;
          continue;
        }
        queue.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;

      const language = languageOf(entry.name);
      if (language === null) continue;
      if (include !== null && !include.some((re) => re.test(childRel))) continue;
      if (exclude !== null && exclude.some((re) => re.test(childRel))) continue;

      const info = await stat(join(dir, childRel)).catch(() => null);
      if (info === null) {
        unreadable.push(childRel);
        continue;
      }
      if (info.size > opts.maxFileBytes) {
        skippedLarge.push(childRel);
        continue;
      }
      files.push({
        path: childRel,
        absolute: join(dir, childRel),
        language,
        bytes: info.size,
      });
    }
  }

  // Deterministic order: two runs over the same commit must produce byte-identical artifacts, or
  // diffing two `code_index` rows reports churn that is really just directory iteration order.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  skippedLarge.sort();
  return { files, skippedLarge, skippedDirs, unreadable };
}

function languageOf(name: string): LanguageId | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot).toLowerCase();
  return ext in LANGUAGE_BY_EXTENSION
    ? LANGUAGE_BY_EXTENSION[ext as keyof typeof LANGUAGE_BY_EXTENSION]
    : null;
}

/**
 * Glob support is deliberately minimal — `*`, `**` and `?` over the repo-relative path. The
 * indexer's include/exclude exists to scope a run to a subtree, not to reimplement gitignore, and a
 * full matcher would mean a runtime dependency in a package whose whole point is having none.
 */
function compileMatchers(patterns: readonly string[] | undefined): RegExp[] | null {
  if (patterns === undefined || patterns.length === 0) return null;
  return patterns.map((pattern) => {
    let out = "";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i] as string;
      if (ch === "*") {
        if (pattern[i + 1] === "*") {
          out += ".*";
          i++;
          if (pattern[i + 1] === "/") i++;
        } else {
          out += "[^/]*";
        }
      } else if (ch === "?") {
        out += "[^/]";
      } else {
        out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
    }
    return new RegExp(`^${out}$`);
  });
}

/**
 * Module-path derivation, which is what makes `fqn` worth having.
 *
 * Each language has its own rule for turning a file location into a namespace, and getting it right
 * is the difference between `from_env` resolving against 40 same-named methods and
 * `mistralrs_quant::qtip::QtipGeometry::from_env` resolving against one.
 */
export class ModulePathResolver {
  /** Cargo.toml lookups are the expensive part; one filesystem probe per directory, cached. */
  private readonly crateByDir = new Map<string, { dir: string; name: string } | null>();
  private readonly isPackageDir = new Map<string, boolean>();

  constructor(private readonly root: string) {}

  async forFile(rel: string, language: LanguageId): Promise<{ module: string; unit: string }> {
    switch (language) {
      case "rust":
        return await this.rustModule(rel);
      case "python":
        return await this.pythonModule(rel);
      case "c":
      case "cpp":
      case "cuda":
        // C has no module system, so the file itself is the unit and its path is the only stable
        // identity available. `#include "a/b.cuh"` then resolves by path suffix.
        return { module: stripExtension(rel), unit: stemOf(rel) };
    }
  }

  /**
   * `<crate>::<dirs>::<stem>`, with `src/` stripped and `mod`/`lib`/`main` collapsed into their
   * parent — the actual Rust rule, so a path derived here matches what a `use` statement writes.
   *
   * `tests/`, `benches/` and `examples/` are kept as a leading component rather than stripped like
   * `src/`. Cargo compiles each of those as its own crate, so a test file's real module path is not
   * expressible in the same namespace as the library's; keeping the directory at least makes the
   * name unique and recognisable instead of colliding with a library module of the same stem.
   */
  private async rustModule(rel: string): Promise<{ module: string; unit: string }> {
    const crate = await this.findCrate(rel);
    const parts = rel.split("/");
    const fileParts = crate === null ? parts : parts.slice(crate.dir === "" ? 0 : crate.dir.split("/").length);
    if (fileParts[0] === "src") fileParts.shift();
    const stem = stripRustExtension(fileParts.pop() ?? "");
    const segments = [...fileParts];
    if (stem !== "mod" && stem !== "lib" && stem !== "main") segments.push(stem);
    const crateName = crate === null ? "" : crate.name;
    const all = crateName === "" ? segments : [crateName, ...segments];
    return {
      module: all.join("::"),
      unit: segments.at(-1) ?? crateName,
    };
  }

  private async findCrate(rel: string): Promise<{ dir: string; name: string } | null> {
    const parts = rel.split("/");
    for (let depth = parts.length - 1; depth >= 0; depth--) {
      const dirRel = parts.slice(0, depth).join("/");
      let found = this.crateByDir.get(dirRel);
      if (found === undefined) {
        found = await this.readCrateName(dirRel);
        this.crateByDir.set(dirRel, found);
      }
      if (found !== null) return found;
    }
    return null;
  }

  private async readCrateName(dirRel: string): Promise<{ dir: string; name: string } | null> {
    const manifest = join(this.root, dirRel.split("/").join(sep), "Cargo.toml");
    const text = await readFile(manifest, "utf8").catch(() => null);
    if (text === null) return null;
    // A hand-rolled read of one key rather than a TOML dependency: `[package] name` is the only
    // field we need, and adding a parser to the package for it would be absurd. A workspace-only
    // Cargo.toml has no `[package]`, and correctly yields null so the search continues upward.
    const pkg = text.indexOf("[package]");
    if (pkg < 0) return null;
    const nextSection = text.indexOf("\n[", pkg + 1);
    const section = text.slice(pkg, nextSection < 0 ? undefined : nextSection);
    const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(section);
    if (name === null || name[1] === undefined) return null;
    // Cargo normalises hyphens to underscores in module paths; `use mistralrs_quant::...` is what
    // the source actually writes, so that is what has to be in the fqn.
    return { dir: dirRel, name: name[1].replace(/-/g, "_") };
  }

  /**
   * The dotted path Python itself would use: walk up while the directory is a package, and let the
   * first non-package ancestor define the import root.
   */
  private async pythonModule(rel: string): Promise<{ module: string; unit: string }> {
    const parts = rel.split("/");
    const stem = stripPythonExtension(parts.pop() ?? "");
    const dirs = parts;
    let start = dirs.length;
    while (start > 0) {
      const candidate = dirs.slice(0, start).join("/");
      if (!(await this.hasInit(candidate))) break;
      start--;
    }
    const segments = dirs.slice(start);
    if (stem !== "__init__") segments.push(stem);
    return { module: segments.join("."), unit: segments.at(-1) ?? stem };
  }

  private async hasInit(dirRel: string): Promise<boolean> {
    const cached = this.isPackageDir.get(dirRel);
    if (cached !== undefined) return cached;
    const probe = join(this.root, dirRel.split("/").join(sep), "__init__.py");
    const exists = (await stat(probe).catch(() => null)) !== null;
    this.isPackageDir.set(dirRel, exists);
    return exists;
  }
}

function stripExtension(rel: string): string {
  const dot = rel.lastIndexOf(".");
  const slash = rel.lastIndexOf("/");
  return dot > slash ? rel.slice(0, dot) : rel;
}

function stemOf(rel: string): string {
  return stripExtension(rel).split("/").at(-1) ?? rel;
}

function stripRustExtension(name: string): string {
  return name.endsWith(".rs") ? name.slice(0, -3) : name;
}

function stripPythonExtension(name: string): string {
  return name.endsWith(".pyi") ? name.slice(0, -4) : name.endsWith(".py") ? name.slice(0, -3) : name;
}
