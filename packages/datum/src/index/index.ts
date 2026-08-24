import { readFile } from "node:fs/promises";
import { extractCFamily, prepareCFamilySource } from "./cfamily.js";
import { extractPython } from "./python.js";
import { extractRust } from "./rust.js";
import { Collector, resolveEdges } from "./resolve.js";
import { ModulePathResolver, discover } from "./walk.js";
import { ParserSet, type LanguageId } from "./parser.js";
import type { FileContext } from "./context.js";
import type { GraphArtifact, SymbolKind } from "../graph/types.js";

export { MissingParserError } from "./parser.js";
export { AMBIGUITY_CEILING, LANGUAGE_BY_EXTENSION, NON_CALL_TARGETS, SKIP_DIRS } from "./filters.js";

/**
 * The indexer version, and it is part of `code_index`'s identity.
 *
 * Bump it whenever extraction or resolution changes, because two indexes of the same commit that
 * disagree are only comparable if you can tell which produced which. `code_index_identity` is
 * `(repo, commit_sha, indexer)`, so this string is what lets a re-index coexist with its
 * predecessor instead of colliding with it.
 */
export const INDEXER_VERSION = "datum-treesitter/1";

/** Two megabytes. Past this a file is generated, vendored, or a data blob wearing a `.rs` suffix. */
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface IndexRepoOptions {
  /** Absolute or relative path to the working tree to index. */
  dir: string;
  /** Repository identity as the store knows it, e.g. `owner/name`. */
  repo: string;
  commitSha: string;
  /** Glob patterns over repo-relative paths. When present, only matching files are indexed. */
  include?: string[];
  exclude?: string[];
  maxFileBytes?: number;
  onProgress?: (msg: string) => void;
}

export async function indexRepo(opts: IndexRepoOptions): Promise<GraphArtifact> {
  const started = Date.now();
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const progress = opts.onProgress ?? (() => {});

  // Loaded before any filesystem work, so a missing-parser failure is immediate and unambiguous
  // rather than arriving after a minute of directory walking.
  const parsers = ParserSet.load();

  const discovery = await discover(opts.dir, {
    include: opts.include,
    exclude: opts.exclude,
    maxFileBytes,
  });
  progress(
    `discovered ${discovery.files.length} files (${discovery.skippedLarge.length} over ${maxFileBytes} bytes, ` +
      `${discovery.skippedDirs} directories skipped)`,
  );

  const modules = new ModulePathResolver(opts.dir);
  const collector = new Collector();
  const languages = new Set<LanguageId>();
  const filesByLanguage: Record<string, number> = {};
  const parseFailures: string[] = [];
  let filesWithSyntaxErrors = 0;
  let bytesParsed = 0;
  let indexed = 0;

  for (const file of discovery.files) {
    let source: string;
    try {
      source = await readFile(file.absolute, "utf8");
    } catch {
      parseFailures.push(file.path);
      continue;
    }
    // The one source rewrite in the whole indexer, and it is length-preserving so every offset,
    // line and column stays exact. See `prepareCFamilySource` for why the grammar leaves no choice.
    if (file.language === "c" || file.language === "cpp" || file.language === "cuda") {
      source = prepareCFamilySource(source);
    }
    let root;
    try {
      root = parsers.parserFor(file.language).parse(source).rootNode;
    } catch {
      // A parse that throws outright — an encoding tree-sitter refuses, or a file large enough to
      // exceed an internal limit. Counted, never guessed at.
      parseFailures.push(file.path);
      continue;
    }
    // `hasError` is recorded but never a reason to discard a file. Every CUDA translation unit has
    // errors, because the grammar does not know `__global__`; the recoverable parts are still true.
    if (root.hasError) filesWithSyntaxErrors++;

    const { module, unit } = await modules.forFile(file.path, file.language);
    const ctx: FileContext = {
      path: file.path,
      language: file.language,
      module,
      unit,
      source,
      root,
    };
    try {
      switch (file.language) {
        case "rust":
          extractRust(ctx, collector);
          break;
        case "python":
          extractPython(ctx, collector);
          break;
        case "c":
        case "cpp":
        case "cuda":
          extractCFamily(ctx, collector);
          break;
      }
    } catch {
      // One malformed file must not lose the other nine hundred. The failure is counted so the
      // artifact never silently claims coverage it does not have.
      parseFailures.push(file.path);
      continue;
    }

    languages.add(file.language);
    filesByLanguage[file.language] = (filesByLanguage[file.language] ?? 0) + 1;
    bytesParsed += file.bytes;
    indexed++;
    if (indexed % 250 === 0) progress(`parsed ${indexed}/${discovery.files.length} files`);
  }

  progress(`resolving ${collector.edges.length} edges against ${collector.symbols.length} symbols`);
  const resolved = resolveEdges(collector);

  const symbolsByKind: Record<string, number> = {};
  for (const symbol of resolved.symbols) {
    symbolsByKind[symbol.kind] = (symbolsByKind[symbol.kind] ?? 0) + 1;
  }
  const edgesByKind: Record<string, number> = {};
  for (const edge of resolved.edges) {
    edgesByKind[edge.kind] = (edgesByKind[edge.kind] ?? 0) + 1;
  }

  const elapsedMs = Date.now() - started;
  progress(
    `indexed ${indexed} files, ${resolved.symbols.length} symbols, ${resolved.edges.length} edges in ${elapsedMs} ms`,
  );

  return {
    version: 1,
    repo: opts.repo,
    commit_sha: opts.commitSha,
    indexer: INDEXER_VERSION,
    languages: [...languages].sort(),
    file_count: indexed,
    symbols: resolved.symbols,
    edges: resolved.edges,
    stats: {
      wall_ms: elapsedMs,
      bytes_parsed: bytesParsed,
      files_discovered: discovery.files.length,
      files_indexed: indexed,
      files_by_language: filesByLanguage,
      files_skipped_large: discovery.skippedLarge.length,
      // The paths, not just the count: a skipped file is a hole in coverage, and a hole you cannot
      // name is indistinguishable from a hole you do not have.
      skipped_large_paths: discovery.skippedLarge.slice(0, 50),
      directories_skipped: discovery.skippedDirs,
      unreadable: discovery.unreadable.slice(0, 50),
      parse_failures: parseFailures.length,
      parse_failure_paths: parseFailures.slice(0, 50),
      files_with_syntax_errors: filesWithSyntaxErrors,
      symbols_by_kind: symbolsByKind,
      edges_by_kind: edgesByKind,
      max_file_bytes: maxFileBytes,
      ...resolved.stats,
    },
  };
}

