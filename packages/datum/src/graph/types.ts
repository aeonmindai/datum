/**
 * The contract between the indexer and the store.
 *
 * The indexer runs where the code is and needs a parser; the loader runs in the server and needs
 * nothing. `GraphArtifact` is the only thing that crosses between them, which is what keeps native
 * parser dependencies out of the runtime image.
 */

export const SYMBOL_KINDS = [
  "function",
  "method",
  "type",
  "trait",
  "module",
  "macro",
  "test",
  "constant",
  "field",
  "kernel",
] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

export const EDGE_KINDS = [
  "calls",
  "imports",
  "uses_type",
  "implements",
  "tests",
  "references",
  "instantiates",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * How an edge's target was determined. This is the differentiator: every other code-intelligence
 * product gives you edges, none of them tells you how much to trust each one.
 *
 * - `compiler` / `language-server` -> confidence `measured`. The edge is a fact.
 * - `unique-name` -> `derived`. Exactly one symbol in the index bears the name; sound but inferred.
 * - `ambiguous-name` -> `unverified`. Several candidates; the edge carries all of them.
 * - `unresolved` -> `unverified` with no target. "Calls something I could not find" is information.
 */
export const RESOLUTIONS = [
  "compiler",
  "language-server",
  "unique-name",
  "ambiguous-name",
  "unresolved",
] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export type EdgeConfidence = "measured" | "derived" | "unverified";

/** The single place the resolution -> confidence mapping is decided. */
export function confidenceFor(resolution: Resolution): EdgeConfidence {
  switch (resolution) {
    case "compiler":
    case "language-server":
      return "measured";
    case "unique-name":
      return "derived";
    case "ambiguous-name":
    case "unresolved":
      return "unverified";
  }
}

export interface GraphSymbol {
  /** Stable within one artifact; the loader maps these to database ids. */
  key: string;
  kind: SymbolKind;
  name: string;
  /** Fully qualified where the language allows it. Edges resolve against this first, then `name`. */
  fqn?: string | null;
  language: string;
  path: string;
  line_start: number;
  line_end: number;
  visibility?: string | null;
  signature?: string | null;
  /** Cheap change detector: if this moves, callers may care even when the name did not. */
  signature_hash?: string | null;
}

export interface GraphEdge {
  src: string;
  /** Null when unresolved. The edge is still recorded. */
  dst?: string | null;
  dst_name: string;
  kind: EdgeKind;
  resolution: Resolution;
  /** Populated only for `ambiguous-name`, and required there: at least two candidate symbol keys. */
  candidates?: string[];
  path: string;
  line: number;
}

export interface GraphArtifact {
  /** Artifact format version. Bump on a breaking shape change; never reinterpret an old value. */
  version: 1;
  repo: string;
  commit_sha: string;
  indexer: string;
  languages: string[];
  file_count: number;
  symbols: GraphSymbol[];
  edges: GraphEdge[];
  /** Free-form counters worth keeping: files skipped, parse failures, resolution histogram. */
  stats?: Record<string, unknown>;
}

export interface ImpactHop {
  symbol_id: string;
  depth: number;
  /** The WEAKEST confidence on the path that reached this symbol. */
  path_confidence: EdgeConfidence;
  via_kind: EdgeKind;
  name: string;
  fqn: string | null;
  kind: SymbolKind;
  path: string;
  line_start: number;
}

export interface ImpactResult {
  repo: string;
  commit_sha: string;
  target: { name: string; fqn: string | null; path: string; line_start: number };
  max_depth: number;
  /** Reverse dependency closure, nearest and most trustworthy first. */
  reached_by: ImpactHop[];
  /** Symbols of kind `test` that reach the target: what covers this change. */
  covered_by_tests: ImpactHop[];
  /**
   * Hops reached only through an ambiguous edge. Reported separately and never merged into
   * `reached_by` as though certain — an impact answer that mixes resolved and guessed edges is the
   * code-intelligence equivalent of returning a bare number.
   */
  ambiguous: ImpactHop[];
  counts: Record<EdgeConfidence, number>;
}
