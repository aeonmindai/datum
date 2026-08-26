import type pg from "pg";
import type { Db } from "../db/pool.js";
import { Rejection } from "../domain/errors.js";
import { newId } from "../domain/identity.js";
import {
  EDGE_KINDS,
  confidenceFor,
  type EdgeConfidence,
  type EdgeKind,
  type GraphArtifact,
  type ImpactHop,
  type ImpactResult,
  type SymbolKind,
} from "./types.js";

/**
 * Loading graph artifacts, and answering impact queries over them.
 *
 * Two properties shape everything in this file.
 *
 * The first is that the *recursive closure lives in SQL* (`datum.code_impact`, migration 008).
 * Re-implementing it here would mean pulling every candidate edge over the wire and walking it in
 * JavaScript, which on Arc means tens of thousands of rows per hop; and it would mean a second
 * place where the weakest-link rule is decided. There is exactly one definition of "the weakest
 * confidence on the path", and it is the CASE expression in the migration.
 *
 * The second is that an impact answer must degrade honestly. `reached_by` and `ambiguous` are
 * separate arrays and nothing ever moves between them: a caller found only through a guessed edge
 * is reported as guessed. Silently mixing resolved and name-matched edges is the
 * code-intelligence equivalent of returning a bare number, which is the thing this store exists
 * to refuse.
 */

/**
 * Rows per INSERT statement. Arc produces tens of thousands of symbols and edges, so
 * row-at-a-time is unusably slow (one network round trip per row); a single statement for
 * everything blows past Postgres's 65535 bind-parameter ceiling. A thousand rows at nine to
 * eleven columns sits at ~10k parameters, an order of magnitude inside the limit, and amortises
 * the round trip away.
 */
const BATCH_ROWS = 1000;

/** Matches `code_impact`'s own default; stated here so the API answer can report what it used. */
const DEFAULT_DEPTH = 4;

/**
 * The closure is exponential in branching factor, and a reverse closure over a hot utility
 * function on a 100k-edge index fans out fast. Eight is past anything a human reads and bounded
 * enough that an unauthenticated-then-authenticated caller cannot turn one request into a
 * table-scanning recursion.
 */
const MAX_DEPTH = 8;

/** The same shape `code_index_commit_shape` enforces. Checked here so a bad sha is a 400 naming
 *  the field rather than a constraint violation, and — load-bearing — so a value interpolated
 *  into a LIKE prefix below cannot carry `%` or `_`. */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

/** `code_index_scope_shape`, ahead of the insert, for the same reason. */
const SCOPE_SHAPE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

const CONFIDENCE_RANK: Record<EdgeConfidence, number> = {
  measured: 0,
  derived: 1,
  unverified: 2,
};

/** Membership table for the edge-kind filter, in the same `Object.hasOwn` shape `domain/errors.ts`
 *  uses for its SQLSTATE table. */
const KNOWN_EDGE_KIND: Record<string, true> = Object.fromEntries(
  EDGE_KINDS.map((kind) => [kind, true]),
);

export interface ResolvedIndex {
  id: string;
  scope: string;
  repo: string;
  commit_sha: string;
  indexer: string;
  indexed_at: Date;
  symbol_count: number;
  edge_count: number;
}

export interface SymbolMatch {
  id: string;
  kind: SymbolKind;
  name: string;
  fqn: string | null;
  language: string;
  path: string;
  line_start: number;
  line_end: number;
  visibility: string | null;
  signature: string | null;
}

// ---------------------------------------------------------------------------------------
// Ingest.

/**
 * `($1,$2,$3),($1,$4,$5)` — the first `shared` placeholders repeat in every row.
 *
 * `index_id` is the same value for every row of a batch, so binding it once instead of a
 * thousand times keeps both the parameter count and the statement text down.
 */
function rowsClause(rows: number, shared: number, perRow: number): string {
  const sharedSlots = Array.from({ length: shared }, (_, i) => `$${i + 1}`).join(",");
  const out: string[] = new Array(rows);
  let n = shared;
  for (let r = 0; r < rows; r += 1) {
    const slots: string[] = new Array(perRow);
    for (let c = 0; c < perRow; c += 1) {
      n += 1;
      slots[c] = `$${n}`;
    }
    out[r] = shared > 0 ? `(${sharedSlots},${slots.join(",")})` : `(${slots.join(",")})`;
  }
  return out.join(",");
}

/**
 * The edge batch needs its own builder because `candidates` carries an explicit `::bigint[]`
 * cast: inside a multi-row VALUES list Postgres has nothing to infer the array's element type
 * from, and an untyped array literal is a runtime error rather than a compile-time one.
 */
function edgeRowsClause(rows: number): string {
  const out: string[] = new Array(rows);
  let n = 1; // $1 is index_id, shared by every row.
  for (let r = 0; r < rows; r += 1) {
    const s = (k: number) => `$${n + k}`;
    out[r] = `($1,${s(1)},${s(2)},${s(3)},${s(4)},${s(5)},${s(6)},${s(7)}::bigint[],${s(8)},${s(9)})`;
    n += 9;
  }
  return out.join(",");
}

/**
 * A scope for an artifact that did not name one.
 *
 * Repo slugs are already slash-separated labels, which is exactly the scope grammar, so
 * `code/owner/repo` needs no invention and no configuration. A caller that cares — the CLI, which
 * knows `config.orgScope` — passes `opts.scope` and this is never reached.
 */
