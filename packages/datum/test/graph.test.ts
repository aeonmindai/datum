import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { loadConfig, type Config } from "../src/config.js";
import type { Db } from "../src/db/pool.js";
import { mintKey } from "../src/http/auth.js";
import { impact, ingestGraph, registerGraphRoutes, resolveIndex, searchSymbols } from "../src/graph/index.js";
import type { GraphArtifact, GraphEdge, GraphSymbol } from "../src/graph/types.js";

/**
 * The code graph, against a real Postgres.
 *
 * Nothing here is stubbed, and it could not be: the reverse closure, the weakest-link rule and the
 * `completed_at` visibility gate are all implemented in SQL (migration 008). A fake database would
 * test the shape of this file and none of the behaviour that matters.
 *
 * Each case gets its own repo name rather than its own database. `datum.latest_index` is keyed by
 * repo, so distinct repos give each case an independent "newest index" without paying for a fork.
 */

const DB = "datum_graph";
let pg: TestPostgres;
let db: Db;
let config: Config;
let app: FastifyInstance;
/** Bound to `code`, the parent of every scope these artifacts default to. */
let key: string;
/** Bound to a sibling subtree, so it must be refused. */
let narrowKey: string;

let commits = 0;
/** A distinct, well-formed sha per artifact. `code_index_commit_shape` wants 7-40 lowercase hex. */
function nextCommit(): string {
  commits += 1;
  return commits.toString(16).padStart(4, "0").repeat(2);
}

function sym(name: string, over: Partial<GraphSymbol> = {}): GraphSymbol {
  return {
    key: `src/${name}.rs#1:function:${name}`,
    kind: "function",
    name,
    fqn: `crate::${name}`,
    language: "rust",
    path: `src/${name}.rs`,
    line_start: 1,
    line_end: 10,
    ...over,
  };
}

function edge(src: GraphSymbol, dst: GraphSymbol | null, over: Partial<GraphEdge> = {}): GraphEdge {
  return {
    src: src.key,
    dst: dst?.key ?? null,
    dst_name: dst?.name ?? "unknown",
    kind: "calls",
    resolution: "compiler",
    path: src.path,
    line: 5,
    ...over,
  };
}

function artifact(repo: string, symbols: GraphSymbol[], edges: GraphEdge[]): GraphArtifact {
  return {
    version: 1,
    repo,
    commit_sha: nextCommit(),
    indexer: "test/1",
    languages: ["rust"],
    file_count: symbols.length,
    symbols,
    edges,
  };
}

const names = (hops: Array<{ name: string }>): string[] => hops.map((h) => h.name);
const depths = (hops: Array<{ name: string; depth: number }>): Record<string, number> =>
  Object.fromEntries(hops.map((h) => [h.name, h.depth]));

beforeAll(async () => {
  pg = await startPostgres();
  db = await pg.fork(DB);
  config = loadConfig({
    DATABASE_URL: pg.url(DB),
    DATUM_ORG: "test",
    DATUM_ADMIN_PASSWORD: "correct-horse-battery-staple",
    DATUM_SESSION_SECRET: "s".repeat(48),
  });
  // A bare instance, not `buildServer`: this exercises the registrar in isolation, so the suite
  // does not depend on when the graph routes get wired into the server.
  app = Fastify({ logger: false });
  registerGraphRoutes(app, { db, config });
  await app.ready();

  key = (
    await mintKey(db, {
      label: "graph",
      scope: "code",
      permissions: ["read"],
      expiresAt: null,
      createdBy: "graph.test",
    })
  ).secret;
  narrowKey = (
    await mintKey(db, {
      label: "graph-narrow",
      scope: "code/elsewhere",
      permissions: ["read"],
      expiresAt: null,
      createdBy: "graph.test",
    })
  ).secret;
  console.log(`\n  real postgres ${pg.version} in container ${pg.container}\n`);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.close().catch(() => {});
  await pg?.stop();
});

