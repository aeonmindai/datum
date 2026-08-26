/**
 * The code graph subsystem's public surface.
 *
 * Three entry points, because the split between them is the design: `ingestGraph` loads an
 * artifact and needs no parser, `impact` answers the reverse-dependency question over what was
 * loaded, and `registerGraphRoutes` exposes both over HTTP. The indexer that produces the artifact
 * lives elsewhere and is a build-time concern — that is what keeps native parser dependencies out
 * of the runtime image.
 */

export { ingestGraph, impact, resolveIndex, searchSymbols , pruneIndexes, indexScope } from "./store.js";
export type { ResolvedIndex, SymbolMatch } from "./store.js";
export { registerGraphRoutes } from "./routes.js";
export {
  EDGE_KINDS,
  RESOLUTIONS,
  SYMBOL_KINDS,
  confidenceFor,
  type EdgeConfidence,
  type EdgeKind,
  type GraphArtifact,
  type GraphEdge,
  type GraphSymbol,
  type ImpactHop,
  type ImpactResult,
  type Resolution,
  type SymbolKind,
} from "./types.js";
