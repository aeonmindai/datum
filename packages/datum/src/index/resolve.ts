import { AMBIGUITY_CEILING, NON_CALL_TARGETS } from "./filters.js";
import type { LanguageId } from "./parser.js";
import type { EdgeKind, GraphEdge, GraphSymbol, Resolution, SymbolKind } from "../graph/types.js";

/**
 * An edge as an extractor knows it: a source symbol and a *name*, because at parse time that is
 * genuinely all there is. Turning the name into a target — and being honest about how well that
 * went — happens once, globally, after every file has been read.
 */
export interface RawEdge {
  /** The symbol key of the caller. Null only when `srcLookup` is used instead. */
  src: string | null;
  /**
   * For edges whose *source* is also only known by name. Rust `impl Trait for Type` is the case:
   * the block may sit in a different file from `struct Type`, so the source of the `implements`
   * edge cannot be a key until the whole index exists.
   */
  srcLookup?: readonly string[];
  kind: EdgeKind;
  /** What the source text actually wrote. Preserved verbatim as `dst_name`, resolved or not. */
  target: string;
  /** Candidate lookup keys, most specific first. The first one that matches anything decides. */
  lookup: readonly string[];
  path: string;
  line: number;
  /**
   * Language-level ambiguity between calling a function and constructing a value: Python `Foo()`
   * and C++ `Foo x;` are written like calls but mean instantiation. Resolved kind wins — if the
   * target turns out to be a type, the edge is retagged.
   */
  retagIfType?: EdgeKind;
}

/** A symbol plus the bookkeeping the resolver needs and the artifact does not carry. */
interface IndexedSymbol {
  symbol: GraphSymbol;
  family: Family;
  /**
   * False for a C/C++ prototype. A header declares and a translation unit defines, so indexing both
   * as peers would give every cross-file C++ function two symbols with one fqn — turning every call
   * into it ambiguous. Declarations are kept only where no definition was found, which is exactly
   * the pure-virtual and extern cases where the declaration *is* the symbol.
   */
  definition: boolean;
}

/**
 * Names are resolved within a language family and never across one.
 *
 * A Python `helper` is not a Rust `helper`, and treating them as candidates for each other would
 * manufacture ambiguity out of nothing. C, C++ and CUDA share a family because they genuinely share
 * a namespace through headers. Rust's `extern "C"` blocks do link against C symbols, but matching
 * them would be a guess about linkage rather than anything the parse tells us, and under-claiming
 * is the correct failure direction here.
 */
export type Family = "rust" | "python" | "cfamily";

export function familyOf(language: LanguageId): Family {
  return language === "rust" ? "rust" : language === "python" ? "python" : "cfamily";
}

export interface SymbolDraft {
  kind: SymbolKind;
  name: string;
  fqn: string | null;
  language: LanguageId;
  path: string;
  line_start: number;
  line_end: number;
  visibility?: string | null;
  signature?: string | null;
  signature_hash?: string | null;
  /** Pass false for a declaration with no body; see `IndexedSymbol.definition`. */
  definition?: boolean;
}

/**
 * Where extractors put what they find. Owns symbol key allocation, so keys are unique by
 * construction rather than by hope.
 */
export class Collector {
  readonly symbols: IndexedSymbol[] = [];
  readonly edges: RawEdge[] = [];
  private readonly takenKeys = new Set<string>();
  /** Call sites are per-site by design, but the same site must not be emitted twice. */
  private readonly seenEdges = new Set<string>();

  addSymbol(draft: SymbolDraft): GraphSymbol {
    const base = `${draft.path}#${draft.line_start}:${draft.kind}:${draft.name}`;
    let key = base;
    for (let n = 2; this.takenKeys.has(key); n++) key = `${base}~${n}`;
    this.takenKeys.add(key);
    const symbol: GraphSymbol = {
      key,
      kind: draft.kind,
      name: draft.name,
      fqn: draft.fqn,
      language: draft.language,
      path: draft.path,
      line_start: draft.line_start,
      line_end: draft.line_end,
      visibility: draft.visibility ?? null,
      signature: draft.signature ?? null,
      signature_hash: draft.signature_hash ?? null,
    };
    this.symbols.push({
      symbol,
      family: familyOf(draft.language),
      definition: draft.definition ?? true,
    });
    return symbol;
  }