describe("ingest", () => {
  it("loads symbols and edges, stamps counts, and refuses a second load of the same commit", async () => {
    const [a, b] = [sym("alpha"), sym("beta")];
    const art = artifact("acme/ingest", [a, b], [edge(b, a)]);
    const loaded = await ingestGraph(db, art, { scope: "code/acme/ingest" });

    expect(loaded.symbols).toBe(2);
    expect(loaded.edges).toBe(1);

    const row = await db.one<{
      scope: string;
      symbol_count: number;
      edge_count: number;
      completed_at: Date | null;
      languages: string[];
      stats: Record<string, Record<string, unknown>>;
    }>(
      "app",
      `SELECT scope, symbol_count, edge_count, completed_at, languages, stats
         FROM datum.code_index WHERE id = $1`,
      [loaded.indexId],
    );
    expect(row).toMatchObject({ scope: "code/acme/ingest", symbol_count: 2, edge_count: 1 });
    expect(row!.completed_at).not.toBeNull();
    expect(row!.languages).toEqual(["rust"]);
    expect(row!.stats.loader).toMatchObject({
      artifact_edges: 1,
      edge_rows: 1,
      edges_by_confidence: { measured: 1, derived: 0, unverified: 0 },
    });

    // Indexes are never mutated, so the same (repo, commit, indexer) cannot be loaded twice; the
    // refusal names the index that already holds it.
    await expect(ingestGraph(db, { ...art }, { scope: "code/acme/ingest" })).rejects.toMatchObject({
      name: "Rejection",
      http: 400,
      detail: { index_id: loaded.indexId },
    });
  });

  it("derives a scope from the repo slug when none is given", async () => {
    const a = sym("solo");
    const loaded = await ingestGraph(db, artifact("acme/scoped", [a], []));
    const row = await db.one<{ scope: string }>(
      "app",
      `SELECT scope FROM datum.code_index WHERE id = $1`,
      [loaded.indexId],
    );
    expect(row!.scope).toBe("code/acme/scoped");
  });

  it("refuses an edge naming a symbol the artifact does not contain", async () => {
    const a = sym("known");
    const bad = artifact("acme/dangling", [a], [
      { ...edge(a, null), dst: "src/ghost.rs#1:function:ghost", dst_name: "ghost" },
    ]);
    await expect(ingestGraph(db, bad)).rejects.toMatchObject({
      name: "Rejection",
      detail: { dst: "src/ghost.rs#1:function:ghost" },
    });
    // Atomic: the failed load left nothing behind, so the same commit can be retried.
    const row = await db.one("app", `SELECT id FROM datum.code_index WHERE repo = $1`, [
      "acme/dangling",
    ]);
    expect(row).toBeNull();
  });
});

