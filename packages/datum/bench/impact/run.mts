/**
 * Impact benchmark runner. Implements `grade.md` exactly; read that file first, it is the authority.
 *
 * Three arms over the same 40 questions and the same scoped file set:
 *   datum      GET /v1/graph/symbols to resolve, then GET /v1/impact
 *   grep-line  rg -w <target>, each hit attributed to its enclosing function-like symbol
 *   grep-file  every function-like symbol in any file containing a textual hit
 *
 * Two deliberate generosities to the baselines, stated because a benchmark whose author chose the
 * comparison must show where the thumb could have gone on the scale:
 *   1. grep-line attributes hits using the INDEXER's own symbol boundaries rather than a
 *      scan-upward heuristic. That is strictly more accurate than what `rg` alone gives you, so the
 *      baseline is being handed a piece of the thing it is competing against.
 *   2. Hits with no enclosing function are dropped rather than counted as false positives.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config.js";
import { buildServer } from "../../src/http/server.js";
import { mintKey } from "../../src/http/auth.js";
import type { GraphArtifact } from "../../src/graph/types.js";

const exec = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ARC = process.env.BENCH_ARC_DIR ?? "/Users/jish/Documents/GitHub/arc";
const ARTIFACT = process.env.BENCH_ARTIFACT ?? "/tmp/datum-arc-526c9099.json";
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("set DATABASE_URL to the ingested bench database");

const FUNCTION_LIKE = new Set(["function", "method", "test", "kernel"]);
const LINE_TOL = 3;

interface Q {
  id: string;
  target: string;
  target_path: string;
  target_line: number;
  difficulty: string;
  expect_none?: boolean;
  expect_symbols: { name: string; path: string; line: number; kind?: string }[];
  line_disambiguation_required?: boolean;
  bare_name_is_ambiguous?: boolean;
  depth?: number;
  edge_kinds?: string[];
  commit?: string;
}
const QS: Q[] = JSON.parse(readFileSync(`${HERE}questions.json`, "utf8"));
const meta = JSON.parse(readFileSync(`${HERE}meta.json`, "utf8"));

// The artifact is used for two things only: grep's hit attribution and grep-file's universe.
// Never to establish ground truth — that would make the benchmark circular.
const artifact: GraphArtifact = JSON.parse(readFileSync(ARTIFACT, "utf8"));
const byPath = new Map<string, { name: string; kind: string; a: number; b: number }[]>();
for (const s of artifact.symbols) {
  if (!FUNCTION_LIKE.has(s.kind)) continue;
  const list = byPath.get(s.path) ?? [];
  list.push({ name: s.name, kind: s.kind, a: s.line_start, b: s.line_end });
  byPath.set(s.path, list);
}
// Innermost enclosing symbol wins, so a nested closure is attributed to itself.
for (const list of byPath.values()) list.sort((x, y) => y.a - x.a || x.b - y.b);

type Sym = { name: string; path: string; line: number };
type Answer = { certain: Sym[]; uncertain: Sym[]; abstained: boolean };

function enclosing(path: string, line: number): Sym | null {
  for (const s of byPath.get(path) ?? []) {
    if (s.a <= line && line <= s.b) return { name: s.name, path, line: s.a };
  }
  return null;
}

const EXCLUDE: string[] = meta.scope?.excluded_dir_names ?? [
  ".git", ".claude", "target", "node_modules",
];
const EXTS: string[] = meta.scope?.indexed_extensions ?? [".rs", ".cu", ".cuh", ".py", ".c", ".h"];

async function ripgrep(word: string): Promise<{ path: string; line: number }[]> {
  const args = ["-w", "--no-heading", "--line-number", "--color", "never", "-e", word];
  for (const d of EXCLUDE) args.push("-g", `!${d}/**`);
  for (const e of EXTS) args.push("-g", `*${e}`);
  args.push(".");
  try {
    const { stdout } = await exec("rg", args, { cwd: ARC, maxBuffer: 64 * 1024 * 1024 });
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const m = /^(.+?):(\d+):/.exec(l);
        return m ? { path: m[1]!.replace(/^\.\//, ""), line: Number(m[2]) } : null;
      })
      .filter((x): x is { path: string; line: number } => x !== null);
  } catch {
    return []; // rg exits 1 on no match
  }
}

function dedup(rows: Sym[]): Sym[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.name}\u0000${r.path}\u0000${r.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** grade.md §3–§4. `uncertain` is removed from A before the arithmetic, by design. */
function score(q: Q, ans: Answer, strict: boolean) {
  const E = q.expect_symbols ?? [];
  const A = dedup(ans.certain);
  const used = new Set<number>();
  let tp = 0;
  for (const a of A) {
    let hit = -1;
    let best = Infinity;
    for (let i = 0; i < E.length; i++) {
      if (used.has(i)) continue;
      const e = E[i]!;
      if (e.name !== a.name || e.path !== a.path) continue;
      const d = Math.abs(a.line - e.line);
      const needLine = strict || q.line_disambiguation_required === true;
      if (needLine && d > LINE_TOL) continue;
      if (d < best) {
        best = d;
        hit = i;
      }
    }
    if (hit >= 0) {
      used.add(hit);
      tp++;
    }
  }
  const fp = A.length - tp;
  const fn = E.length - tp;
  if (E.length === 0 && A.length === 0) return { p: 1, r: 1, f1: 1, tp, fp, fn };
  if (E.length === 0) return { p: 0, r: 1, f1: 0, tp, fp, fn };
  if (A.length === 0) return { p: 1, r: 0, f1: 0, tp, fp, fn };
  const p = tp / (tp + fp);
  const r = tp / (tp + fn);
  return { p, r, f1: p + r === 0 ? 0 : (2 * p * r) / (p + r), tp, fp, fn };
}

