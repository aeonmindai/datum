import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexRepo } from "../src/index/index.js";
import { AMBIGUITY_CEILING } from "../src/index/filters.js";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { confidenceFor } from "../src/graph/types.js";
import type { Db } from "../src/db/pool.js";
import type { GraphArtifact, GraphEdge, GraphSymbol } from "../src/graph/types.js";

/**
 * The indexer, against a fixture repository under `test/fixtures/repo` covering Rust, Python and
 * CUDA.
 *
 * Most of this needs no database, because the indexer touches none: it reads a working tree and
 * emits an artifact, which is the whole point of splitting it from the loader. The last block does
 * use real Postgres, and it earns it — the artifact's honesty guarantees are enforced by CHECK
 * constraints in migration 008, and an artifact shape that the schema would refuse is a bug in the
 * indexer no amount of in-memory assertion would catch.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/repo/", import.meta.url));
const SIG = (variant: string) =>
  fileURLToPath(new URL(`./fixtures/sig/${variant}/`, import.meta.url));

let artifact: GraphArtifact;
let symbolByKey: Map<string, GraphSymbol>;

function symbolsNamed(name: string): GraphSymbol[] {
  return artifact.symbols.filter((s) => s.name === name);
}

function edgesFrom(fqn: string, kind?: GraphEdge["kind"]): GraphEdge[] {
  const src = artifact.symbols.find((s) => s.fqn === fqn);
  if (src === undefined) throw new Error(`fixture has no symbol with fqn ${fqn}`);
  return artifact.edges.filter((e) => e.src === src.key && (kind === undefined || e.kind === kind));
}

beforeAll(async () => {
  artifact = await indexRepo({
    dir: FIXTURE,
    repo: "aeonmind/fixture",
    commitSha: "0f1e2d3",
  });
  symbolByKey = new Map(artifact.symbols.map((s) => [s.key, s]));
}, 60_000);

describe("symbol extraction", () => {
  it("covers every language in the fixture", () => {
    expect(artifact.languages).toEqual(["cuda", "python", "rust"]);
    // Three Rust files, two CUDA, three Python (including the package's `__init__.py`).
    expect(artifact.file_count).toBe(8);
    expect(artifact.stats?.parse_failures).toBe(0);
  });

  it("finds each symbol kind the extractors are responsible for", () => {
    const kinds = new Set(artifact.symbols.map((s) => s.kind));
    // `field` is deliberately absent: fields are recorded as `uses_type` edges from their owning
    // type rather than as symbols, because a symbol per field would outnumber everything else in
    // the index while answering nothing an impact query asks.
    expect([...kinds].sort()).toEqual([
      "constant",
      "function",
      "kernel",
      "macro",
      "method",
      "module",
      "test",
      "trait",
      "type",
    ]);
  });

  it("derives Rust fqns from the crate manifest and the directory layout", () => {
    // Hyphens become underscores because that is what `use fixture_alpha::..` actually writes.
    const widen = symbolsNamed("widen").find((s) => s.language === "rust");
    expect(widen?.fqn).toBe("fixture_alpha::Alpha::widen");
    expect(widen?.kind).toBe("method");

    const fromEnv = symbolsNamed("from_env")[0];
    expect(fromEnv?.fqn).toBe("fixture_alpha::qtip::Geometry::from_env");

    // A second crate keeps its own prefix, which is what makes the two crates distinguishable.
    expect(symbolsNamed("only_one_of_me")[0]?.fqn).toBe("fixture_beta::only_one_of_me");
  });

  it("classifies Rust tests by attribute, not by module", () => {
    const tests = artifact.symbols.filter((s) => s.kind === "test" && s.language === "rust");
    expect(tests.map((s) => s.name).sort()).toEqual([
      "geometry_from_env_is_four",
      "test_shared_helper",
      "uses_the_helper",
    ]);
    // A plain `fn` inside `#[cfg(test)] mod tests` is a helper. Calling it a test would overstate
    // coverage, which is the direction of error that matters for "what tests cover this".
    const helper = symbolsNamed("helper_not_a_test")[0];
    expect(helper?.kind).toBe("function");
  });

  it("classifies Python tests by the pytest prefix", () => {
    const pytest = artifact.symbols.filter((s) => s.kind === "test" && s.language === "python");
    expect(pytest.map((s) => s.fqn)).toEqual(["pypkg.test_codec.test_build_widener"]);
    expect(symbolsNamed("widener_helper")[0]?.kind).toBe("function");
    // The dotted path comes from `__init__.py`, exactly as Python's own import machinery derives it.
    expect(symbolsNamed("widen").find((s) => s.language === "python")?.fqn).toBe(
      "pypkg.codec.Widener.widen",
    );
  });

  it("identifies CUDA kernels despite the grammar not knowing the qualifiers", () => {
    const kernels = artifact.symbols.filter((s) => s.kind === "kernel");
    expect(kernels.map((s) => s.name).sort()).toEqual([
      "bounded_pack",
      "pack_symbols",
      "packed_bytes_per_row",
      "to_float",
      "to_float",
      "vec_helper",
    ]);
    expect(kernels.every((s) => s.language === "cuda")).toBe(true);
    // The C++ grammar parks `__global__` in an ERROR node; the file is still indexed, because the
    // recoverable parts of a partly-failed parse are still true.
    expect(artifact.stats?.files_with_syntax_errors).toBeGreaterThan(0);
  });

  it("recovers a name the grammar stranded inside an ERROR node", () => {
    // `template <> __device__ __forceinline__ float to_float<int>(int v)` makes tree-sitter-cpp
    // report `__forceinline__` as the declarator's name. Believing it mis-named 65 kernels on the
    // Arc corpus, and a symbol called `__forceinline__` is worse than none: it claims coverage of
    // something while making it uncallable.
    expect(symbolsNamed("__forceinline__")).toEqual([]);
    const specialisations = symbolsNamed("to_float");
    expect(specialisations.length).toBe(2);
    expect(specialisations.every((s) => s.kind === "kernel")).toBe(true);
    // The primary template and its specialisation share a name and a namespace, so they are
    // separated by signature: `<typename T>` against `<>`.
    expect(new Set(specialisations.map((s) => s.signature_hash)).size).toBe(2);
  });

  it("finds a kernel behind __launch_bounds__, which the grammar swallows whole", () => {
    // Not a stumble but a swallow: written on its own line, this attribute consumes the declarator,
    // so the kernel vanishes from the index rather than arriving mis-named. On Arc that cost three
    // real `__global__` kernels outright and misfiled a fourth as a plain `function`.
    const bounded = symbolsNamed("bounded_pack");
    expect(bounded.length).toBe(1);
    expect(bounded[0]?.kind).toBe("kernel");
    expect(symbolsNamed("__launch_bounds__")).toEqual([]);
    // The blanking pass preserves length, so reported positions must still land on the real code.
    // A plain deletion would shift every line after the attribute, and this is what would catch it.
    const source = readFileSync(new URL("./fixtures/repo/kernels/pack.cu", import.meta.url), "utf8");
    const span = source.split("\n").slice((bounded[0]?.line_start ?? 1) - 1, bounded[0]?.line_end);
    expect(span.join("\n")).toContain("bounded_pack");
  });

  it("recovers a name the grammar fused with its return type", () => {
    // A *templated return type* is a different failure from a specialisation:
    // `__device__ __forceinline__ Geom<BLOCK> vec_helper(int n)` comes back as the single "name"
    // `__forceinline__ Geom vec_helper` — qualifier, return base name and real name concatenated,
    // sometimes with a newline inside. On Arc this left five real functions, including the hot
    // `vec_apply_llama_rope`, unreachable: no call site can resolve to a name containing a space,
    // so each one read as "nothing calls this" — an absence indistinguishable from a genuine one,
    // which is the most dangerous answer this tool can give.
    expect(symbolsNamed("vec_helper").length).toBe(1);
    const whitespaced = artifact.symbols.filter((s) => /\s/.test(s.name) || /\s/.test(s.fqn ?? ""));
    // No identifier in Rust, C, CUDA or Python contains whitespace, so one that does is a parser
    // defect by construction. This is the invariant, not the individual shapes above.
    expect(whitespaced).toEqual([]);
  });

  it("strips template arguments from a specialised record's name", () => {
    // `template <> struct Geom<0>` puts its arguments in the name field. Keeping them yields a
    // symbol called `Geom<0>` that no call site can match, because callers write `Geom<K>` with
    // their own parameter — so the specialisation reads as unreferenced. The primary and the
    // specialisation therefore share a name and are separated by signature, as functions are.
    const geoms = symbolsNamed("Geom");
    expect(geoms.length).toBe(2);
    expect(geoms.every((s) => s.fqn === "fixture::Geom")).toBe(true);
    expect(new Set(geoms.map((s) => s.signature_hash)).size).toBe(2);
  });

  it("keeps a method whose impl target has no name, at module scope", () => {
    // `impl Pairable for (Left, Right)` has no nameable subject, so there is no type segment to
    // put in the fqn and no subject for an `implements` edge. The method is still real: dropping
    // it would trade a fabricated name for a missing symbol, and both are wrong.
    const combine = symbolsNamed("combine").map((s) => s.fqn).sort();
    expect(combine).toEqual(["fixture_beta::Pairable::combine", "fixture_beta::combine"]);
    const bogus = artifact.edges.filter(
      (e) => e.kind === "implements" && e.dst_name === "Pairable",
    );
    expect(bogus).toEqual([]);
  });

  it("does not mistake C++'s most vexing parse for a function declaration", () => {
    // `dim3 grid(n, 1);` inside a body is syntactically identical to a prototype and the grammar
    // resolves it the wrong way. On Arc that invented eight `function` symbols named `block` and
    // `grid`, which then competed for resolution with anything genuinely bearing those names.
    expect(symbolsNamed("grid")).toEqual([]);
    // Every symbol's declared span must contain its own name; a fabricated one cannot satisfy that.
    for (const s of artifact.symbols) {
      if (s.kind === "module") continue;
      const lines = readFileSync(
        new URL(`./fixtures/repo/${s.path}`, import.meta.url),
        "utf8",
      ).split("\n");
      expect(
        lines.slice(s.line_start - 1, s.line_end).join("\n"),
        `${s.kind} ${s.name} at ${s.path}:${s.line_start}-${s.line_end}`,
      ).toContain(s.name);
    }
  });

  it("does not index function-local constants as symbols", () => {
    // `int slot = ...` inside a kernel is a local, not part of any contract.
    expect(symbolsNamed("slot")).toEqual([]);
  });
});

describe("edge resolution", () => {
  it("resolves a name borne by exactly one symbol as unique-name", () => {
    const call = edgesFrom("fixture_beta::caller", "calls").find(
      (e) => e.dst_name === "only_one_of_me",
    );
    expect(call?.resolution).toBe("unique-name");
    expect(call?.dst).toBeTruthy();
    expect(symbolByKey.get(call?.dst ?? "")?.fqn).toBe("fixture_beta::only_one_of_me");
    expect(confidenceFor(call!.resolution)).toBe("derived");
  });

  it("uses the enclosing impl type to resolve a call through self", () => {
    const call = edgesFrom("fixture_alpha::Alpha::decode", "calls").find(
      (e) => e.dst_name === "widen",
    );
    expect(call?.resolution).toBe("unique-name");
    expect(symbolByKey.get(call?.dst ?? "")?.fqn).toBe("fixture_alpha::Alpha::widen");
  });

  it("prefers a module-local target over a same-named one elsewhere", () => {
    const call = edgesFrom("fixture_alpha::calls_locally", "calls").find(
      (e) => e.dst_name === "shared_helper",
    );
    // Two symbols bear this name, but Rust's own resolution prefers the one in scope, so claiming
    // ambiguity here would be under-claiming — which is a different failure, not a safe one.
    expect(call?.resolution).toBe("unique-name");
    expect(symbolByKey.get(call?.dst ?? "")?.fqn).toBe("fixture_alpha::shared_helper");
  });

  it("records an ambiguous edge with every candidate, and never picks one", () => {
    const call = edgesFrom("fixture_beta::calls_ambiguously", "calls").find(
      (e) => e.dst_name === "shared_helper",
    );
    expect(call?.resolution).toBe("ambiguous-name");
    // The schema's CHECK requires at least two, and honesty requires all of them.
    expect(call?.candidates?.length).toBeGreaterThanOrEqual(2);
    expect(new Set(call?.candidates).size).toBe(call?.candidates?.length);
    const fqns = (call?.candidates ?? []).map((k) => symbolByKey.get(k)?.fqn).sort();
    expect(fqns).toEqual(["fixture_alpha::qtip::shared_helper", "fixture_alpha::shared_helper"]);
    // Choosing one of the candidates as the target would be inventing an answer to avoid an
    // ambiguous label, which is the over-claim this whole store exists to refuse.
    expect(call?.dst).toBeNull();
    expect(confidenceFor(call!.resolution)).toBe("unverified");
  });

  it("reports a trait-object dispatch as ambiguous across every implementor", () => {
    // `c.decode(1)` on a `&dyn Codec` genuinely could reach any implementor, and no parse can tell
    // which. Reporting one of them would be a lie; reporting all of them is the useful truth.
    const call = edgesFrom("fixture_alpha::qtip::implements_via_codec", "calls").find(
      (e) => e.dst_name === "decode",
    );
    expect(call?.resolution).toBe("ambiguous-name");
    const fqns = (call?.candidates ?? []).map((k) => symbolByKey.get(k)?.fqn).sort();
    expect(fqns).toEqual([
      "fixture_alpha::Alpha::decode",
      "fixture_alpha::Beta::decode",
      "fixture_alpha::Codec::decode",
    ]);
  });

  it("records an unresolved call rather than dropping it", () => {
    const rust = edgesFrom("fixture_alpha::calls_missing", "calls").find(
      (e) => e.dst_name === "absent_dependency",
    );
    expect(rust).toBeDefined();
    expect(rust?.resolution).toBe("unresolved");
    expect(rust?.dst).toBeNull();
    expect(rust?.candidates).toBeUndefined();
    // The call site survives even though the target did not: that is what makes the edge useful.
    expect(rust?.path).toBe("crateA/src/lib.rs");
    expect(rust?.line).toBeGreaterThan(0);

    const python = edgesFrom("pypkg.codec.calls_missing", "calls").find(
      (e) => e.dst_name === "absent_python_dependency",
    );
    expect(python?.resolution).toBe("unresolved");
    expect(python?.dst).toBeNull();
  });

  it("never claims a resolution it did not perform", () => {
    // tree-sitter is not a compiler and not a language server. Emitting either label would launder
    // a name guess into a `measured` fact.
    const claimed = artifact.edges.filter(
      (e) => e.resolution === "compiler" || e.resolution === "language-server",
    );
    expect(claimed).toEqual([]);
  });

  it("rescues a CUDA kernel launch, which the grammar loses entirely", () => {
    const launch = edgesFrom("fixture::launch_pack", "calls").find(
      (e) => e.dst_name === "pack_symbols",
    );
    expect(launch?.resolution).toBe("unique-name");
    expect(symbolByKey.get(launch?.dst ?? "")?.kind).toBe("kernel");
  });

  it("retags a call as instantiates when the target turns out to be a type", () => {
    const build = edgesFrom("pypkg.codec.build_widener");
    const widener = build.find((e) => e.dst_name === "Widener" && e.kind === "instantiates");
    expect(widener).toBeDefined();
    expect(symbolByKey.get(widener?.dst ?? "")?.kind).toBe("type");
  });

  it("records implements edges for Rust trait impls and Python base classes", () => {
    const implementors = artifact.edges
      .filter((e) => e.kind === "implements" && e.dst_name === "Codec")
      .map((e) => symbolByKey.get(e.src)?.fqn)
      .sort();
    expect(implementors).toContain("fixture_alpha::Alpha");
    expect(implementors).toContain("fixture_alpha::Beta");
    expect(implementors).toContain("pypkg.codec.Widener");
  });

  it("filters std vocabulary before it can reach the index", () => {
    // `HashMap::new()` and `Vec::with_capacity()` are calls into the standard library; nothing in
    // this repository is on the other end, so they are not edges.
    const names = new Set(artifact.edges.filter((e) => e.kind === "calls").map((e) => e.dst_name));
    expect(names.has("HashMap::new")).toBe(false);
    expect(names.has("assert_eq")).toBe(false);
    expect(names.has("rotate_left")).toBe(false);
    // A `use` of std IS recorded: which files reach for `std::collections` is a real fact about the
    // repository, unlike a call into code we do not hold.
    const imports = edgesFrom("fixture_alpha", "imports").map((e) => e.dst_name);
    expect(imports).toContain("std::collections::HashMap");
  });

  it("keeps the resolution histogram consistent with the emitted edges", () => {
    const stats = artifact.stats as { resolutions: Record<string, number> };
    const counted = new Map<string, number>();
    for (const e of artifact.edges) counted.set(e.resolution, (counted.get(e.resolution) ?? 0) + 1);
    for (const [resolution, n] of counted) expect(stats.resolutions[resolution]).toBe(n);
    expect(stats.resolutions["compiler"]).toBe(0);
    expect(stats.resolutions["language-server"]).toBe(0);
  });
});

describe("signature_hash as a change detector", () => {
  it("moves when the signature changes and holds when only the body does", async () => {
    const hashOf = async (variant: string): Promise<string> => {
      const art = await indexRepo({ dir: SIG(variant), repo: "aeonmind/sig", commitSha: "abcdef1" });
      const fn = art.symbols.find((s) => s.name === "quantize");
      expect(fn, `${variant} fixture must define quantize`).toBeDefined();
      expect(fn?.signature_hash).toMatch(/^[0-9a-f]{16}$/);
      return fn?.signature_hash as string;
    };
    const base = await hashOf("base");
    // Different body, reformatted parameter list, identical contract.
    expect(await hashOf("body-only")).toBe(base);
    // `bits: u32` widened to `u64`: the change a name-keyed index cannot see.
    expect(await hashOf("signature-changed")).not.toBe(base);
  }, 60_000);
});

describe("artifact integrity", () => {
  it("never references a key it does not define", () => {
    for (const edge of artifact.edges) {
      expect(symbolByKey.has(edge.src), `dangling src ${edge.src}`).toBe(true);
      if (edge.dst !== null && edge.dst !== undefined) {
        expect(symbolByKey.has(edge.dst), `dangling dst ${edge.dst}`).toBe(true);
      }
      for (const candidate of edge.candidates ?? []) {
        expect(symbolByKey.has(candidate), `dangling candidate ${candidate}`).toBe(true);
      }
    }
  });

  it("satisfies its own resolution contract on every edge", () => {
    for (const edge of artifact.edges) {
      switch (edge.resolution) {
        case "unique-name":
          expect(edge.dst).toBeTruthy();
          expect(edge.candidates).toBeUndefined();
          break;
        case "ambiguous-name":
          expect(edge.dst).toBeNull();
          expect((edge.candidates ?? []).length).toBeGreaterThanOrEqual(2);
          expect((edge.candidates ?? []).length).toBeLessThanOrEqual(AMBIGUITY_CEILING);
          break;
        case "unresolved":
          expect(edge.dst).toBeNull();
          expect(edge.candidates).toBeUndefined();
          break;
        default:
          throw new Error(`indexer emitted resolution ${edge.resolution}`);
      }
      expect(edge.dst_name.length).toBeGreaterThan(0);
      expect(edge.line).toBeGreaterThan(0);
    }
  });

  it("orders symbols deterministically across runs", async () => {
    const again = await indexRepo({
      dir: FIXTURE,
      repo: "aeonmind/fixture",
      commitSha: "0f1e2d3",
    });
    // Two indexes of one commit that disagree make a diff between them meaningless.
    expect(again.symbols.map((s) => s.key)).toEqual(artifact.symbols.map((s) => s.key));
    expect(again.edges.length).toBe(artifact.edges.length);
  }, 60_000);
});

/**
 * The artifact's honesty rules are database constraints, not conventions. `code_edges` refuses an
 * `ambiguous-name` row with fewer than two candidates and a `measured` row with no target, so this
 * pushes the real fixture artifact through the real schema: if the indexer ever produced a shape the
 * store would reject, this is where it shows up.
 */