describe("impact — the reverse dependency closure", () => {
  it("returns the right closure at depth 2 and depth 3 of a three-hop chain", async () => {
    const [target, c, b, a] = [sym("target"), sym("cee"), sym("bee"), sym("aye")];
    const repo = "acme/chain";
    const art = artifact(repo, [target, c, b, a], [edge(c, target), edge(b, c), edge(a, b)]);
    await ingestGraph(db, art);

    const two = await impact(db, { repo, symbol: "crate::target", depth: 2 });
    expect(two.max_depth).toBe(2);
    expect(depths(two.reached_by)).toEqual({ cee: 1, bee: 2 });
    expect(two.counts).toEqual({ measured: 2, derived: 0, unverified: 0 });
    expect(two.ambiguous).toEqual([]);
    expect(two.target).toMatchObject({ name: "target", fqn: "crate::target" });
    expect(two.commit_sha).toBe(art.commit_sha);

    const three = await impact(db, { repo, symbol: "crate::target", depth: 3 });
    expect(depths(three.reached_by)).toEqual({ cee: 1, bee: 2, aye: 3 });
    // Nearest first is the presentation contract; the SQL orders by symbol_id because DISTINCT ON
    // forces it, so this is checking the sort this module applies on top.
    expect(names(three.reached_by)).toEqual(["cee", "bee", "aye"]);

    // A bare name resolves as well as a qualified one when only one symbol bears it.
    const bare = await impact(db, { repo, symbol: "target", depth: 1 });
    expect(names(bare.reached_by)).toEqual(["cee"]);
  });

  it("terminates on a cycle instead of looping", async () => {
    const [target, a, b] = [sym("cyc_target"), sym("cyc_a"), sym("cyc_b")];
    const repo = "acme/cycle";
    // a -> target, and a <-> b in both directions: the closure must visit each once.
    await ingestGraph(db, artifact(repo, [target, a, b], [edge(a, target), edge(b, a), edge(a, b)]));

    const result = await impact(db, { repo, symbol: "cyc_target", depth: 8 });
    expect(depths(result.reached_by)).toEqual({ cyc_a: 1, cyc_b: 2 });
    expect(result.counts.measured).toBe(2);
  });

  it("keeps an ambiguous hop out of reached_by and reports it as ambiguous", async () => {
    // Two symbols named `helper`; the caller references the name and the indexer could not tell
    // which, so the edge arrives with dst null and both candidates.
    const one = sym("helper", { key: "src/one.rs#3:function:helper", fqn: "crate::one::helper", path: "src/one.rs" });
    const two = sym("helper", { key: "src/two.rs#9:function:helper", fqn: "crate::two::helper", path: "src/two.rs" });
    const caller = sym("guesser");
    const repo = "acme/ambiguous";
    await ingestGraph(
      db,
      artifact(repo, [one, two, caller], [
        {
          ...edge(caller, null),
          dst_name: "helper",
          resolution: "ambiguous-name",
          candidates: [one.key, two.key],
        },
      ]),
    );

    const result = await impact(db, { repo, symbol: "crate::one::helper" });
    expect(result.reached_by).toEqual([]);
    expect(names(result.ambiguous)).toEqual(["guesser"]);
    expect(result.ambiguous[0]!.path_confidence).toBe("unverified");
    expect(result.counts).toEqual({ measured: 0, derived: 0, unverified: 1 });

    // The other candidate is reached too — "it may also be this one" is the whole point.
    const other = await impact(db, { repo, symbol: "crate::two::helper" });
    expect(names(other.ambiguous)).toEqual(["guesser"]);

    // Both rows carry the full candidate set, which is what makes the fan-out reconstructable.
    const rows = await db.query<{ candidates: string[]; dst_id: string }>(
      "app",
      `SELECT candidates, dst_id::text FROM datum.code_edges
         WHERE index_id = datum.latest_index($1) AND resolution = 'ambiguous-name'`,
      [repo],
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) expect(row.candidates).toHaveLength(2);

    // And a bare `helper` is refused rather than silently resolved to one of them.
    await expect(impact(db, { repo, symbol: "helper" })).rejects.toMatchObject({
      name: "Rejection",
      http: 400,
      detail: { candidate_count: 2 },
    });
  });

  it("reports the weakest link on the path, not the strongest", async () => {
    const target = sym("weak_target");
    // measured hop, then a derived hop, then an ambiguous hop.
    const near = sym("weak_near");
    const mid = sym("weak_mid");
    const far = sym("weak_far");
    const decoy = sym("weak_mid_decoy", { name: "weak_mid", fqn: "crate::decoy::weak_mid" });
    const repo = "acme/weakest";
    await ingestGraph(
      db,
      artifact(repo, [target, near, mid, far, decoy], [
        edge(near, target),
        edge(mid, near, { resolution: "unique-name" }),
        {
          ...edge(far, null),
          dst_name: "weak_mid",
          resolution: "ambiguous-name",
          candidates: [mid.key, decoy.key],
        },
      ]),
    );

    const result = await impact(db, { repo, symbol: "crate::weak_target", depth: 4 });
    const confidence = Object.fromEntries(
      [...result.reached_by, ...result.ambiguous].map((h) => [h.name, h.path_confidence]),
    );
    // measured alone stays measured; measured + derived degrades to derived; adding an
    // unverified hop degrades the whole path to unverified.
    expect(confidence).toEqual({
      weak_near: "measured",
      weak_mid: "derived",
      weak_far: "unverified",
    });
    expect(names(result.reached_by)).toEqual(["weak_near", "weak_mid"]);
    expect(names(result.ambiguous)).toEqual(["weak_far"]);
    expect(result.counts).toEqual({ measured: 1, derived: 1, unverified: 1 });
  });

  it("prefers the certain path when the same caller also reaches the target by a guess", async () => {
    // One function calling another twice: line 5 resolved by the compiler, line 9 a name the
    // indexer could not pin down. The caller IS a caller — there is a path that is a fact — so it
    // belongs in reached_by, and the guess about the same pair adds nothing to report separately.
    const target = sym("both_target");
    const decoy = sym("both_target_decoy", { name: "both_target", fqn: "crate::decoy::both_target" });
    const caller = sym("both_caller");
    const repo = "acme/both";
    await ingestGraph(
      db,
      artifact(repo, [target, decoy, caller], [
        edge(caller, target, { line: 5 }),
        {
          ...edge(caller, null),
          dst_name: "both_target",
          line: 9,
          resolution: "ambiguous-name",
          candidates: [target.key, decoy.key],
        },
      ]),
    );

    const result = await impact(db, { repo, symbol: "crate::both_target" });
    expect(names(result.reached_by)).toEqual(["both_caller"]);
    expect(result.reached_by[0]!.path_confidence).toBe("measured");
    expect(result.ambiguous).toEqual([]);
    expect(result.counts).toEqual({ measured: 1, derived: 0, unverified: 0 });
  });

  it("stores an unresolved edge without letting it reach anything", async () => {
    // "This calls something I could not find" is information, not noise, so the row is written
    // with a null target and the name it was looking for. It cannot appear in a closure, because
    // there is nothing at the far end of it to close over.
    const caller = sym("blind_caller");
    const other = sym("blind_target");
    const repo = "acme/unresolved";
    await ingestGraph(
      db,
      artifact(repo, [caller, other], [
        { ...edge(caller, null), dst_name: "extern_thing", resolution: "unresolved" },
      ]),
    );

    const row = await db.one<{
      dst_id: string | null;
      dst_name: string;
      confidence: string;
      candidates: string[];
    }>(
      "app",
      `SELECT dst_id::text, dst_name, confidence, candidates FROM datum.code_edges
         WHERE index_id = datum.latest_index($1)`,
      [repo],
    );
    expect(row).toMatchObject({
      dst_id: null,
      dst_name: "extern_thing",
      confidence: "unverified",
      candidates: [],
    });

    const result = await impact(db, { repo, symbol: "crate::blind_target" });
    expect(result.reached_by).toEqual([]);
    expect(result.ambiguous).toEqual([]);

    const stats = await db.one<{ stats: Record<string, Record<string, unknown>> }>(
      "app",
      `SELECT stats FROM datum.code_index WHERE id = datum.latest_index($1)`,
      [repo],
    );
    expect(stats!.stats.loader).toMatchObject({ edges_without_target: 1, edge_rows: 1 });
  });

  it("lists the tests that reach the target, ambiguous coverage included but labelled", async () => {
    const target = sym("covered");
    const caller = sym("caller");
    const spec = sym("test_covered_works", { kind: "test", path: "tests/covered.rs" });
    const maybe = sym("test_maybe_covers", { kind: "test", path: "tests/maybe.rs" });
    const decoy = sym("caller", { key: "src/decoy.rs#1:function:caller", fqn: "crate::decoy::caller", path: "src/decoy.rs" });
    const repo = "acme/coverage";
    await ingestGraph(
      db,
      artifact(repo, [target, caller, spec, maybe, decoy], [
        edge(caller, target),
        edge(spec, target, { kind: "tests" }),
        {
          ...edge(maybe, null),
          dst_name: "caller",
          kind: "calls",
          resolution: "ambiguous-name",
          candidates: [caller.key, decoy.key],
        },
      ]),
    );

    const result = await impact(db, { repo, symbol: "crate::covered", depth: 3 });
    expect(names(result.covered_by_tests)).toEqual(["test_covered_works", "test_maybe_covers"]);
    const byName = Object.fromEntries(
      result.covered_by_tests.map((h) => [h.name, h.path_confidence]),
    );
    // A test found only through a guessed edge is reported as coverage-with-a-caveat rather than
    // dropped: dropping it under-reports coverage exactly as silently as promoting it would
    // over-report it, and only one of the two arrays may claim certainty.
    expect(byName).toEqual({ test_covered_works: "measured", test_maybe_covers: "unverified" });
    expect(names(result.reached_by)).toEqual(["caller", "test_covered_works"]);
    expect(names(result.ambiguous)).toEqual(["test_maybe_covers"]);

    // The kind filter reaches the closure function's own parameter.
    const onlyTests = await impact(db, { repo, symbol: "crate::covered", kinds: ["tests"] });
    expect(names(onlyTests.reached_by)).toEqual(["test_covered_works"]);
  });

  it("refuses a symbol that is not in the index, and an out-of-range depth", async () => {
    const repo = "acme/chain";
    await expect(impact(db, { repo, symbol: "nope" })).rejects.toMatchObject({
      name: "Rejection",
      http: 404,
    });
    await expect(impact(db, { repo, symbol: "target", depth: 99 })).rejects.toMatchObject({
      name: "Rejection",
      http: 400,
    });
    await expect(
      impact(db, { repo, symbol: "target", kinds: ["invented" as "calls"] }),
    ).rejects.toMatchObject({ name: "Rejection", http: 400 });
  });
});