const server = await buildServer(
  loadConfig({
    DATABASE_URL: DB_URL,
    DATUM_ORG: "aeonmind",
    DATUM_ADMIN_PASSWORD: "bench-only",
    DATUM_SESSION_SECRET: "9".repeat(64),
  }),
  { startWorker: false, log: false, runMigrations: false },
);
const key = (
  await mintKey(server.db, {
    label: "impact-bench",
    scope: "org/aeonmind",
    permissions: ["read"],
    expiresAt: null,
    createdBy: "bench",
  })
).secret;
const H = { authorization: `Bearer ${key}` };
// The artifact's slug, not meta.corpus.repo — that field holds the filesystem path the corpus was
// read from (/Users/.../arc), while code_index is keyed by the repo slug (aeonmind/arc). Using the
// path made every route 404, which the runner then counted as 40 abstentions.
const REPO = artifact.repo;

async function datumAnswer(q: Q): Promise<Answer & { error?: string }> {
  // Resolve at run time, never from the fixture's target_fqn string (grade.md §5).
  const found = await server.app.inject({
    method: "GET",
    // limit=200 because the default truncates before the target appears: `gather_forward` has ten
    // definitions in Arc and lib.rs:1441 is not in the first page. A truncated candidate list made
    // every question abstain, which read as a Datum score of zero rather than as a runner bug.
    url:
      `/v1/graph/symbols?repo=${encodeURIComponent(REPO)}` +
      `&q=${encodeURIComponent(q.target.split("::").pop()!)}&limit=200`,
    headers: H,
  });
  // Only 400/404 are abstentions (grade.md §5). Anything else — 401, 403, 500 — is the runner
  // being misconfigured, and mapping it to "abstain" would silently manufacture a result. That
  // exact bug produced a first run where datum abstained on all 40 questions because the bench
  // key could not reach the index's scope.
  if (found.statusCode === 400 || found.statusCode === 404) {
    return { certain: [], uncertain: [], abstained: true };
  }
  if (found.statusCode !== 200) {
    throw new Error(
      `graph/symbols returned ${found.statusCode} for ${q.id}: ${found.body.slice(0, 300)}`,
    );
  }
  const cands = (found.json().symbols ?? []) as {
    id: string; fqn: string | null; name: string; path: string; line_start: number;
  }[];
  // Path AND line, both required. Matching on path alone is the same class of bug as querying by
  // fqn: Arc has three same-named methods in one file, so path alone can select the wrong one.
  const pick = cands.find(
    (c) => c.path === q.target_path && Math.abs(c.line_start - q.target_line) <= LINE_TOL,
  );
  if (!pick) return { certain: [], uncertain: [], abstained: true };

  const res = await server.app.inject({
    method: "GET",
    url:
      // `id:` and not the fqn. An fqn is not unique — loading Arc found seven distinct symbols
      // sharing exactly `vllm::fma` (CUDA overloads across three dtype headers) — so an fqn query
      // can silently answer about a different overload than the question asked about.
      `/v1/impact?repo=${encodeURIComponent(REPO)}&symbol=${encodeURIComponent(`id:${pick.id}`)}` +
      `&depth=${q.depth ?? 1}`,
    headers: H,
  });
  if (res.statusCode === 400 || res.statusCode === 404) {
    return { certain: [], uncertain: [], abstained: true };
  }
  if (res.statusCode !== 200) {
    throw new Error(`impact returned ${res.statusCode} for ${q.id}: ${res.body.slice(0, 300)}`);
  }
  const b = res.json();
  // grade.md §5 malformed-answer guard: never score an answer whose partition is broken.
  if (b.counts.measured + b.counts.derived !== b.reached_by.length) {
    return { certain: [], uncertain: [], abstained: false, error: "counts/reached_by mismatch" };
  }
  if (b.counts.unverified !== b.ambiguous.length) {
    return { certain: [], uncertain: [], abstained: false, error: "counts/ambiguous mismatch" };
  }
  type Hop = { name: string; path: string; line_start: number; path_confidence: string };
  const asSym = (h: Hop): Sym => ({ name: h.name, path: h.path, line: h.line_start });
  const certain = dedup([
    ...(b.reached_by as Hop[]).map(asSym),
    ...(b.covered_by_tests as Hop[]).filter((h) => h.path_confidence !== "unverified").map(asSym),
  ]);
  const uncertain = dedup([
    ...(b.ambiguous as Hop[]).map(asSym),
    ...(b.covered_by_tests as Hop[]).filter((h) => h.path_confidence === "unverified").map(asSym),
  ]);
  return { certain, uncertain, abstained: false };
}