describe("the emitted artifact is acceptable to migration 008", () => {
  let postgres: TestPostgres | undefined;
  let db: Db | undefined;

  beforeAll(async () => {
    postgres = await startPostgres();
    db = await postgres.fork("indexer_schema");
  }, 240_000);

  afterAll(async () => {
    await db?.close().catch(() => {});
    await postgres?.stop().catch(() => {});
  });

  it("loads every symbol and edge without tripping a CHECK", async () => {
    const pool = db as Db;
    const indexId = "cidx_fixture_0f1e2d3";
    // `app` is the role that will actually run the loader, and migration 008 grants INSERT to it
    // specifically. Using `owner` here would prove the schema accepts the shape while hiding a
    // missing grant.
    await pool.query(
      "app",
      `INSERT INTO datum.code_index (id, scope, repo, commit_sha, indexer, languages, file_count)
       VALUES ($1, 'aeonmind', $2, $3, $4, $5, $6)`,
      [
        indexId,
        artifact.repo,
        artifact.commit_sha,
        artifact.indexer,
        artifact.languages,
        artifact.file_count,
      ],
    );

    // One round trip for all symbols. `unnest` keeps array order, so the returned ids line up with
    // the artifact's own symbol order and the key -> id map needs no join.
    const s = artifact.symbols;
    const { rows: symbolRows } = await pool.query<{ id: string }>(
      "app",
      `INSERT INTO datum.code_symbols
         (index_id, kind, name, fqn, language, path, line_start, line_end, visibility,
          signature, signature_hash)
       SELECT $1, * FROM unnest(
         $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
         $7::int[], $8::int[], $9::text[], $10::text[], $11::text[])
       RETURNING id`,
      [
        indexId,
        s.map((x) => x.kind),
        s.map((x) => x.name),
        s.map((x) => x.fqn ?? null),
        s.map((x) => x.language),
        s.map((x) => x.path),
        s.map((x) => x.line_start),
        s.map((x) => x.line_end),
        s.map((x) => x.visibility ?? null),
        s.map((x) => x.signature ?? null),
        s.map((x) => x.signature_hash ?? null),
      ],
    );
    expect(symbolRows.length).toBe(s.length);
    const ids = new Map(s.map((sym, i) => [sym.key, symbolRows[i]?.id as string]));

    const e = artifact.edges;
    await pool.query(
      "app",
      // `unnest` flattens a nested array, so candidate sets travel as comma-joined text and are
      // rebuilt per row. Postgres has no way to unnest one level of a bigint[][].
      `INSERT INTO datum.code_edges
         (index_id, src_id, dst_id, dst_name, kind, confidence, resolution, candidates, path, line)
       SELECT $1, src, dst, name, kind, conf, res,
              coalesce(string_to_array(nullif(cand, ''), ',')::bigint[], '{}'::bigint[]),
              p, ln
         FROM unnest(
           $2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::text[],
           $8::text[], $9::text[], $10::int[])
           AS t(src, dst, name, kind, conf, res, cand, p, ln)`,
      [
        indexId,
        e.map((x) => ids.get(x.src)),
        e.map((x) => (x.dst === null || x.dst === undefined ? null : ids.get(x.dst))),
        e.map((x) => x.dst_name),
        e.map((x) => x.kind),
        e.map((x) => confidenceFor(x.resolution)),
        e.map((x) => x.resolution),
        e.map((x) => (x.candidates ?? []).map((k) => ids.get(k)).join(",")),
        e.map((x) => x.path),
        e.map((x) => x.line),
      ],
    );

    const { rows } = await pool.query<{ symbols: string; edges: string; ambiguous: string }>(
      "app",
      `SELECT (SELECT count(*) FROM datum.code_symbols WHERE index_id = $1)::text AS symbols,
              (SELECT count(*) FROM datum.code_edges   WHERE index_id = $1)::text AS edges,
              (SELECT count(*) FROM datum.code_edges
                WHERE index_id = $1 AND resolution = 'ambiguous-name')::text AS ambiguous`,
      [indexId],
    );
    expect(Number(rows[0]?.symbols)).toBe(artifact.symbols.length);
    expect(Number(rows[0]?.edges)).toBe(artifact.edges.length);
    expect(Number(rows[0]?.ambiguous)).toBeGreaterThan(0);
  }, 240_000);

  it("would refuse an ambiguous edge that carried a single candidate", async () => {
    // The mutation check: if this insert succeeded, the constraint the previous test relies on
    // would be decoration, and so would the previous test.
    const pool = db as Db;
    const { rows } = await pool.query<{ id: string }>(
      "app",
      `SELECT id FROM datum.code_symbols WHERE index_id = $1 ORDER BY id LIMIT 1`,
      ["cidx_fixture_0f1e2d3"],
    );
    const id = rows[0]?.id as string;
    await expect(
      pool.query(
        "app",
        `INSERT INTO datum.code_edges
           (index_id, src_id, dst_id, dst_name, kind, confidence, resolution, candidates, path, line)
         VALUES ($1,$2,NULL,'x','calls','unverified','ambiguous-name',ARRAY[$2::bigint],'a.rs',1)`,
        ["cidx_fixture_0f1e2d3", id],
      ),
    ).rejects.toThrow(/ambiguous_edges_carry_candidates/);
  }, 60_000);
});