describe("an index that never finished loading", () => {
  const repo = "acme/partial";

  it("is invisible to every query, even when its commit is named", async () => {
    // Written by hand as the owner, because the loader is atomic and therefore cannot produce
    // this state: a crashed or killed load is what produces it in the field, and the point of
    // the test is that the *query* side refuses to read it.
    const partialCommit = "aaaaaaa";
    await db.query(
      "owner",
      `INSERT INTO datum.code_index (id, scope, repo, commit_sha, indexer)
       VALUES ('cidx_partial', 'code/acme/partial', $1, $2, 'test/1')`,
      [repo, partialCommit],
    );
    await db.query(
      "owner",
      `INSERT INTO datum.code_symbols (index_id, kind, name, fqn, language, path, line_start, line_end)
       VALUES ('cidx_partial','function','ghost','crate::ghost','rust','src/ghost.rs',1,2),
              ('cidx_partial','function','ghost_caller','crate::ghost_caller','rust','src/gc.rs',1,2)`,
    );
    const symbols = await db.query<{ id: string; name: string }>(
      "owner",
      `SELECT id::text, name FROM datum.code_symbols WHERE index_id = 'cidx_partial'`,
    );
    const idOf = (name: string): string => symbols.rows.find((r) => r.name === name)!.id;
    await db.query(
      "owner",
      `INSERT INTO datum.code_edges
         (index_id, src_id, dst_id, dst_name, kind, confidence, resolution, path, line)
       VALUES ('cidx_partial', $1, $2, 'ghost', 'calls', 'measured', 'compiler', 'src/gc.rs', 4)`,
      [idOf("ghost_caller"), idOf("ghost")],
    );

    const latest = await db.one<{ id: string | null }>(
      "app",
      `SELECT datum.latest_index($1) AS id`,
      [repo],
    );
    expect(latest!.id).toBeNull();

    await expect(resolveIndex(db, { repo })).rejects.toMatchObject({ http: 404 });
    await expect(impact(db, { repo, symbol: "ghost" })).rejects.toMatchObject({ http: 404 });
    // Naming the commit is not a way around the gate.
    await expect(
      impact(db, { repo, symbol: "ghost", commitSha: partialCommit }),
    ).rejects.toMatchObject({ http: 404 });
  });

  it("does not shadow a completed index for the same repo", async () => {
    const [target, caller] = [sym("real"), sym("real_caller")];
    const art = artifact(repo, [target, caller], [edge(caller, target)]);
    await ingestGraph(db, art, { scope: "code/acme/partial" });

    const result = await impact(db, { repo, symbol: "crate::real" });
    expect(result.commit_sha).toBe(art.commit_sha);
    expect(names(result.reached_by)).toEqual(["real_caller"]);
    // The partial index's symbols remain unreachable.
    await expect(impact(db, { repo, symbol: "ghost" })).rejects.toMatchObject({ http: 404 });
  });
});

