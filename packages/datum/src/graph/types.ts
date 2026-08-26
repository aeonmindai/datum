import { z } from "zod";

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

/**
 * The same contract, checked at runtime.
 *
 * The interfaces above are enough where the artifact arrives from the indexer in-process. Over
 * HTTP it arrives from a git hook or a CI runner, and a cast would let a malformed one reach the
 * loader as a stream of constraint violations rather than one 400 naming the field. It lives here
 * beside the interfaces so the shape has a single home: `POST /v1/graph/index` hands the parsed
 * value straight to `ingestGraph`, so if this schema and `GraphArtifact` ever disagree the route
 * stops compiling.
 *
 * Every optional field carries `.default(...)` rather than `.optional()`. That is what keeps the
 * output assignable under `exactOptionalPropertyTypes`, and it collapses "absent" and "null" to
 * the one value the loader already treats them as.
 */
export const GraphSymbolSchema = z.object({
  key: z.string().min(1),
  kind: z.enum(SYMBOL_KINDS),
  name: z.string().min(1),
  fqn: z.string().nullable().default(null),
  language: z.string().min(1),
  path: z.string().min(1),
  line_start: z.number().int().nonnegative(),
  line_end: z.number().int().nonnegative(),
  visibility: z.string().nullable().default(null),
  signature: z.string().nullable().default(null),
  signature_hash: z.string().nullable().default(null),
});

export const GraphEdgeSchema = z.object({
  src: z.string().min(1),
  dst: z.string().nullable().default(null),
  dst_name: z.string().min(1),
  kind: z.enum(EDGE_KINDS),
  resolution: z.enum(RESOLUTIONS),
  candidates: z.array(z.string()).default([]),
  path: z.string().min(1),
  line: z.number().int().nonnegative(),
});

export const GraphArtifactSchema = z.object({
  version: z.literal(1),
  repo: z.string().min(1),
  // Shape-checked here as well as in the loader and in `code_index_commit_shape`. The loader is
  // the authority; this one exists so a bad sha is a field-named 400 before 30 MB of symbols are
  // walked.
  commit_sha: z.string().regex(/^[0-9a-f]{7,40}$/, "commit_sha must be 7-40 lowercase hex"),
  indexer: z.string().min(1),
  languages: z.array(z.string()),
  file_count: z.number().int().nonnegative(),
  symbols: z.array(GraphSymbolSchema),
  edges: z.array(GraphEdgeSchema),
  stats: z.record(z.string(), z.unknown()).default({}),
});

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