function defaultScope(repo: string): string {
  const labels = repo
    .split("/")
    .map((part) => part.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((part) => part.length > 0);
  return labels.length > 0 ? `code/${labels.join("/")}` : "code";
}

/**
 * Where an index lands in the org's scope tree.
 *
 * `defaultScope` is deliberately org-blind, and that makes a graph ingested without a scope
 * unreadable by exactly the keys that should read it: a project key is bound to
 * `org/<org>/proj/<project>` and `code/<owner>/<repo>` is not under it. A caller that knows the
 * org supplies this instead. `cli/index.ts` holds the same rule inline for `datum ingest-graph`
 * and should adopt this function; this is the shared home for it.
 */
export function indexScope(orgScope: string, repo: string): string {
  const project = (repo.split("/").pop() ?? "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // A repo name that sanitises away entirely still gets a valid scope rather than an invented
  // label: the org's project tree, which a project key can reach and an operator can see.
  return project.length > 0 ? `${orgScope}/proj/${project}` : `${orgScope}/proj`;
}

function refuse(message: string, detail: Record<string, unknown> = {}, hint?: string): Rejection {
  // `malformed_request` is the only 400 in the shared reason taxonomy, and `domain/reasons.ts` is
  // not this module's to extend. The message and detail carry the specifics.
  return new Rejection({ reason: "malformed_request", message, detail, hint: hint ?? null });
}

export interface IngestResult {
  indexId: string;
  symbols: number;
  edges: number;
  /** Indexes retention dropped once this one became the newest. Empty until `keep` is exceeded. */
  pruned: string[];
  /** Set only when retention failed *after* a committed load; see the call site for why that is
   *  reported rather than thrown. */
  pruneError?: string;
}

export async function ingestGraph(
  db: Db,
  artifact: GraphArtifact,
  opts?: { scope?: string; keep?: number },
): Promise<IngestResult> {
  if (artifact.version !== 1) {
    throw refuse(
      `graph artifact version ${String(artifact.version)} is not understood; this loader reads version 1`,
      { version: artifact.version },
      "An older artifact is never reinterpreted under a newer format. Re-run the indexer.",
    );
  }
  if (!artifact.repo || !artifact.indexer) {
    throw refuse("graph artifact needs both `repo` and `indexer`", {
      repo: artifact.repo ?? null,
      indexer: artifact.indexer ?? null,
    });
  }
  if (!COMMIT_SHA.test(artifact.commit_sha ?? "")) {
    throw refuse(
      `commit_sha ${JSON.stringify(artifact.commit_sha)} is not 7-40 lowercase hex`,
      { commit_sha: artifact.commit_sha ?? null },
      "An index is pinned to a commit; without a real sha the bitemporal question cannot be asked.",
    );
  }
  const scope = opts?.scope ?? defaultScope(artifact.repo);
  if (!SCOPE_SHAPE.test(scope)) {
    throw refuse(`scope ${JSON.stringify(scope)} is not slash-separated labels`, { scope });
  }

  const indexId = newId("cidx");
  const startedAt = Date.now();
  const symbols: SymbolTally = {
    byKind: {},
    byLanguage: {},
    malformedNames: { count: 0, sample: [] },
  };
  const edges: EdgeTally = {
    byResolution: {},
    byConfidence: { measured: 0, derived: 0, unverified: 0 },
    withoutTarget: 0,
    ambiguousEdges: 0,
    ambiguousRows: 0,
    rows: 0,
  };

  /**
   * The whole load is one transaction, and `completed_at` is still stamped last.
   *
   * Both halves matter. The ordering is what `datum.latest_index` relies on and what any future
   * streaming loader would need. Atomicity is what makes a failed load *recoverable*: the app
   * role holds no DELETE grant, so a committed-but-abandoned index row would sit behind
   * `code_index_identity UNIQUE (repo, commit_sha, indexer)` and block every retry of that
   * commit until an owner pruned it by hand. Rolling the row back is a stronger guarantee than
   * hiding it.
   */
  try {
    const counts = await db.tx("app", async (client) => {
      // Pre-checked rather than left to the unique constraint: once a statement fails the
      // transaction is aborted, so the error path could not then look up which index already
      // holds this commit — and that id is the only actionable part of the answer.
      const prior = await client.query<{ id: string; completed_at: Date | null }>(
        `SELECT id, completed_at FROM datum.code_index
          WHERE repo = $1 AND commit_sha = $2 AND indexer = $3`,
        [artifact.repo, artifact.commit_sha, artifact.indexer],
      );
      const priorRow = prior.rows[0];
      if (priorRow) {
        throw refuse(
          `${artifact.repo}@${artifact.commit_sha} is already indexed by ${artifact.indexer} as ${priorRow.id}`,
          { index_id: priorRow.id, completed: priorRow.completed_at !== null },
          priorRow.completed_at !== null
            ? "Indexes are never mutated. Index a new commit, or bump the indexer version."
            : "A load failed and left an invisible partial index. An owner must DELETE that row before this commit can be re-indexed.",
        );
      }

      await client.query(
        `INSERT INTO datum.code_index (id, scope, repo, commit_sha, indexer, languages, file_count)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7)`,
        [
          indexId,
          scope,
          artifact.repo,
          artifact.commit_sha,
          artifact.indexer,
          artifact.languages ?? [],
          artifact.file_count ?? 0,
        ],
      );

      const idByKey = await insertSymbols(client, indexId, artifact, symbols);
      const edgeRows = await insertEdges(client, indexId, artifact, idByKey, edges);

      // The audit this exists for: a language the artifact declares but produced no symbols under
      // is a coverage hole, and it is the one kind of hole a closure query can never reveal —
      // every query about that language's code returns an honest-looking empty answer.
      const silentLanguages = (artifact.languages ?? []).filter(
        (lang) => (symbols.byLanguage[lang] ?? 0) === 0,
      );

      const stats = {
        ...(artifact.stats ?? {}),
        // Loader-authored counters win over an artifact key of the same name: these are measured
        // by the thing that actually wrote the rows.
        loader: {
          symbols_by_kind: symbols.byKind,
          symbols_by_language: symbols.byLanguage,
          languages_without_symbols: silentLanguages,
          // A parser defect the loader can see but must not hide: see NAME_HAS_WHITESPACE.
          symbol_names_with_whitespace: symbols.malformedNames.count,
          symbol_names_with_whitespace_sample: symbols.malformedNames.sample,
          // Both numbers, because they differ: an ambiguous edge becomes one row per candidate.
          artifact_edges: artifact.edges.length,
          edge_rows: edgeRows,
          ambiguous_edges: edges.ambiguousEdges,
          ambiguous_edge_rows: edges.ambiguousRows,
          edges_by_resolution: edges.byResolution,
          edges_by_confidence: edges.byConfidence,
          edges_without_target: edges.withoutTarget,
          load_ms: Date.now() - startedAt,
        },
      };

      // Last statement before COMMIT. Until this runs the index is invisible to
      // `datum.latest_index`, which is what stops a half-loaded graph from answering anything.
      await client.query(
        `UPDATE datum.code_index
            SET completed_at = now(), symbol_count = $2, edge_count = $3, stats = $4::jsonb
          WHERE id = $1`,
        [indexId, artifact.symbols.length, edgeRows, JSON.stringify(stats)],
      );

      // `edges` is the row count, which is what `edge_count` holds and what a throughput number
      // should be measured against. `stats.loader.artifact_edges` keeps the other figure.
      return { symbols: artifact.symbols.length, edges: edgeRows };
    });

    // Retention runs here rather than inside the transaction above, and the ordering is the
    // safety property: `keep` counts *completed* indexes, so the index just loaded only becomes
    // one of them at the UPDATE two statements up. A load that rolled back has therefore pruned
    // nothing — a failed index can never cost an older, working one.
    let pruned: string[] = [];
    let pruneError: string | undefined;
    try {
      const prune = await pruneIndexes(db, {
        repo: artifact.repo,
        ...(opts?.keep === undefined ? {} : { keep: opts.keep }),
      });
      pruned = prune.deleted;
    } catch (err) {
      // A committed, readable index is not undone by a bookkeeping failure, and the failure is
      // self-healing: the next ingest prunes the same rows. Reporting it beats both swallowing it
      // (the volume fills quietly, which is the whole problem retention exists to solve) and
      // throwing (the caller reads a good load as a failure, then cannot retry — the same commit
      // twice is refused by `code_index_identity`).
      pruneError = err instanceof Error ? err.message : String(err);
    }

    return {
      indexId,
      ...counts,
      pruned,
      ...(pruneError === undefined ? {} : { pruneError }),
    };
  } catch (err) {
    // Two loaders racing on the same (repo, commit, indexer) — the constraint is the authority,
    // the pre-check above is only the good error message.
    if ((err as { code?: string } | null)?.code === "23505") {
      throw refuse(
        `${artifact.repo}@${artifact.commit_sha} was indexed by ${artifact.indexer} concurrently`,
        { repo: artifact.repo, commit_sha: artifact.commit_sha, indexer: artifact.indexer },
        "Another loader won the race. Its index is the live one; nothing was lost.",
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------
// Retention.

/**
 * How many completed indexes per repo survive a prune.
 *
 * One Arc index is 19,177 symbols and 126,897 edge rows — about 46 MB once the reverse-edge index
 * is counted. Kept forever at twenty commits a day that is tens of gigabytes a month, so the
 * question is not whether to bound it but where. Three is the smallest number that keeps the
 * questions the graph is for: the commit being worked on, the one before it (so "what changed"
 * has two sides), and one older to compare against. A fourth buys nothing that re-running the
 * indexer over an older commit cannot.
 */
const DEFAULT_KEEP = 3;

export interface PruneResult {
  /** Newest-first, the indexes this call actually removed. */
  deleted: string[];
  /** The completed indexes left behind. An in-flight load is not in either list: see below. */
  kept: string[];
  freed_symbols: number;
  freed_edges: number;
}

/**
 * Drop everything but the newest `keep` completed indexes for one repo.
 *
 * The graph is the one part of this store that may be deleted, because it is the one part that is
 * derived: re-running the indexer over the same commit reproduces it exactly. Migration 014 states
 * that argument and grants DELETE on `code_index` alone — the symbols and edges go with it through
 * the ON DELETE CASCADE declared in 008, which needs no grant of its own, and no ledger row
 * references either table.
 */
export async function pruneIndexes(
  db: Db,
  opts: { repo: string; keep?: number },
): Promise<PruneResult> {
  // Floored at one, and `keep: 0` is not honoured. The newest completed index is what
  // `datum.latest_index` returns and therefore what every unqualified query reads; deleting it
  // would answer "what calls this" with a 404 on a repo that is fully indexed. There is no state
  // in which that is the right answer, so the floor is here rather than left to a caller.
  const keep = Math.max(1, Math.trunc(opts.keep ?? DEFAULT_KEEP));

  return db.tx("app", async (client) => {
    // Completed indexes only, ordered the way `datum.latest_index` orders them so that "newest"
    // means the same thing to the reader and to the pruner. An index with completed_at IS NULL is
    // an in-flight load, not garbage: deleting one would cascade its symbols out from under a
    // transaction still writing them, and — since a partial index is invisible to every query —
    // it frees nothing a reader could have used anyway.
    const candidates = await client.query<{ id: string }>(
      `SELECT id FROM datum.code_index
        WHERE repo = $1 AND completed_at IS NOT NULL
        ORDER BY indexed_at DESC, id DESC`,
      [opts.repo],
    );
    const all = candidates.rows.map((row) => row.id);
    const doomed = all.slice(keep);
    if (doomed.length === 0) {
      return { deleted: [], kept: all, freed_symbols: 0, freed_edges: 0 };
    }

    // Counted before the DELETE, because the cascade is exactly what makes them uncountable
    // after it. Reporting freed rows is the point of a retention pass: an operator asking "did
    // that reclaim anything" needs a number, not a row count of index rows.
    const tally = await client.query<{ index_id: string; symbols: string; edges: string }>(
      `SELECT i.id AS index_id,
              (SELECT count(*) FROM datum.code_symbols s WHERE s.index_id = i.id) AS symbols,
              (SELECT count(*) FROM datum.code_edges   e WHERE e.index_id = i.id) AS edges
         FROM datum.code_index i
        WHERE i.id = ANY($1::text[])`,
      [doomed],
    );

    // The two guards restate the invariants in the statement that could violate them, so a future
    // edit to the selection above cannot quietly widen what gets deleted.
    const deleted = await client.query<{ id: string }>(
      `DELETE FROM datum.code_index
        WHERE id = ANY($1::text[])
          AND completed_at IS NOT NULL
          AND id IS DISTINCT FROM datum.latest_index($2)
        RETURNING id`,
      [doomed, opts.repo],
    );

    const gone = new Set(deleted.rows.map((row) => row.id));
    let freedSymbols = 0;
    let freedEdges = 0;
    for (const row of tally.rows) {
      if (!gone.has(row.index_id)) continue;
      // count(*) is bigint, which pg hands back as a string rather than losing precision.
      freedSymbols += Number(row.symbols);
      freedEdges += Number(row.edges);
    }

    return {
      deleted: doomed.filter((id) => gone.has(id)),
      kept: all.filter((id) => !gone.has(id)),
      freed_symbols: freedSymbols,
      freed_edges: freedEdges,
    };
  });
}

/**
 * No identifier in any language this indexer parses contains whitespace, so a name that does is a
 * parser defect rather than a symbol.
 *
 * This is a counter, not a refusal. Such a symbol is real code that the extractor mis-named: it is
 * unreachable, because no call site can resolve to a name with a space in it, so every call to it
 * silently lands in the unresolved bucket and the symbol reads as "nothing calls this" — an
 * absence that looks identical to a genuine one. Refusing the whole artifact over it would block a
 * 147k-row load for a handful of rows, and policing name extraction is not the loader's job. But a
 * defect nobody can see is a defect nobody fixes, so the count and a sample land in `stats` where
 * an audit will trip over them. Found this way: five real CUDA functions in one flashinfer header
 * whose templated return type was swept into their name.
 */
const NAME_HAS_WHITESPACE = /\s/;

/**
 * What the loader learns about the symbols while writing them, mirroring `EdgeTally`.
 *
 * `byLanguage` is the cheap half of a coverage audit. A closure query cannot distinguish "nothing
 * calls this" from "the file holding the callers was never parsed" — both return an empty answer,
 * and under any grading scheme where an empty closure is a scoreable claim, a silent coverage hole
 * reads as a correct result with nothing anywhere to contradict it. A language declared on the
 * index row with no symbols under it is exactly that hole, and this counter is what makes it
 * visible from the index row alone.
 */
interface SymbolTally {
  byKind: Record<string, number>;
  byLanguage: Record<string, number>;
  malformedNames: { count: number; sample: string[] };
}

async function insertSymbols(
  client: pg.PoolClient,
  indexId: string,
  artifact: GraphArtifact,
  tally: SymbolTally,
): Promise<Map<string, string>> {
  const idByKey = new Map<string, string>();
  const columns = `(index_id, id, kind, name, fqn, language, path, line_start, line_end, visibility, signature, signature_hash)`;

  for (let start = 0; start < artifact.symbols.length; start += BATCH_ROWS) {
    const slice = artifact.symbols.slice(start, start + BATCH_ROWS);

    /**
     * Ids are claimed from the sequence before the insert instead of read back from `RETURNING`.
     *
     * Postgres does not document the order in which a multi-row INSERT returns its rows, and the
     * artifact-key -> database-id map is load-bearing for every edge that follows: getting it
     * wrong would not fail, it would silently wire the graph to the wrong symbols. Claiming the
     * ids first makes the mapping exact by construction, at the cost of one extra round trip per
     * thousand rows.
     */
    const claimed = await client.query<{ id: string }>(
      `SELECT nextval('datum.code_symbols_id_seq')::text AS id FROM generate_series(1, $1)`,
      [slice.length],
    );

    const params: unknown[] = [indexId];
    for (let i = 0; i < slice.length; i += 1) {
      const sym = slice[i]!;
      const id = claimed.rows[i]!.id;
      if (idByKey.has(sym.key)) {
        throw refuse(
          `duplicate symbol key ${JSON.stringify(sym.key)} in artifact`,
          { key: sym.key, path: sym.path, line_start: sym.line_start },
          "Keys are the artifact's own identity for a symbol; two rows sharing one key make every edge referencing it ambiguous.",
        );
      }
      idByKey.set(sym.key, id);
      tally.byKind[sym.kind] = (tally.byKind[sym.kind] ?? 0) + 1;
      tally.byLanguage[sym.language] = (tally.byLanguage[sym.language] ?? 0) + 1;
      if (NAME_HAS_WHITESPACE.test(sym.name)) {
        tally.malformedNames.count += 1;
        // A handful is enough to find the pattern; the count is what says how bad it is.
        if (tally.malformedNames.sample.length < 10) {
          tally.malformedNames.sample.push(
            `${sym.path}:${sym.line_start} ${JSON.stringify(sym.name)}`,
          );
        }
      }
      params.push(
        id,
        sym.kind,
        sym.name,
        sym.fqn ?? null,
        sym.language,
        sym.path,
        sym.line_start,
        sym.line_end,
        sym.visibility ?? null,
        sym.signature ?? null,
        sym.signature_hash ?? null,
      );
    }

    await client.query(
      `INSERT INTO datum.code_symbols ${columns} VALUES ${rowsClause(slice.length, 1, 11)}`,
      params,
    );
  }
  return idByKey;
}

/**
 * How an artifact edge becomes rows, and why an ambiguous one becomes several.
 *
 * `datum.code_impact` walks `dst_id` — it seeds on `dst_id = target` and recurses on
 * `JOIN up ON e.dst_id = u.symbol_id`. An ambiguous edge arrives from the indexer with
 * `dst: null` and its candidate set populated, because the indexer refuses to invent a target it
 * could not determine. Stored as a single `dst_id IS NULL` row that edge would be inert: it would
 * never seed and never join, so `ImpactResult.ambiguous` would be permanently empty and the one
 * differentiator of this subsystem would silently not exist.
 *
 * So an ambiguous edge is written as one row per candidate, each carrying the FULL candidate array
 * and each labelled `unverified`. That is exactly the semantics the design asks for — "this may
 * also reach these three, I could not tell which" — expressed in the only form the closure can
 * traverse. Every fanned row says the same thing: `src` references `dst_name`, which is one of
 * `candidates`, and this path is a maybe. Nothing is promoted; the rows reconstruct back to one
 * ambiguous reference by grouping on (src_id, dst_name, kind).
 *
 * The consequence is that `edge_count` is a count of stored rows, not of artifact edges. Both
 * numbers land in `stats.loader` so the inflation is auditable rather than mysterious.
 */
interface EdgeTally {
  byResolution: Record<string, number>;
  byConfidence: Record<EdgeConfidence, number>;
  /** Artifact edges naming a target that resolved to nothing. Information, not noise. */
  withoutTarget: number;
  ambiguousEdges: number;
  ambiguousRows: number;
  /** Rows actually written to `code_edges`. */
  rows: number;
}

async function insertEdges(
  client: pg.PoolClient,
  indexId: string,
  artifact: GraphArtifact,
  idByKey: Map<string, string>,
  tally: EdgeTally,
): Promise<number> {
  const columns = `(index_id, src_id, dst_id, dst_name, kind, confidence, resolution, candidates, path, line)`;
  // Batching is by ROW, not by artifact edge: fan-out means 1000 ambiguous edges could become
  // 8000 rows, and at nine parameters each that would run past Postgres's 65535 bind-parameter
  // ceiling mid-load.
  let params: unknown[] = [indexId];
  let pending = 0;

  const flush = async (): Promise<void> => {
    if (pending === 0) return;
    await client.query(
      `INSERT INTO datum.code_edges ${columns} VALUES ${edgeRowsClause(pending)}`,
      params,
    );
    tally.rows += pending;
    params = [indexId];
    pending = 0;
  };

  for (let i = 0; i < artifact.edges.length; i += 1) {
    const edge = artifact.edges[i]!;
    const where = `${edge.path}:${edge.line}`;

    const srcId = idByKey.get(edge.src);
    if (srcId === undefined) {
      throw refuse(
        `edge at ${where} has src ${JSON.stringify(edge.src)}, which is not a symbol in this artifact`,
        { index: i, src: edge.src, path: edge.path, line: edge.line },
      );
    }

    let dstId: string | null = null;
    if (edge.dst !== undefined && edge.dst !== null) {
      dstId = idByKey.get(edge.dst) ?? null;
      if (dstId === null) {
        // Refused rather than downgraded to NULL: "this edge points at a symbol I cannot find"
        // and "this artifact is internally inconsistent" are different facts, and quietly
        // turning the second into the first would fabricate an `unresolved` edge.
        throw refuse(
          `edge at ${where} has dst ${JSON.stringify(edge.dst)}, which is not a symbol in this artifact`,
          { index: i, dst: edge.dst, path: edge.path, line: edge.line },
        );
      }
    }

    const candidateIds: string[] = [];
    for (const key of edge.candidates ?? []) {
      const id = idByKey.get(key);
      if (id === undefined) {
        throw refuse(
          `edge at ${where} lists candidate ${JSON.stringify(key)}, which is not a symbol in this artifact`,
          { index: i, candidate: key, path: edge.path, line: edge.line },
        );
      }
      candidateIds.push(id);
    }

    // The single source of truth for resolution -> confidence. Computing it a second way here is
    // how the two would drift.
    const confidence = confidenceFor(edge.resolution);
    tally.byResolution[edge.resolution] = (tally.byResolution[edge.resolution] ?? 0) + 1;
    tally.byConfidence[confidence] += 1;

    let targets: (string | null)[];
    if (edge.resolution === "ambiguous-name") {
      if (candidateIds.length < 2) {
        throw refuse(
          `ambiguous edge at ${where} carries ${candidateIds.length} candidate(s)`,
          { index: i, candidates: edge.candidates ?? [], path: edge.path, line: edge.line },
          "An ambiguous edge is only honest if it says what it might have meant; the store requires at least two candidates.",
        );
      }
      if (dstId !== null && !candidateIds.includes(dstId)) {
        // An edge that both claims ambiguity and names a target outside its own candidate set is
        // self-contradictory, and picking either reading would be guessing.
        throw refuse(
          `ambiguous edge at ${where} names dst ${JSON.stringify(edge.dst)}, which is not among its candidates`,
          { index: i, dst: edge.dst, candidates: edge.candidates ?? [] },
        );
      }
      targets = candidateIds;
      tally.ambiguousEdges += 1;
      tally.ambiguousRows += candidateIds.length;
    } else {
      if (dstId === null) tally.withoutTarget += 1;
      targets = [dstId];
    }

    for (const target of targets) {
      params.push(
        srcId,
        target,
        edge.dst_name,
        edge.kind,
        confidence,
        edge.resolution,
        // Built by hand rather than handed to pg's array serialiser: every element is a sequence
        // value, so it is digits and nothing else, and the literal is unambiguous.
        `{${candidateIds.join(",")}}`,
        edge.path,
        edge.line,
      );
      pending += 1;
      if (pending >= BATCH_ROWS) await flush();
    }
  }

  await flush();
  return tally.rows;
}

// ---------------------------------------------------------------------------------------
// Query.

/**
 * The index a query means: the named commit, or the newest completed one.
 *
 * Exported because the HTTP layer needs the index's *scope* before it runs the closure — a key is
 * bound to a scope subtree, and the scope lives on the index row, so the authorisation check
 * cannot happen until the index is known.
 *
 * One thing `datum.latest_index` does NOT mean: "the product's current code". It means "the newest
 * index we were given", and an index built on an unmerged branch describes code that does not
 * exist on the default branch. This is the same trap that let Arc's 757.5 tok/s — measured on a
 * commit 21 ahead of `master` — read back as though it had shipped. Every answer therefore reports
 * the `commit_sha` it came from, and a caller that cares whether that commit has landed asks the
 * verification side; the graph itself cannot know.
 */
export async function resolveIndex(
  db: Db,
  opts: { repo: string; commitSha?: string },
): Promise<ResolvedIndex> {
  const columns = `id, scope, repo, commit_sha, indexer, indexed_at, symbol_count, edge_count`;
  let row: ResolvedIndex | null;

  if (opts.commitSha) {
    if (!COMMIT_SHA.test(opts.commitSha)) {
      throw refuse(`commit ${JSON.stringify(opts.commitSha)} is not 7-40 lowercase hex`, {
        commit: opts.commitSha,
      });
    }
    row = await db.one<ResolvedIndex>(
      "app",
      // `completed_at IS NOT NULL` here as well as in `datum.latest_index`: naming a commit must
      // not be a way around the rule that a partial index answers nothing.
      // The prefix match is safe only because COMMIT_SHA above rules out `%` and `_`.
      `SELECT ${columns} FROM datum.code_index
        WHERE repo = $1 AND completed_at IS NOT NULL
          AND (commit_sha = $2 OR commit_sha LIKE $2 || '%')
        ORDER BY (commit_sha = $2) DESC, indexed_at DESC
        LIMIT 1`,
      [opts.repo, opts.commitSha],
    );
  } else {
    // See above: newest completed, which is not the same as newest merged.
    row = await db.one<ResolvedIndex>(
      "app",
      `SELECT ${columns} FROM datum.code_index WHERE id = datum.latest_index($1)`,
      [opts.repo],
    );
  }

  if (!row) {
    throw new Rejection({
      reason: "not_found",
      message: opts.commitSha
        ? `no completed index for ${opts.repo}@${opts.commitSha}`
        : `no completed index for ${opts.repo}`,
      detail: { repo: opts.repo, commit: opts.commitSha ?? null },
      hint: "Run `datum index --emit graph.json` then `datum ingest-graph graph.json`. An index that is still loading is invisible on purpose.",
    });
  }
  return row;
}

interface TargetRow {
  id: string;
  name: string;
  fqn: string | null;
  kind: string;
  path: string;
  line_start: number;
  exact_fqn: boolean;
}

/** `id:12169` — the one form that can always name exactly one symbol. */
const SYMBOL_BY_ID = /^id:([0-9]+)$/;

/**
 * Resolve a symbol id, a fully qualified name, or a bare name to exactly one symbol.
 *
 * Exact-first, in tiers, mirroring `/v1/ask`: an `id:` reference is absolute, then a
 * qualified-name hit wins outright, and only if nothing matches on `fqn` does a bare `name` count.
 * If the winning tier holds more than one symbol the query is refused with the candidate list.
 * Picking one and answering anyway would produce a confident impact report about the wrong
 * function, which is worse than no answer.
 *
 * The `id:` form exists because on real code a qualified name is NOT always unique, so telling a
 * caller to "qualify it" can be advice they cannot act on. Arc has seven distinct symbols whose
 * fqn is all exactly `vllm::fma` — C and CUDA overloads in `dtype_float16.cuh` and friends — and
 * without an absolute address there is no query that reaches any one of them, which would leave
 * every overloaded kernel in a 132-file CUDA tree permanently unanswerable. The refusal below
 * hands back the ids it found, so the next call is mechanical rather than a guess.
 */
async function resolveTarget(db: Db, indexId: string, symbol: string): Promise<TargetRow> {
  const columns = `id::text AS id, name, fqn, kind, path, line_start`;

  const byId = SYMBOL_BY_ID.exec(symbol);
  if (byId) {
    // Scoped to the index: an id from another index must not resolve here, or a caller could
    // silently ask one commit's question against another commit's graph.
    const row = await db.one<TargetRow>(
      "app",
      `SELECT ${columns}, true AS exact_fqn FROM datum.code_symbols
        WHERE index_id = $1 AND id = $2::bigint`,
      [indexId, byId[1]!],
    );
    if (!row) {
      throw new Rejection({
        reason: "not_found",
        message: `no symbol with id ${byId[1]} in this index`,
        detail: { symbol, index_id: indexId },
        hint: "Symbol ids belong to one index. Re-resolve against the commit you are querying.",
      });
    }
    return row;
  }

  const { rows } = await db.query<TargetRow>(
    "app",
    `SELECT ${columns}, coalesce(fqn = $2, false) AS exact_fqn
       FROM datum.code_symbols
      WHERE index_id = $1 AND (fqn = $2 OR name = $2)
      ORDER BY coalesce(fqn = $2, false) DESC, path, line_start
      LIMIT 201`,
    [indexId, symbol],
  );
  if (rows.length === 0) {
    throw new Rejection({
      reason: "not_found",
      message: `no symbol named ${JSON.stringify(symbol)} in this index`,
      detail: { symbol },
      hint: "GET /v1/graph/symbols?repo=&q= searches names and qualified names.",
    });
  }

  const exact = rows.filter((r) => r.exact_fqn);
  const tier = exact.length > 0 ? exact : rows;
  if (tier.length === 1) return tier[0]!;

  const candidates = tier.slice(0, 25).map((r) => ({
    id: r.id,
    fqn: r.fqn,
    kind: r.kind,
    path: r.path,
    line_start: r.line_start,
  }));
  // When every candidate carries the same fqn, "qualify it" is not advice a caller can act on —
  // the fqn is what they passed. Say the useful thing instead.
  const fqnWouldNotHelp = exact.length > 1 || new Set(tier.map((r) => r.fqn)).size === 1;
  throw refuse(
    `${JSON.stringify(symbol)} names ${tier.length > 200 ? "over 200" : String(tier.length)} symbols in this index`,
    {
      symbol,
      // A handful is enough to disambiguate by eye; the count is what says how bad it is. The
      // 201st row exists only so `capped` is measured rather than assumed.
      candidates,
      candidate_count: Math.min(tier.length, 200),
      capped: tier.length > 200,
      disambiguate_by: fqnWouldNotHelp ? "id" : "fqn",
    },
    fqnWouldNotHelp
      ? `These share one qualified name, so qualifying further cannot separate them. Address one directly: symbol=id:${candidates[0]!.id}. Choosing one for you would report an impact closure for the wrong symbol.`
      : `Pass the fully qualified name, or address one directly with symbol=id:${candidates[0]!.id}. Choosing one for you would report an impact closure for the wrong symbol.`,
  );
}

interface ImpactRow {
  symbol_id: string;
  depth: number;
  path_confidence: EdgeConfidence;
  via_kind: EdgeKind;
  name: string;
  fqn: string | null;
  kind: SymbolKind;
  file_path: string;
  line_start: number;
}

/** Nearest first, then most trustworthy, then stable by name. */
function presentationOrder(a: ImpactHop, b: ImpactHop): number {
  if (a.depth !== b.depth) return a.depth - b.depth;
  const rank = CONFIDENCE_RANK[a.path_confidence] - CONFIDENCE_RANK[b.path_confidence];
  if (rank !== 0) return rank;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export async function impact(
  db: Db,
  opts: { repo: string; symbol: string; commitSha?: string; depth?: number; kinds?: EdgeKind[] },
): Promise<ImpactResult> {
  const depth = opts.depth ?? DEFAULT_DEPTH;
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
    throw refuse(`depth must be an integer between 1 and ${MAX_DEPTH}`, { depth: opts.depth });
  }
  // Validated at the library boundary, not only in the route: an unrecognised kind would filter
  // every edge out and return an empty closure, which reads exactly like "nothing calls this".
  // A wrong answer that looks like a real one is the failure mode worth spending a check on.
  for (const kind of opts.kinds ?? []) {
    if (!Object.hasOwn(KNOWN_EDGE_KIND, kind)) {
      throw refuse(`unknown edge kind ${JSON.stringify(kind)}`, {
        kind,
        known: [...EDGE_KINDS],
      });
    }
  }
  const kinds = opts.kinds && opts.kinds.length > 0 ? opts.kinds : null;

  const index = await resolveIndex(db, { repo: opts.repo, commitSha: opts.commitSha });
  const target = await resolveTarget(db, index.id, opts.symbol);

  const { rows } = await db.query<ImpactRow>(
    "app",
    `WITH direct AS (
       SELECT * FROM datum.code_impact($1, $2::bigint, $3, $4::text[])
     ),
     -- Trait composition. An implements edge runs Type -> Trait, never method -> method: no
     -- implements edge in a real corpus names a method symbol. So "what breaks if I change this
     -- trait method" returned nothing, which reads exactly like "nothing implements this" — the
     -- most dangerous answer this tool can give, and the reason this is a product fix and not a
     -- benchmark workaround. What an engineer needs is the implementing methods, so the two hops
     -- the graph does hold are composed: the target's enclosing trait, every type implementing
     -- that trait, and that type's own method of the same name.
     enclosing_trait AS (
       SELECT t.id
         FROM datum.code_symbols me
         JOIN datum.code_symbols t
           ON t.index_id = me.index_id AND t.kind = 'trait' AND t.path = me.path
          AND me.line_start BETWEEN t.line_start AND t.line_end
        WHERE me.index_id = $1 AND me.id = $2::bigint AND me.kind IN ('method','function')
        -- Innermost enclosing trait, in case of nesting.
        ORDER BY t.line_end - t.line_start ASC
        LIMIT 1
     ),
     impl_methods AS (
       SELECT m.id AS symbol_id, 1 AS depth, e.confidence AS path_confidence,
              'implements'::text AS via_kind, m.name, m.fqn, m.kind, m.path AS file_path,
              m.line_start
         FROM enclosing_trait et
         JOIN datum.code_edges e
           ON e.index_id = $1 AND e.kind = 'implements' AND e.dst_id = et.id
         JOIN datum.code_symbols ty ON ty.id = e.src_id
         JOIN datum.code_symbols me ON me.index_id = $1 AND me.id = $2::bigint
         JOIN datum.code_symbols m
           ON m.index_id = $1 AND m.name = me.name AND m.kind IN ('method','function')
          -- Match on qualified name, NOT on the type's declaration span. In Rust the implementing
          -- method lives in an impl block that is nowhere near the struct it implements for, so a
          -- span-containment join finds nothing: on Arc it returned 1 of 9 known implementors of
          -- QuantMethod::gather_forward. The type's fqn plus the method name is the relation the
          -- language actually expresses, and it is exact rather than positional.
          AND (m.fqn = ty.fqn || '::' || me.name
               OR (ty.fqn IS NULL AND m.path = ty.path
                   AND m.line_start BETWEEN ty.line_start AND ty.line_end))
        WHERE $4::text[] IS NULL OR 'implements' = ANY($4::text[])
     )
     SELECT DISTINCT ON (symbol_id)
            symbol_id::text AS symbol_id, depth, path_confidence, via_kind,
            name, fqn, kind, file_path, line_start
       FROM (SELECT * FROM direct UNION ALL SELECT * FROM impl_methods) u
      -- Nearest and strongest hop wins per symbol, matching code_impact's own ordering.
      ORDER BY symbol_id, depth ASC,
               CASE path_confidence WHEN 'measured' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END`,
    [index.id, target.id, depth, kinds],
  );

  const counts: Record<EdgeConfidence, number> = { measured: 0, derived: 0, unverified: 0 };
  const reached: ImpactHop[] = [];
  const ambiguous: ImpactHop[] = [];
  const tests: ImpactHop[] = [];

  for (const row of rows) {
    const hop: ImpactHop = {
      symbol_id: row.symbol_id,
      depth: row.depth,
      path_confidence: row.path_confidence,
      via_kind: row.via_kind,
      name: row.name,
      fqn: row.fqn,
      kind: row.kind,
      path: row.file_path,
      line_start: row.line_start,
    };
    counts[hop.path_confidence] += 1;
    // The one branch that must never blur: an `unverified` path reached this symbol through a
    // name the indexer could not pin down, so it is reported as a maybe and never as a caller.
    if (hop.path_confidence === "unverified") ambiguous.push(hop);
    else reached.push(hop);
    // Coverage spans both classes on purpose. Every hop carries its own `path_confidence`, so a
    // test found only through a guessed edge is visible *as* a guess; dropping it would
    // under-report coverage exactly as silently as promoting it would over-report it, and the
    // doctrine is that an ambiguous hop is never dropped.
    if (hop.kind === "test") tests.push(hop);
  }

  reached.sort(presentationOrder);
  ambiguous.sort(presentationOrder);
  tests.sort(presentationOrder);

  return {
    repo: index.repo,
    commit_sha: index.commit_sha,
    target: {
      name: target.name,
      fqn: target.fqn,
      path: target.path,
      line_start: target.line_start,
    },
    max_depth: depth,
    reached_by: reached,
    covered_by_tests: tests,
    ambiguous,
    counts,
  };
}

/**
 * Symbol search over one index.
 *
 * Substring rather than `LIKE`: the query is scoped to a single index's symbols so the scan is
 * bounded, and `strpos` needs no wildcard escaping — which is where a search like this normally
 * grows a bug that lets `%` from a caller turn into a full scan of every name.
 */
export async function searchSymbols(
  db: Db,
  opts: { repo: string; q: string; commitSha?: string; limit?: number },
): Promise<{ index: ResolvedIndex; symbols: SymbolMatch[] }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const index = await resolveIndex(db, { repo: opts.repo, commitSha: opts.commitSha });
  const { rows } = await db.query<SymbolMatch>(
    "app",
    `SELECT id::text AS id, kind, name, fqn, language, path, line_start, line_end,
            visibility, signature
       FROM datum.code_symbols
      WHERE index_id = $1
        AND (name = $2 OR fqn = $2
             OR strpos(lower(name), lower($2)) > 0
             OR strpos(lower(coalesce(fqn, '')), lower($2)) > 0)
      ORDER BY CASE WHEN name = $2 OR fqn = $2 THEN 0 ELSE 1 END,
               length(name), name, path, line_start
      LIMIT $3`,
    [index.id, opts.q, limit],
  );
  return { index, symbols: rows };
}