describe("symbol search", () => {
  it("ranks exact matches first and finds substrings", async () => {
    const repo = "acme/search";
    await ingestGraph(
      db,
      artifact(
        repo,
        [
          sym("gather"),
          sym("gather_forward"),
          sym("scatter_gather", { path: "src/sg.rs" }),
          sym("unrelated"),
        ],
        [],
      ),
    );
    const found = await searchSymbols(db, { repo, q: "gather" });
    expect(names(found.symbols)).toEqual(["gather", "gather_forward", "scatter_gather"]);
    expect(found.index.repo).toBe(repo);

    // `%` is a literal here, not a wildcard: the search uses strpos, not LIKE.
    const wildcard = await searchSymbols(db, { repo, q: "%" });
    expect(wildcard.symbols).toEqual([]);
  });
});

describe("routes", () => {
  const get = (url: string, bearer?: string) =>
    app.inject({
      method: "GET",
      url,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });

  it("answers 401 before 400: authentication precedes input validation", async () => {
    // Deliberate: a request missing every required parameter still gets 401, because parsing
    // first would let an anonymous caller map the request schema by reading 400s.
    for (const url of ["/v1/impact", "/v1/graph/symbols"]) {
      const anon = await get(url);
      expect(anon.statusCode, url).toBe(401);
      expect(anon.json().reason).toBe("unauthorized");
    }
  });

  it("serves an impact closure with the index that answered it", async () => {
    const res = await get("/v1/impact?repo=acme/chain&symbol=crate::target&depth=2", key);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.repo).toBe("acme/chain");
    expect(body.max_depth).toBe(2);
    expect(names(body.reached_by)).toEqual(["cee", "bee"]);
    expect(body.ambiguous).toEqual([]);
    expect(body.index).toMatchObject({ scope: "code/acme/chain", indexer: "test/1" });

    const filtered = await get(
      "/v1/impact?repo=acme/coverage&symbol=crate::covered&kinds=tests",
      key,
    );
    expect(names(filtered.json().reached_by)).toEqual(["test_covered_works"]);
  });

  it("serves symbol search", async () => {
    const res = await get("/v1/graph/symbols?repo=acme/search&q=gather&limit=2", key);
    expect(res.statusCode).toBe(200);
    expect(names(res.json().symbols)).toEqual(["gather", "gather_forward"]);
  });

  it("refuses a key bound to another scope subtree", async () => {
    for (const url of [
      "/v1/impact?repo=acme/chain&symbol=crate::target",
      "/v1/graph/symbols?repo=acme/chain&q=target",
    ]) {
      const res = await get(url, narrowKey);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().reason).toBe("forbidden");
    }
  });

  it("reports a bad parameter as a 400 naming the field, and a missing index as a 404", async () => {
    const bad = await get("/v1/impact?repo=acme/chain&symbol=crate::target&depth=99", key);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain("depth");

    const badKinds = await get("/v1/impact?repo=acme/chain&symbol=crate::target&kinds=nope", key);
    expect(badKinds.statusCode).toBe(400);

    const missing = await get("/v1/impact?repo=acme/nothing&symbol=x", key);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().reason).toBe("not_found");
  });
});