  addEdge(edge: RawEdge): void {
    // The filter runs here, before resolution, so a std-vocabulary name never reaches the index and
    // never appears in the histogram we judge quality by.
    const bare = lastSegment(edge.target);
    if (NON_CALL_TARGETS.has(bare) || bare === "") return;
    const fingerprint = `${edge.src ?? edge.srcLookup?.join("|") ?? ""}\u0000${edge.kind}\u0000${edge.target}\u0000${edge.path}\u0000${edge.line}`;
    if (this.seenEdges.has(fingerprint)) return;
    this.seenEdges.add(fingerprint);
    this.edges.push(edge);
  }
}

export interface ResolutionOutcome {
  symbols: GraphSymbol[];
  edges: GraphEdge[];
  stats: {
    resolutions: Record<Resolution, number>;
    resolutions_by_kind: Record<string, Record<string, number>>;
    resolution_ambiguity_ceiling: number;
    declarations_shadowed: number;
    edges_dropped_no_source: number;
  };
}

/**
 * Every `::`, `.` and `/` is the same idea — a namespace step — so suffix keys are built over one
 * canonical separator. That is what lets `QtipGeometry::from_env` at a call site match a symbol
 * whose fqn is `mistralrs_quant::qtip::QtipGeometry::from_env`, and what lets
 * `#include "qtip/qtip_geom.cuh"` match a file module whose identity is a path.
 */
