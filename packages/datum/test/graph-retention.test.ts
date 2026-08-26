import { gzipSync } from "node:zlib";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { loadConfig, type Config } from "../src/config.js";
import type { Db } from "../src/db/pool.js";
import { assertFact } from "../src/domain/store.js";
import { mintKey } from "../src/http/auth.js";
import { registerGraphRoutes } from "../src/graph/routes.js";
import { impact, ingestGraph, pruneIndexes, resolveIndex } from "../src/graph/store.js";
import type { GraphArtifact, GraphEdge, GraphSymbol } from "../src/graph/types.js";

/**
 * Retention, and ingest over HTTP — against a real Postgres.
 *
 * Both halves are database behaviour and neither could be faked. Retention rests on the ON DELETE
 * CASCADE declared in 008, on the DELETE grant added in 014, and on `datum.latest_index` agreeing
 * with the pruner about which index is newest; the ingest route rests on a real transaction
 * rolling a failed load back. A stubbed database would test the shape of this file and none of
 * that.
 *
 * The two are one file because they are one feature: automating the indexer without bounding what
 * it writes would fill the volume, so the route that makes indexing automatic and the pass that
 * makes it bounded are verified together.
 */

const DB = "datum_graph_retention";
const ORG = "test";
/** Every artifact here is ingested under the org tree, which is where the route puts one. */
const scopeFor = (repo: string): string => `org/${ORG}/proj/${repo.split("/").pop()}`;

let pg: TestPostgres;
let db: Db;
let config: Config;
let app: FastifyInstance;
/** assert + read, bound to the org root: what a git hook or CI runner would carry. */
let hookKey: string;
/** read only: must not be able to spend this route's raised body limit. */
let readKey: string;
/** assert, but bound to a sibling project: must be refused on scope. */
let elsewhereKey: string;

let commits = 0;
function nextCommit(): string {
  commits += 1;
  return commits.toString(16).padStart(4, "0").repeat(2);
}

function sym(name: string, over: Partial<GraphSymbol> = {}): GraphSymbol {
  const lineStart = over.line_start ?? 1;
  return {
    key: `src/${name}.rs#1:function:${name}`,
    kind: "function",
    name,
    fqn: `crate::${name}`,
    language: "rust",
    path: `src/${name}.rs`,
    line_start: lineStart,
    line_end: lineStart + 9,
    ...over,
  };
}