const rows: Record<string, unknown>[] = [];
for (const q of QS) {
  const hits = await ripgrep(q.target.split("::").pop()!);
  const scoped = hits.filter((h) => !(h.path === q.target_path && Math.abs(h.line - q.target_line) <= 1));

  const line: Sym[] = [];
  for (const h of scoped) {
    const e = enclosing(h.path, h.line);
    if (!e) continue;                                   // most favourable reading of grep
    if (e.path === q.target_path && Math.abs(e.line - q.target_line) <= LINE_TOL) continue;
    line.push(e);
  }
  const files = new Set(scoped.map((h) => h.path));
  const file: Sym[] = [];
  for (const p of files) {
    for (const s of byPath.get(p) ?? []) {
      if (p === q.target_path && Math.abs(s.a - q.target_line) <= LINE_TOL) continue;
      file.push({ name: s.name, path: p, line: s.a });
    }
  }

  const d = await datumAnswer(q);
  const arms = {
    datum: d,
    "grep-line": { certain: dedup(line), uncertain: [] as Sym[], abstained: false },
    "grep-file": { certain: dedup(file), uncertain: [] as Sym[], abstained: false },
  };
  const row: Record<string, unknown> = {
    id: q.id,
    difficulty: q.difficulty,
    expect: (q.expect_symbols ?? []).length,
    grep_hits: scoped.length,
  };
  for (const [arm, a] of Object.entries(arms)) {
    row[arm] = {
      abstained: a.abstained,
      error: (a as { error?: string }).error ?? null,
      primary: a.abstained ? null : score(q, a, false),
      strict: a.abstained ? null : score(q, a, true),
      certain: a.certain.length,
      uncertain: a.uncertain.length,
      fce: a.abstained
        ? 0
        : score(q, a, false).fp, // symbols asserted that are not in E
    };
  }
  rows.push(row);
  process.stdout.write(
    `${q.id} ${q.difficulty.padEnd(13)} E=${String((q.expect_symbols ?? []).length).padStart(2)} ` +
      `datum F1=${(row.datum as any).primary?.f1?.toFixed(2) ?? "abst"} ` +
      `grep-line F1=${(row["grep-line"] as any).primary.f1.toFixed(2)} ` +
      `grep-file F1=${(row["grep-file"] as any).primary.f1.toFixed(2)}\n`,
  );
}