function canonical(name: string): string {
  return name.replace(/::/g, "/").replace(/\./g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

function lastSegment(name: string): string {
  return canonical(name).split("/").at(-1) ?? name;
}

class FamilyIndex {
  /** Full canonical fqn only. An exact match must beat a suffix match. */
  private readonly exact = new Map<string, string[]>();
  /** Every namespace suffix, including the full fqn and the bare name. */
  private readonly suffix = new Map<string, string[]>();

  add(entry: IndexedSymbol): void {
    const { key, fqn, name } = entry.symbol;
    const full = canonical(fqn ?? name);
    push(this.exact, full, key);
    const segments = full.split("/");
    for (let i = 0; i < segments.length; i++) push(this.suffix, segments.slice(i).join("/"), key);
    // A symbol whose fqn could not be derived is still findable by its bare name.
    if (fqn === null || fqn === "") push(this.suffix, canonical(name), key);
  }

  /** Matches for one lookup key: exact fqn first, then namespace suffix. */
  lookup(raw: string): readonly string[] {
    const c = canonical(raw);
    if (c === "") return [];
    return this.exact.get(c) ?? this.suffix.get(c) ?? [];
  }
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else if (!existing.includes(value)) existing.push(value);
}

/**
 * Turn names into targets, and label how confident that was.
 *
 * This is the whole differentiator, so the rules are stated once, here, and never bent:
 * one match is `unique-name`, several is `ambiguous-name` carrying every candidate, none is
 * `unresolved` with a null target. `compiler` and `language-server` are never emitted, because a
 * tree-sitter parse is neither. Nothing is ever invented to avoid an ambiguous label.
 */
export function resolveEdges(collector: Collector): ResolutionOutcome {
  const kept = dropShadowedDeclarations(collector.symbols);
  const declarations_shadowed = collector.symbols.length - kept.length;

  const indexes = new Map<Family, FamilyIndex>();
  const byKey = new Map<string, IndexedSymbol>();
  for (const entry of kept) {
    byKey.set(entry.symbol.key, entry);
    let index = indexes.get(entry.family);
    if (index === undefined) {
      index = new FamilyIndex();
      indexes.set(entry.family, index);
    }
    index.add(entry);
  }

  const resolutions: Record<Resolution, number> = {
    compiler: 0,
    "language-server": 0,
    "unique-name": 0,
    "ambiguous-name": 0,
    unresolved: 0,
  };
  const resolutionsByKind: Record<string, Record<string, number>> = {};
  let ceilingHits = 0;
  let droppedNoSource = 0;

  const edges: GraphEdge[] = [];
  for (const raw of collector.edges) {
    let srcKey = raw.src;
    let family: Family | undefined;

    if (srcKey !== null) {
      const src = byKey.get(srcKey);
      // The source can vanish here: a C++ prototype that acquired a definition elsewhere had its
      // declaration symbol dropped above. Its edges belong to the definition, not to a ghost.
      if (src === undefined) {
        droppedNoSource++;
        continue;
      }
      family = src.family;
    }

    if (srcKey === null) {
      const lookups = raw.srcLookup ?? [];
      // A source known only by name has to resolve uniquely. An `implements` edge whose subject
      // might be one of four types states nothing, and the schema requires a non-null src_id.
      let resolved: string | null = null;
      for (const candidateFamily of indexes.keys()) {
        const index = indexes.get(candidateFamily);
        if (index === undefined) continue;
        for (const key of lookups) {
          const hits = index.lookup(key);
          if (hits.length === 1 && hits[0] !== undefined) {
            resolved = hits[0];
            family = candidateFamily;
            break;
          }
          if (hits.length > 1) break;
        }
        if (resolved !== null) break;
      }
      if (resolved === null || family === undefined) {
        droppedNoSource++;
        continue;
      }
      srcKey = resolved;
    }

    const index = family === undefined ? undefined : indexes.get(family);
    let matches: readonly string[] = [];
    if (index !== undefined) {
      for (const key of raw.lookup) {
        matches = index.lookup(key);
        if (matches.length > 0) break;
      }
    }

    let resolution: Resolution;
    let dst: string | null = null;
    let candidates: string[] | undefined;

    if (matches.length === 1 && matches[0] !== undefined) {
      resolution = "unique-name";
      dst = matches[0];
    } else if (matches.length > AMBIGUITY_CEILING) {
      resolution = "unresolved";
      ceilingHits++;
    } else if (matches.length > 1) {
      resolution = "ambiguous-name";
      // `dst` stays null on purpose. Picking one of the candidates would be inventing a target to
      // avoid an ambiguous label, which is the exact over-claim this product exists to refuse.
      candidates = [...matches];
    } else {
      resolution = "unresolved";
    }

    let kind = raw.kind;
    if (raw.retagIfType !== undefined && dst !== null && byKey.get(dst)?.symbol.kind === "type") {
      kind = raw.retagIfType;
    }

    const edge: GraphEdge = {
      src: srcKey,
      dst,
      dst_name: raw.target,
      kind,
      resolution,
      path: raw.path,
      line: raw.line,
    };
    if (candidates !== undefined) edge.candidates = candidates;
    edges.push(edge);

    resolutions[resolution]++;
    const perKind = (resolutionsByKind[kind] ??= {});
    perKind[resolution] = (perKind[resolution] ?? 0) + 1;
  }

  return {
    symbols: kept.map((entry) => entry.symbol),
    edges,
    stats: {
      resolutions,
      resolutions_by_kind: resolutionsByKind,
      resolution_ambiguity_ceiling: ceilingHits,
      declarations_shadowed,
      edges_dropped_no_source: droppedNoSource,
    },
  };
}

/**
 * Drop a C/C++ prototype when the same fqn has a real definition somewhere in the index.
 *
 * Without this, every function declared in a header and defined in a `.cpp` carries two symbols
 * with one fqn, so every call to it resolves to two candidates and is reported as ambiguous. The
 * declaration-only survivors are the interesting residue: pure-virtual methods and `extern`
 * declarations, where the declaration genuinely is the only symbol there is.
 */
function dropShadowedDeclarations(all: readonly IndexedSymbol[]): IndexedSymbol[] {
  const definedFqns = new Set<string>();
  for (const entry of all) {
    if (!entry.definition) continue;
    const fqn = entry.symbol.fqn;
    if (fqn !== null && fqn !== "") definedFqns.add(`${entry.family}\u0000${entry.symbol.kind}\u0000${fqn}`);
  }
  if (definedFqns.size === 0) return [...all];
  return all.filter((entry) => {
    if (entry.definition) return true;
    const fqn = entry.symbol.fqn;
    if (fqn === null || fqn === "") return true;
    return !definedFqns.has(`${entry.family}\u0000${entry.symbol.kind}\u0000${fqn}`);
  });
}