function edge(src: GraphSymbol, dst: GraphSymbol): GraphEdge {
  return {
    src: src.key,
    dst: dst.key,
    dst_name: dst.name,
    kind: "calls",
    resolution: "compiler",
    path: src.path,
    line: 5,
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

/**
 * `n` symbols in a chain, so an index of a known, varying size can be built.
 *
 * The sizes have to differ between indexes: `freed_symbols` matching a *constant* would prove
 * nothing about whether the pruner counted the rows it actually deleted.
 */
function chain(repo: string, n: number): GraphArtifact {
  const symbols = Array.from({ length: n }, (_, i) => sym(`${repo.split("/").pop()}_${n}_${i}`));
  const edges: GraphEdge[] = [];
  for (let i = 1; i < symbols.length; i += 1) {
    const src = symbols[i];
    const dst = symbols[i - 1];
    if (src && dst) edges.push(edge(src, dst));
  }
  return artifact(repo, symbols, edges);
}

/** Retention is disabled during setup so a test can build a backlog to prune. */
const NO_PRUNE = 1_000;

interface RowCounts {
  symbols: number;
  edges: number;
}

async function countsFor(indexId: string): Promise<RowCounts> {
  const row = await db.one<{ symbols: string; edges: string }>(
    "owner",
    `SELECT (SELECT count(*) FROM datum.code_symbols WHERE index_id = $1) AS symbols,
            (SELECT count(*) FROM datum.code_edges   WHERE index_id = $1) AS edges`,
    [indexId],
  );
  return { symbols: Number(row?.symbols ?? -1), edges: Number(row?.edges ?? -1) };
}

async function indexIdsFor(repo: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    "owner",
    `SELECT id FROM datum.code_index
      WHERE repo = $1 AND completed_at IS NOT NULL
      ORDER BY indexed_at DESC, id DESC`,
    [repo],
  );
  return rows.map((r) => r.id);
}

/**
 * The ledger, byte for byte.
 *
 * `md5(a::text)` over every row ordered by id is the cheapest thing that changes if any column of
 * any assertion changes. A count alone would miss a rewrite, which is precisely the failure mode a
 * DELETE grant in the schema has to be proven not to have opened.
 */
async function ledgerFingerprint(): Promise<{ rows: number; checksum: string }> {
  const row = await db.one<{ rows: string; checksum: string }>(
    "owner",
    `SELECT count(*) AS rows,
            coalesce(md5(string_agg(a::text, '|' ORDER BY a.id)), 'empty') AS checksum
       FROM datum.assertions a`,
  );
  return { rows: Number(row?.rows ?? -1), checksum: row?.checksum ?? "missing" };
}

const post = (
  payload: string | Buffer,
  opts: { bearer?: string; encoding?: string; query?: string } = {},
) =>
  app.inject({
    method: "POST",
    url: `/v1/graph/index${opts.query ?? ""}`,
    headers: {
      "content-type": "application/json",
      ...(opts.encoding ? { "content-encoding": opts.encoding } : {}),
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    },
    payload,
  });

beforeAll(async () => {
  pg = await startPostgres();
  db = await pg.fork(DB);
  config = loadConfig({
    DATABASE_URL: pg.url(DB),
    DATUM_ORG: ORG,
    DATUM_ADMIN_PASSWORD: "correct-horse-battery-staple",
    DATUM_SESSION_SECRET: "s".repeat(48),
  });
  app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  registerGraphRoutes(app, { db, config });
  await app.ready();

  hookKey = (
    await mintKey(db, {
      label: "git-hook",
      scope: `org/${ORG}`,
      permissions: ["read", "assert"],
      expiresAt: null,
      createdBy: "graph-retention.test",
    })
  ).secret;
  readKey = (
    await mintKey(db, {
      label: "reader",
      scope: `org/${ORG}`,
      permissions: ["read"],
      expiresAt: null,
      createdBy: "graph-retention.test",
    })
  ).secret;
  elsewhereKey = (
    await mintKey(db, {
      label: "other-project",
      scope: `org/${ORG}/proj/elsewhere`,
      permissions: ["read", "assert"],
      expiresAt: null,
      createdBy: "graph-retention.test",
    })
  ).secret;
  console.log(`\n  real postgres ${pg.version} in container ${pg.container}\n`);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.close().catch(() => {});
  await pg?.stop();
});

describe("pruneIndexes", () => {
  it("keeps the newest three and reports what the two it dropped actually held", async () => {
    const repo = "acme/retain";
    const loaded: string[] = [];
    // Ascending sizes, oldest first: 2, 4, 6, 8, 10 symbols.
    for (let i = 1; i <= 5; i += 1) {
      const result = await ingestGraph(db, chain(repo, i * 2), {
        scope: scopeFor(repo),
        keep: NO_PRUNE,
      });
      expect(result.pruned).toEqual([]);
      loaded.push(result.indexId);
    }
    expect(await indexIdsFor(repo)).toEqual([...loaded].reverse());

    const [oldest, second] = loaded;
    if (!oldest || !second) throw new Error("setup did not load five indexes");
    // Measured from the rows themselves, so the expectation cannot agree with the pruner by
    // sharing its arithmetic.
    const before = await Promise.all([countsFor(oldest), countsFor(second)]);
    const expectedSymbols = before.reduce((sum, c) => sum + c.symbols, 0);
    const expectedEdges = before.reduce((sum, c) => sum + c.edges, 0);

    const pruned = await pruneIndexes(db, { repo, keep: 3 });
    expect(pruned.deleted.slice().sort()).toEqual([oldest, second].sort());
    expect(pruned.kept).toEqual(loaded.slice(2).reverse());
    expect(pruned.freed_symbols).toBe(expectedSymbols);
    expect(pruned.freed_edges).toBe(expectedEdges);
    // 2 + 4 symbols and 1 + 3 edges, stated so a silent change in `chain` cannot make the
    // assertion above vacuous.
    expect({ symbols: expectedSymbols, edges: expectedEdges }).toEqual({ symbols: 6, edges: 4 });

    expect(await indexIdsFor(repo)).toEqual(loaded.slice(2).reverse());
  });

  it("never deletes the newest completed index, even asked to keep none", async () => {
    const repo = "acme/floor";
    const older = await ingestGraph(db, chain(repo, 3), { scope: scopeFor(repo), keep: NO_PRUNE });
    const newest = await ingestGraph(db, chain(repo, 3), { scope: scopeFor(repo), keep: NO_PRUNE });

    const pruned = await pruneIndexes(db, { repo, keep: 0 });
    expect(pruned.deleted).toEqual([older.indexId]);
    expect(pruned.kept).toEqual([newest.indexId]);

    // And again with nothing left to drop: the floor holds on a repo with one index.
    const again = await pruneIndexes(db, { repo, keep: 0 });
    expect(again).toEqual({ deleted: [], kept: [newest.indexId], freed_symbols: 0, freed_edges: 0 });
    const latest = await db.one<{ id: string | null }>(
      "app",
      "SELECT datum.latest_index($1) AS id",
      [repo],
    );
    expect(latest?.id).toBe(newest.indexId);
  });

  it("never deletes an index that never finished loading", async () => {
    const repo = "acme/inflight";
    // Written by hand as the owner: the loader is atomic and cannot produce this state, but a
    // killed process can, and an in-flight load must not be mistaken for garbage.
    await db.query(
      "owner",
      `INSERT INTO datum.code_index (id, scope, repo, commit_sha, indexer, indexed_at)
       VALUES ('cidx_inflight', $1, $2, 'bbbbbbb', 'test/1', now() - interval '1 day')`,
      [scopeFor(repo), repo],
    );
    await db.query(
      "owner",
      `INSERT INTO datum.code_symbols (index_id, kind, name, fqn, language, path, line_start, line_end)
       VALUES ('cidx_inflight','function','half_written','crate::half_written','rust','src/h.rs',1,2)`,
    );
    const completed = await ingestGraph(db, chain(repo, 4), {
      scope: scopeFor(repo),
      keep: NO_PRUNE,
    });

    const pruned = await pruneIndexes(db, { repo, keep: 0 });
    expect(pruned.deleted).toEqual([]);
    expect(pruned.kept).toEqual([completed.indexId]);

    const survivor = await db.one<{ id: string }>(
      "owner",
      "SELECT id FROM datum.code_index WHERE id = 'cidx_inflight'",
    );
    expect(survivor?.id).toBe("cidx_inflight");
    expect((await countsFor("cidx_inflight")).symbols).toBe(1);
  });

  it("cascades symbols and edges out, and leaves the ledger byte-identical", async () => {
    const repo = "acme/cascade";
    // Real ledger rows, so "unchanged" is a claim about content and not about an empty table.
    for (const subject of ["cascade-a", "cascade-b"]) {
      await assertFact(db, {
        scope: `org/${ORG}`,
        subject,
        predicate: "exists",
        object: { value: true },
        kind: "state",
        evidence: { source: "graph-retention.test" },
        asserted_by: "graph-retention.test",
      });
    }

    const doomed = await ingestGraph(db, chain(repo, 6), { scope: scopeFor(repo), keep: NO_PRUNE });
    const survivor = await ingestGraph(db, chain(repo, 5), {
      scope: scopeFor(repo),
      keep: NO_PRUNE,
    });
    const held = await countsFor(doomed.indexId);
    expect(held).toEqual({ symbols: 6, edges: 5 });

    const ledgerBefore = await ledgerFingerprint();
    const pruned = await pruneIndexes(db, { repo, keep: 1 });
    const ledgerAfter = await ledgerFingerprint();

    expect(pruned.deleted).toEqual([doomed.indexId]);
    expect({ symbols: pruned.freed_symbols, edges: pruned.freed_edges }).toEqual(held);
    // The cascade, proven by count rather than by reading the DDL.
    expect(await countsFor(doomed.indexId)).toEqual({ symbols: 0, edges: 0 });
    expect(await countsFor(survivor.indexId)).toEqual({ symbols: 5, edges: 4 });
    expect(ledgerAfter).toEqual(ledgerBefore);
    expect(ledgerBefore.rows).toBeGreaterThanOrEqual(2);
  });

  it("does not touch another repo's indexes", async () => {
    const [a, b] = ["acme/repo-a", "acme/repo-b"];
    for (const repo of [a, b]) {
      for (let i = 0; i < 4; i += 1) {
        await ingestGraph(db, chain(repo, 3), { scope: scopeFor(repo), keep: NO_PRUNE });
      }
    }
    const bBefore = await indexIdsFor(b);
    expect(bBefore).toHaveLength(4);

    const pruned = await pruneIndexes(db, { repo: a, keep: 1 });
    expect(pruned.deleted).toHaveLength(3);
    expect(await indexIdsFor(a)).toHaveLength(1);
    expect(await indexIdsFor(b)).toEqual(bBefore);
    expect(pruned.deleted.some((id) => bBefore.includes(id))).toBe(false);
  });
});

describe("the grants retention rests on", () => {
  it("gives datum_app DELETE on code_index and on nothing else in the graph", async () => {
    const row = await db.one<{
      index_delete: boolean;
      symbols_delete: boolean;
      edges_delete: boolean;
    }>(
      "owner",
      `SELECT has_table_privilege('datum_app','datum.code_index','DELETE')   AS index_delete,
              has_table_privilege('datum_app','datum.code_symbols','DELETE') AS symbols_delete,
              has_table_privilege('datum_app','datum.code_edges','DELETE')   AS edges_delete`,
    );
    // The cascade above worked without either of the last two: PostgreSQL runs referential
    // actions with the referencing table's owner's privileges, which is the claim 014 makes.
    expect(row).toEqual({ index_delete: true, symbols_delete: false, edges_delete: false });
  });

  it("leaves the ledger append-only for every runtime role", async () => {
    const { rows } = await db.query<{ role: string; tbl: string; priv: string; held: boolean }>(
      "owner",
      `SELECT role, tbl, priv, has_table_privilege(role, 'datum.' || tbl, priv) AS held
         FROM (VALUES ('datum_app'), ('datum_verifier')) AS a(role),
              (VALUES ('assertions'), ('episodes'), ('missions'), ('node_activity')) AS b(tbl),
              (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS c(priv)`,
    );
    expect(rows).toHaveLength(24);
    expect(rows.filter((r) => r.held)).toEqual([]);
  });

  it("has nothing outside the three code tables referencing them", async () => {
    const { rows } = await db.query<{ child: string; parent: string }>(
      "owner",
      `SELECT child.relname AS child, parent.relname AS parent
         FROM pg_constraint c
         JOIN pg_class child  ON child.oid  = c.conrelid
         JOIN pg_class parent ON parent.oid = c.confrelid
         JOIN pg_namespace n  ON n.oid      = parent.relnamespace
        WHERE c.contype = 'f' AND n.nspname = 'datum'
          AND parent.relname IN ('code_index','code_symbols','code_edges')
        ORDER BY child.relname, parent.relname`,
    );
    // Four, all of them internal: symbols->index, edges->index, edges->symbols twice. If a future
    // table ever points at a symbol id, this fails and 014's argument has to be re-made.
    const outsiders = rows.filter((r) => !["code_symbols", "code_edges"].includes(r.child));
    expect(outsiders).toEqual([]);
    expect(rows).toHaveLength(4);
  });
});

describe("POST /v1/graph/index", () => {
  it("ingests an artifact and makes its symbols answerable", async () => {
    const repo = "acme/routed";
    const [callee, caller] = [sym("routed_target"), sym("routed_caller")];
    const art = artifact(repo, [callee, caller], [edge(caller, callee)]);

    const res = await post(JSON.stringify(art), { bearer: hookKey });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      ok: true,
      repo,
      commit_sha: art.commit_sha,
      symbol_count: 2,
      edge_count: 1,
      pruned: [],
    });
    const indexId: string = res.json().index_id;
    expect(indexId).toMatch(/^cidx_/);

    // The index landed in the org's project tree, which is what makes it readable by the keys
    // that should read it.
    const index = await resolveIndex(db, { repo });
    expect(index.scope).toBe(scopeFor(repo));
    expect(index.id).toBe(indexId);

    const closure = await impact(db, { repo, symbol: "crate::routed_target" });
    expect(closure.reached_by.map((h) => h.name)).toEqual(["routed_caller"]);

    const overHttp = await app.inject({
      method: "GET",
      url: `/v1/impact?repo=${repo}&symbol=crate::routed_target`,
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(overHttp.statusCode).toBe(200);
    expect(overHttp.json().reached_by.map((h: { name: string }) => h.name)).toEqual([
      "routed_caller",
    ]);
  });

  it("accepts the same artifact gzipped, and a body far past the global 1 MiB limit", async () => {
    const repo = "acme/gzipped";
    const art = chain(repo, 4_000);
    const plain = Buffer.from(JSON.stringify(art), "utf8");
    const gzipped = gzipSync(plain);
    // The reason this route needs its own limit at all: the plain body alone is past the
    // instance default this test's Fastify was built with.
    expect(plain.length).toBeGreaterThan(1_048_576);
    expect(gzipped.length).toBeLessThan(plain.length / 4);

    const res = await post(gzipped, { bearer: hookKey, encoding: "gzip" });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(201);
    expect(res.json()).toMatchObject({ symbol_count: 4_000, edge_count: 3_999 });

    // Same shape uncompressed, on a second commit: both paths reach the same loader.
    const second = chain(repo, 4_000);
    const plainRes = await post(Buffer.from(JSON.stringify(second), "utf8"), { bearer: hookKey });
    expect(plainRes.statusCode, plainRes.body.slice(0, 400)).toBe(201);
    expect(plainRes.json()).toMatchObject({ symbol_count: 4_000, edge_count: 3_999 });
  });

  it("prunes on ingest once a repo is past the default of three", async () => {
    const repo = "acme/auto";
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await post(JSON.stringify(chain(repo, 2)), { bearer: hookKey });
      expect(res.statusCode).toBe(201);
      expect(res.json().pruned).toEqual([]);
      ids.push(res.json().index_id);
    }
    const fourth = await post(JSON.stringify(chain(repo, 2)), { bearer: hookKey });
    expect(fourth.statusCode).toBe(201);
    // The oldest, and only the oldest: this is the bound that makes automatic indexing safe.
    expect(fourth.json().pruned).toEqual([ids[0]]);
    expect(await indexIdsFor(repo)).toEqual([fourth.json().index_id, ids[2], ids[1]]);
  });

  it("refuses an unauthenticated caller before it reads a byte of the body", async () => {
    const res = await post(JSON.stringify(chain("acme/anon", 2)));
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe("unauthorized");
  });

  it("refuses a key without assert, and a scope the key does not cover", async () => {
    const art = chain("acme/refused", 2);

    const readOnly = await post(JSON.stringify(art), { bearer: readKey });
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json()).toMatchObject({
      reason: "forbidden",
      detail: { held: ["read"], needed: "assert" },
    });

    const wrongScope = await post(JSON.stringify(art), { bearer: elsewhereKey });
    expect(wrongScope.statusCode).toBe(403);
    expect(wrongScope.json()).toMatchObject({
      reason: "forbidden",
      detail: { key_scope: `org/${ORG}/proj/elsewhere`, requested: `org/${ORG}/proj/refused` },
    });

    // Neither refusal wrote anything.
    expect(await indexIdsFor("acme/refused")).toEqual([]);
  });

  it("refuses a second load of the same commit, naming the index that holds it", async () => {
    const repo = "acme/idempotent";
    const art = chain(repo, 3);
    const first = await post(JSON.stringify(art), { bearer: hookKey });
    expect(first.statusCode).toBe(201);

    const again = await post(JSON.stringify(art), { bearer: hookKey });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({
      reason: "malformed_request",
      detail: { index_id: first.json().index_id, completed: true },
    });
    // Not an update, and not a second row: the first load stands.
    expect(await indexIdsFor(repo)).toEqual([first.json().index_id]);
  });

  it("names a bad encoding and a malformed artifact rather than failing as unparseable", async () => {
    const art = chain("acme/encoded", 2);

    const brotli = await post(Buffer.from(JSON.stringify(art)), {
      bearer: hookKey,
      encoding: "br",
    });
    expect(brotli.statusCode).toBe(400);
    expect(brotli.json()).toMatchObject({
      reason: "malformed_request",
      detail: { encoding: "br", supported: ["identity", "gzip"] },
    });

    const notGzip = await post(Buffer.from(JSON.stringify(art)), {
      bearer: hookKey,
      encoding: "gzip",
    });
    expect(notGzip.statusCode).toBe(400);
    expect(notGzip.json().message).toContain("not gzip");

    const wrongVersion = await post(JSON.stringify({ ...art, version: 2 }), { bearer: hookKey });
    expect(wrongVersion.statusCode).toBe(400);
    expect(wrongVersion.json().message).toContain("version");

    const noSymbols = await post(JSON.stringify({ ...art, symbols: undefined }), {
      bearer: hookKey,
    });
    expect(noSymbols.statusCode).toBe(400);
    expect(noSymbols.json().message).toContain("symbols");

    const empty = await post("", { bearer: hookKey });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().reason).toBe("malformed_request");
  });

  it("leaves nothing readable when a load fails halfway, and lets the same commit retry", async () => {
    const repo = "acme/halfway";
    const good = sym("halfway_ok");
    // Passes the schema — line numbers are integers — and fails `code_symbol_lines_ordered` in
    // the middle of the load, which is the closest thing to a crashed indexer this suite can
    // arrange deterministically.
    const broken = sym("halfway_broken", { line_start: 40, line_end: 2 });
    const art = artifact(repo, [good, broken], [edge(broken, good)]);

    const failed = await post(JSON.stringify(art), { bearer: hookKey });
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(failed.json().ok).toBe(false);

    // No row at all, not even an invisible one: the transaction rolled back.
    const rows = await db.query<{ id: string }>(
      "owner",
      "SELECT id FROM datum.code_index WHERE repo = $1",
      [repo],
    );
    expect(rows.rows).toEqual([]);
    await expect(resolveIndex(db, { repo })).rejects.toMatchObject({ http: 404 });

    // And the commit is not burned: `code_index_identity` has nothing to collide with.
    const fixed: GraphArtifact = {
      ...art,
      symbols: [good, sym("halfway_broken", { line_start: 40 })],
    };
    const retried = await post(JSON.stringify(fixed), { bearer: hookKey });
    expect(retried.statusCode, retried.body.slice(0, 400)).toBe(201);
    expect(retried.json().commit_sha).toBe(art.commit_sha);
    expect((await resolveIndex(db, { repo })).symbol_count).toBe(2);
  });
});