describe("throughput", () => {
  it("loads a 20k-edge artifact through the batched path", async () => {
    const SYMBOLS = 5_000;
    const EDGES = 20_000;
    const repo = "acme/throughput";
    const symbols: GraphSymbol[] = [];
    for (let i = 0; i < SYMBOLS; i += 1) {
      symbols.push(
        sym(`fn_${i}`, {
          key: `src/m${i % 200}.rs#${i}:function:fn_${i}`,
          path: `src/m${i % 200}.rs`,
          line_start: i + 1,
          line_end: i + 4,
          signature: `fn fn_${i}(x: u32) -> u32`,
          signature_hash: `sha256:${i.toString(16).padStart(8, "0")}`,
        }),
      );
    }
    const edges: GraphEdge[] = [];
    for (let i = 0; i < EDGES; i += 1) {
      // A fan of callers per callee, plus a long spine, so the closure has real branching.
      const src = symbols[i % SYMBOLS]!;
      const dst = symbols[(i * 7 + 1) % SYMBOLS]!;
      edges.push(edge(src, dst, { line: i + 1, resolution: i % 5 === 0 ? "unique-name" : "compiler" }));
    }

    const started = Date.now();
    const loaded = await ingestGraph(db, artifact(repo, symbols, edges), { scope: "code/acme/tp" });
    const elapsedMs = Date.now() - started;

    expect(loaded.symbols).toBe(SYMBOLS);
    expect(loaded.edges).toBe(EDGES);

    const rows = SYMBOLS + EDGES;
    const perSecond = Math.round((rows / elapsedMs) * 1000);
    console.log(
      `\n  ingest: ${rows} rows (${SYMBOLS} symbols + ${EDGES} edges) in ${elapsedMs} ms ` +
        `= ${perSecond} rows/sec\n`,
    );

    // The number above is the deliverable; this bound only catches a regression to
    // row-at-a-time, which would be two orders of magnitude slower than the batched path.
    expect(elapsedMs).toBeLessThan(60_000);

    // And the loaded graph answers: one query over 20k edges, four levels deep.
    const result = await impact(db, { repo, symbol: "crate::fn_1", depth: 4 });
    expect(result.reached_by.length + result.ambiguous.length).toBeGreaterThan(0);
    expect(result.counts.measured + result.counts.derived).toBe(
      result.reached_by.length,
    );
  }, 180_000);
});