function agg(arm: string) {
  const scored = rows.filter((r) => !(r[arm] as any).abstained && !(r[arm] as any).error);
  const macro = (k: "p" | "r" | "f1", variant: "primary" | "strict") =>
    scored.reduce((s, r) => s + (r[arm] as any)[variant][k], 0) / (scored.length || 1);
  const sum = (f: (x: any) => number) => rows.reduce((s, r) => s + f(r[arm]), 0);
  const tp = sum((a) => a.primary?.tp ?? 0);
  const fp = sum((a) => a.primary?.fp ?? 0);
  const fnAll = rows
    .filter((r) => (r.expect as number) > 0)
    .reduce((s, r) => s + ((r[arm] as any).primary?.fn ?? 0), 0);
  const certain = sum((a) => a.certain);
  const uncertain = sum((a) => a.uncertain);
  const fce = sum((a) => a.fce);
  const byDiff: Record<string, number> = {};
  for (const d of new Set(rows.map((r) => r.difficulty as string))) {
    const sel = scored.filter((r) => r.difficulty === d);
    byDiff[d] = sel.reduce((s, r) => s + (r[arm] as any).primary.f1, 0) / (sel.length || 1);
  }
  return {
    scored: scored.length,
    macro_primary: { precision: macro("p", "primary"), recall: macro("r", "primary"), f1: macro("f1", "primary") },
    macro_strict: { f1: macro("f1", "strict") },
    micro: {
      precision: tp + fp === 0 ? 1 : tp / (tp + fp),
      recall: tp + fnAll === 0 ? 1 : tp / (tp + fnAll),
    },
    FCR: certain === 0 ? 0 : fce / certain,
    FCQ: rows.filter((r) => (r[arm] as any).fce > 0).length / rows.length,
    abstain_rate: rows.filter((r) => (r[arm] as any).abstained).length / rows.length,
    uncertain_rate: certain + uncertain === 0 ? 0 : uncertain / (certain + uncertain),
    f1_by_difficulty: byDiff,
  };
}

const out = {
  generated_at: new Date().toISOString(),
  corpus: meta.corpus,
  // Published next to recall because the trade is the argument: a recall point lost to the
  // ambiguity ceiling is a structural omission, not a lookup failure, and a report showing only
  // FCR beside a high recall has hidden it rather than measured it.
  artifact_stats: artifact.stats ?? {},
  resolution_ambiguity_ceiling:
    (artifact.stats as Record<string, unknown> | undefined)?.resolution_ambiguity_ceiling ?? null,
  // Zero `measured` edges exist in this index: tree-sitter is neither a compiler nor a language
  // server, so every true positive here rests on unique-name resolution, not observation.
  edge_confidence: artifact.edges.reduce<Record<string, number>>((acc, e) => {
    const c = e.resolution === "unique-name" ? "derived" : "unverified";
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {}),
  questions: rows.length,
  arms: {
    datum: agg("datum"),
    "grep-line": agg("grep-line"),
    "grep-file": agg("grep-file"),
  },
  per_question: rows,
};
writeFileSync(`${HERE}results.json`, `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n${"=".repeat(78)}`);
for (const [arm, a] of Object.entries(out.arms)) {
  console.log(
    `${arm.padEnd(10)} macroF1=${a.macro_primary.f1.toFixed(3)} ` +
      `P=${a.macro_primary.precision.toFixed(3)} R=${a.macro_primary.recall.toFixed(3)} ` +
      `strictF1=${a.macro_strict.f1.toFixed(3)} FCR=${a.FCR.toFixed(3)} FCQ=${a.FCQ.toFixed(3)} ` +
      `abstain=${a.abstain_rate.toFixed(3)} uncertain=${a.uncertain_rate.toFixed(3)}`,
  );
}
console.log("=".repeat(78));
await server.close();
