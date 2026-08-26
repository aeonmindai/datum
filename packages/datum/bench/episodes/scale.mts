/**
 * Is `full-context` a baseline, or an artefact of a corpus small enough for it to be executable?
 *
 * `RESULTS.md` §1 fails the gate on arithmetic: `full-context` scores 95.0% on the held-out set, so
 * "+10 over both baselines" demands 105.0%. Before accepting that as a verdict on the product this
 * file settles three things the benchmark cannot answer from inside itself.
 *
 * 1. Are the two arms scored on the same *answerable* material? `full-context` is handed all 550
 *    human utterances including the 8 `/compact` continuation summaries, which are model prose the
 *    human merely pasted; the store is handed the other 542. That is a token asymmetry for certain.
 *    Whether it is also an *answerability* asymmetry is a measurement, and it is made here for all
 *    80 questions in both directions.
 * 2. How big is the corpus that actually exists on this machine, counted by `corpus.mts`'s
 *    definition of a human utterance and nobody else's?
 * 3. At what corpus size does a full-context arm stop being executable at all — and what does
 *    `evidence` mode do to its score on the way there?
 *
 * The third question has an answer that can be read off `grade.mts` before running anything, and
 * running it confirms it: in `evidence` mode the response *is* the retrieved context, so an
 * answerable question's verdict is `expectSatisfied(context)` — monotone non-decreasing in context
 * size — and a trap's verdict is `!forbidTrips(context)` — monotone non-increasing. An arm that
 * returns the whole corpus therefore cannot lose accuracy as the corpus grows and cannot help
 * gaining contamination. Its 95.0% is a measurement of corpus coverage, not of retrieval.
 *
 *   npx tsx bench/episodes/scale.mts
 *
 * Nothing here imports from `src/`, edits any existing bench file, or defines a second notion of a
 * human utterance: every count below comes out of `corpus.mts`'s own reader and `grade.mts`'s own
 * matchers.
 */
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { entryHits, expectSatisfied, forbidTrips, grade, type Question } from "./grade.mjs";
import type { Utterance } from "./corpus.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const log = (s: string): void => void process.stderr.write(`${s}\n`);

/** grade.md §8, unchanged: 4 characters per token, the usual English heuristic, labelled as one. */
const estTokens = (s: string): number => Math.ceil(s.length / 4);
const USD_PER_MTOK = 3;
const costPer1kQuestions = (tokensPerQuestion: number): number => (tokensPerQuestion * 1000 * USD_PER_MTOK) / 1e6;
const num = (n: number): string => n.toLocaleString("en-US");

// --------------------------------------------------------------- corpus access

type CorpusModule = typeof import("./corpus.mjs");

const CLAUDE_ROOT = `${homedir()}/.claude/projects`;
const OMP_ROOT = `${homedir()}/.omp/agent/sessions`;
const ARC_DIR = `${CLAUDE_ROOT}/-Users-jish-Documents-GitHub-arc`;

let bust = 0;

/**
 * `corpus.mts` fixes its directory at module load. That is what makes it the single definition of a
 * human utterance and also what stops one process from reading two corpora, so each directory gets
 * a fresh module instance via a cache-busting query. The alternative — a local filter that walks
 * every project itself — is a second definition, and a second definition is exactly the thing that
 * lets two arms be scored on quietly different material.
 */
async function readProject(dir: string): Promise<{ utterances: Utterance[]; interrupts: number; files: string[] }> {
  process.env["BENCH_TRANSCRIPT_DIR"] = dir;
  const m = (await import(`./corpus.mjs?scale=${(bust += 1)}`)) as CorpusModule;
  const files = m.transcriptFiles();
  if (files.length === 0) return { utterances: [], interrupts: 0, files };
  const { utterances, interrupts } = await m.readHumanUtterances();
  return { utterances, interrupts, files };
}

process.env["BENCH_TRANSCRIPT_DIR"] = ARC_DIR;
const { fullContext } = (await import("./corpus.mjs")) as CorpusModule;

// ------------------------------------------------------------- the omp adapter

/**
 * Claude Code writes `{type:"user", message:{role:"user"}}`; omp writes
 * `{type:"message", message:{role:"user"}}`. `corpus.mts` tests the outer `type`, so it finds zero
 * human utterances in the whole of `~/.omp/agent/sessions` — measured in §2 below. That is an
 * envelope mismatch, not a disagreement about what a human said, so the fix is to rewrite the
 * envelope and hand the untouched `message` back: every exclusion that decides whether text counts
 * (`isMeta`, `tool_result` blocks, `<…>` wrappers, interrupt markers, the `/compact` flag) stays in
 * the one file allowed to decide it.
 *
 * Line numbers in the staged files are lines of the staged file. Nothing below cites one.
 */
const OMP_STAGE = mkdtempSync(join(tmpdir(), "datum-scale-omp-"));

async function stageOmp(project: string, files: string[]): Promise<string> {
  const dir = join(OMP_STAGE, project);
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const session = /_(?<id>[0-9a-f-]+)\.jsonl$/.exec(file)?.groups?.["id"] ?? file;
    const out = createWriteStream(join(dir, file));
    let cwd: string | null = null;
    const rl = createInterface({ input: createReadStream(join(OMP_ROOT, project, file)), crlfDelay: Infinity });
    for await (const raw of rl) {
      if (!raw.trim()) continue;
      let rec: Record<string, unknown>;
      try { rec = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
      if (rec["type"] === "session" && typeof rec["cwd"] === "string") cwd = rec["cwd"];
      if (rec["type"] !== "message") continue;
      const msg = rec["message"] as { role?: string } | undefined;
      if (!msg || msg.role !== "user") continue;
      out.write(`${JSON.stringify({
        type: "user",
        uuid: rec["id"] ?? "",
        sessionId: session,
        timestamp: rec["timestamp"] ?? "",
        cwd,
        gitBranch: null,
        message: msg,
      })}\n`);
    }
    await new Promise<void>((resolve, reject) => { out.end(() => resolve()); out.on("error", reject); });
  }
  return dir;
}

// ------------------------------------------------------------------- file sizes

interface Bytes { files: number; bytes: number }

function flatJsonl(dir: string): Bytes {
  let files = 0;
  let bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    files += 1;
    bytes += statSync(join(dir, e.name)).size;
  }
  return { files, bytes };
}

/** Every `.jsonl` below `dir`, flat ones included. The difference is the subagent transcripts. */
function allJsonl(dir: string): Bytes {
  let files = 0;
  let bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const sub = allJsonl(p);
      files += sub.files;
      bytes += sub.bytes;
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      files += 1;
      bytes += statSync(p).size;
    }
  }
  return { files, bytes };
}

// -------------------------------------------------------------- §1 the corpora

interface ProjectStat {
  root: "claude" | "omp";
  project: string;
  flat_files: number;
  flat_bytes: number;
  nested_files: number;
  nested_bytes: number;
  utterances: number;
  interrupts: number;
  text_chars: number;
  payload_chars: number;
  payload_tokens: number;
  first: string;
  last: string;
}

const stats: ProjectStat[] = [];
const byProject = new Map<string, Utterance[]>();

async function census(root: "claude" | "omp", project: string, readDir: string, sizeDir: string): Promise<void> {
  const { utterances, interrupts, files } = await readProject(readDir);
  const flat = flatJsonl(sizeDir);
  const all = allJsonl(sizeDir);
  const payload = fullContext(utterances);
  const days = utterances.map((u) => u.ts.slice(0, 10)).filter((d) => d.length === 10).sort();
  const key = `${root}:${project}`;
  byProject.set(key, utterances);
  stats.push({
    root,
    project,
    flat_files: files.length,
    flat_bytes: flat.bytes,
    nested_files: all.files - flat.files,
    nested_bytes: all.bytes - flat.bytes,
    utterances: utterances.length,
    interrupts,
    text_chars: utterances.reduce((a, u) => a + u.text.length, 0),
    payload_chars: payload.length,
    payload_tokens: estTokens(payload),
    first: days[0] ?? "-",
    last: days[days.length - 1] ?? "-",
  });
}

log("§2 census: streaming ~/.claude/projects …");
for (const e of readdirSync(CLAUDE_ROOT, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  const dir = join(CLAUDE_ROOT, e.name);
  log(`  ${e.name}`);
  await census("claude", e.name, dir, dir);
}

log("§2 census: staging and streaming ~/.omp/agent/sessions …");
const ompNative = new Map<string, number>();
for (const e of readdirSync(OMP_ROOT, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  const dir = join(OMP_ROOT, e.name);
  log(`  ${e.name}`);
  // What corpus.mts reads from omp before any adaptation. Reported, not assumed.
  ompNative.set(e.name, (await readProject(dir)).utterances.length);
  const staged = await stageOmp(e.name, flatJsonlNames(dir));
  await census("omp", e.name, staged, dir);
}
rmSync(OMP_STAGE, { recursive: true, force: true });

function flatJsonlNames(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => e.name).sort();
}

stats.sort((a, b) => b.utterances - a.utterances || b.flat_bytes - a.flat_bytes);

// ------------------------------------------------- §1 the Arc asymmetry, exactly

const arc = byProject.get("claude:-Users-jish-Documents-GitHub-arc") ?? [];
const arcPasted = arc.filter((u) => u.pasted);
const arcVisible = arc.filter((u) => !u.pasted);
const chars = (us: Utterance[]): number => us.reduce((a, u) => a + u.text.length, 0);

const payloadAll = fullContext(arc);
const payloadVisible = fullContext(arcVisible);

const arcCorpus = {
  utterances: arc.length,
  compaction_summaries: arcPasted.length,
  datum_visible: arcVisible.length,
  text_chars_all: chars(arc),
  text_chars_compaction: chars(arcPasted),
  text_chars_visible: chars(arcVisible),
  full_context_payload_chars: payloadAll.length,
  full_context_payload_tokens: estTokens(payloadAll),
  datum_visible_payload_chars: payloadVisible.length,
  datum_visible_payload_tokens: estTokens(payloadVisible),
};

// ------------------------------------------------------ §1 answerability, both ways

const SETS = [
  { label: "tuned", file: "questions.json" },
  { label: "heldout", file: "questions-heldout.json" },
] as const;

interface Asymmetry {
  set: string;
  answerable: number;
  traps: number;
  /** Answer present in all 550 but not in the 542 the store holds. */
  full_only: string[];
  /** Present in the 542 but not in all 550 — impossible for a superset, so a check on the matcher. */
  datum_only: string[];
  both: number;
  neither: string[];
  /** Traps contaminated by the whole set but not by the 542. */
  trap_contam_full_only: string[];
  trap_contam_datum_only: string[];
  /** Record-level: some single utterance satisfies every `expect`. */
  record_full_only: string[];
  record_datum_only: string[];
  /** `expect` entries examined, the denominator for `entries_only_in_compaction`. */
  expect_entries: number;
  /** `expect` entries matched by no stored episode and by at least one compaction summary. */
  entries_only_in_compaction: { id: string; entry: string; in_compaction: number }[];
}

const asymmetries: Asymmetry[] = [];
const questionSets = new Map<string, Question[]>();

for (const { label, file } of SETS) {
  const qs: Question[] = JSON.parse(readFileSync(`${HERE}${file}`, "utf8"));
  questionSets.set(label, qs);
  log(`§1 answerability: ${label} …`);
  const a: Asymmetry = {
    set: label,
    answerable: qs.filter((q) => !q.abstain).length,
    traps: qs.filter((q) => q.abstain).length,
    expect_entries: qs.reduce((n, q) => n + q.expect.length, 0),
    full_only: [], datum_only: [], both: 0, neither: [],
    trap_contam_full_only: [], trap_contam_datum_only: [],
    record_full_only: [], record_datum_only: [],
    entries_only_in_compaction: [],
  };
  for (const q of qs) {
    if (q.abstain) {
      const cf = forbidTrips(payloadAll, q.forbid, q.forbid_subject ?? []);
      const cd = forbidTrips(payloadVisible, q.forbid, q.forbid_subject ?? []);
      if (cf && !cd) a.trap_contam_full_only.push(q.id);
      if (cd && !cf) a.trap_contam_datum_only.push(q.id);
      continue;
    }
    const f = expectSatisfied(payloadAll, q.expect);
    const d = expectSatisfied(payloadVisible, q.expect);
    if (f && d) a.both += 1;
    else if (f) a.full_only.push(q.id);
    else if (d) a.datum_only.push(q.id);
    else a.neither.push(q.id);

    const rf = arc.some((u) => expectSatisfied(u.text, q.expect));
    const rd = arcVisible.some((u) => expectSatisfied(u.text, q.expect));
    if (rf && !rd) a.record_full_only.push(q.id);
    if (rd && !rf) a.record_datum_only.push(q.id);

    for (const entry of q.expect) {
      const inVisible = arcVisible.filter((u) => entryHits(u.text, entry)).length;
      if (inVisible > 0) continue;
      const inCompaction = arcPasted.filter((u) => entryHits(u.text, entry)).length;
      if (inCompaction > 0) a.entries_only_in_compaction.push({ id: q.id, entry, in_compaction: inCompaction });
    }
  }
  asymmetries.push(a);
}

interface FcScore {
  set: string;
  accuracy: number;
  answerable_correct: number;
  answerable_total: number;
  trap_correct: number;
  trap_total: number;
  contamination: number;
}

/**
 * A full-context arm's `evidence`-mode score over an arbitrary payload, split the way `grade.mts`
 * splits it. The split is the point. On an answerable question the verdict is
 * `expectSatisfied(payload)`, which cannot fall as the payload grows; on a trap it is
 * `!forbidTrips(payload)`, which cannot rise. One accuracy number hides which of the two moved, and
 * which of the two moved is the whole question about whether this arm is a baseline.
 */
function scoreFullContext(payload: string): FcScore[] {
  return SETS.map(({ label }) => {
    const rows = (questionSets.get(label) ?? []).map((q) => ({ q, g: grade(q, payload, "evidence") }));
    const answerable = rows.filter((r) => !r.q.abstain);
    const traps = rows.filter((r) => r.q.abstain);
    return {
      set: label,
      accuracy: rows.filter((r) => r.g.verdict === "correct").length / (rows.length || 1),
      answerable_correct: answerable.filter((r) => r.g.verdict === "correct").length,
      answerable_total: answerable.length,
      trap_correct: traps.filter((r) => r.g.verdict === "correct").length,
      trap_total: traps.length,
      contamination: rows.filter((r) => r.g.contaminated).length / (rows.length || 1),
    };
  });
}

/**
 * The same arm scored twice over the Arc corpus: once on all 550 utterances, which is what the
 * benchmark hands it, and once on only the 542 the store will accept. Any difference between these
 * two columns is the entire scoring consequence of the compaction-summary asymmetry.
 */
const arcScoredAll = scoreFullContext(payloadAll);
const arcScoredVisible = scoreFullContext(payloadVisible);

// -------------------------------------------------- §3 where full-context stops

const published = JSON.parse(readFileSync(`${HERE}results-heldout-derived.json`, "utf8")) as {
  results: Record<string, { accuracy: number; est_tokens_mean: number; contamination: number } | null>;
};
const pub = (arm: string) => {
  const r = published.results[arm];
  if (!r) throw new Error(`results-heldout-derived.json has no ${arm} arm`);
  return r;
};

const datumTokens = pub("datum-recall").est_tokens_mean;

/**
 * The baseline the gate should have used. `full-context` is not a different policy from
 * `datum-recall`; it is the same "put the corpus in the prompt" policy with the budget removed, and
 * a system spending 7,817 tokens a question is being asked to beat one spending 72,633. This arm
 * restores the budget and keeps the policy every chat client actually implements — the newest turns
 * that fit — so the comparison is retrieval against no retrieval at equal cost.
 *
 * Sorted by timestamp first. A multi-project corpus arrives here concatenated project by project,
 * so a suffix of it is the last *projects*, not the last turns; taking that suffix would measure
 * something nobody would ever build. The full-context payloads are deliberately left in transcript
 * order so scale 1 reproduces `run.mts`'s payload byte for byte — reordering cannot change a
 * character count, and the published 72,633 is the check that it did not.
 *
 * Binary search on the suffix length: `fullContext` of a suffix is monotone in its length, so the
 * largest fitting suffix costs log(n) payload builds instead of n.
 */
function newestThatFits(us: Utterance[], budget: number): Utterance[] {
  const ordered = [...us].sort((a, b) => a.ts.localeCompare(b.ts));
  let lo = 0;
  let hi = ordered.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estTokens(fullContext(ordered.slice(ordered.length - mid))) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return ordered.slice(ordered.length - lo);
}

const ranked = stats.filter((s) => s.utterances > 0);
const topTen = ranked.slice(0, 10);
const scales = [
  { label: "1 project (Arc — the benchmark's corpus)", projects: ["claude:-Users-jish-Documents-GitHub-arc"] },
  { label: "10 projects (the ten largest by human utterances)", projects: topTen.map((s) => `${s.root}:${s.project}`) },
  { label: "everything (every project, both roots)", projects: ranked.map((s) => `${s.root}:${s.project}`) },
] as const;

interface ScaleRow {
  label: string;
  projects: number;
  utterances: number;
  payload_chars: number;
  tokens_per_question: number;
  fits_200k: boolean;
  fits_1m: boolean;
  usd_per_1k_questions: number;
  /** `evidence`-mode score of a full-context arm over exactly this payload. */
  scores: FcScore[];
  /** The same corpus, same grader, capped at `datum-recall`'s measured token budget. */
  budget_matched: { utterances: number; tokens_per_question: number; usd_per_1k_questions: number; scores: FcScore[] };
}

const scaleRows: ScaleRow[] = [];
for (const s of scales) {
  const us = s.projects.flatMap((k) => byProject.get(k) ?? []);
  const payload = fullContext(us);
  const tok = estTokens(payload);
  log(`§3 grading full-context over ${s.label} (${num(tok)} est. tokens) …`);
  const scores = scoreFullContext(payload);
  const kept = newestThatFits(us, datumTokens);
  const keptTokens = estTokens(fullContext(kept));
  scaleRows.push({
    label: s.label,
    projects: s.projects.length,
    utterances: us.length,
    payload_chars: payload.length,
    tokens_per_question: tok,
    fits_200k: tok <= 200_000,
    fits_1m: tok <= 1_000_000,
    usd_per_1k_questions: costPer1kQuestions(tok),
    scores,
    budget_matched: {
      utterances: kept.length,
      tokens_per_question: keptTokens,
      usd_per_1k_questions: costPer1kQuestions(keptTokens),
      scores: scoreFullContext(fullContext(kept)),
    },
  });
}

/**
 * Where the window actually breaks, measured rather than assumed. Projects are added largest-first,
 * so this is the *fewest* projects that can break a window — the friendliest possible reading for
 * the claim that full-context stops working, and it still does not reach 1M on this machine. The
 * per-day rate is the only extrapolation in this file and it is labelled as one wherever it is used.
 */
const bySize = [...ranked].sort((a, b) => b.payload_tokens - a.payload_tokens);
const cumulative: { projects: number; tokens: number }[] = [];
{
  const acc: Utterance[] = [];
  for (const s of bySize) {
    acc.push(...(byProject.get(`${s.root}:${s.project}`) ?? []));
    cumulative.push({ projects: cumulative.length + 1, tokens: estTokens(fullContext(acc)) });
  }
}
const everyDay = stats.flatMap((s) => (s.first === "-" ? [] : [s.first, s.last])).sort();
const spanDays = everyDay.length >= 2
  ? Math.round((Date.parse(`${everyDay[everyDay.length - 1]!}T00:00:00Z`) - Date.parse(`${everyDay[0]!}T00:00:00Z`)) / 86_400_000)
  : 0;
const allTokens = cumulative[cumulative.length - 1]?.tokens ?? 0;
const tokensPerDay = spanDays > 0 ? allTokens / spanDays : 0;
const frontier = {
  corpus_first_day: everyDay[0] ?? "-",
  corpus_last_day: everyDay[everyDay.length - 1] ?? "-",
  span_days: spanDays,
  total_tokens: allTokens,
  tokens_per_day: tokensPerDay,
  mean_tokens_per_speaking_project: ranked.length ? allTokens / ranked.length : 0,
  projects_to_exceed_200k: cumulative.find((c) => c.tokens > 200_000)?.projects ?? null,
  projects_to_exceed_1m: cumulative.find((c) => c.tokens > 1_000_000)?.projects ?? null,
  /** Extrapolation, at the measured rate above and nothing else. */
  days_from_first_utterance_to_exceed_1m: tokensPerDay > 0 ? Math.ceil(1_000_000 / tokensPerDay) : null,
  cumulative,
};

// -------------------------------------------------------------------- §4 the gate

const gate = {
  datum_recall: pub("datum-recall").accuracy,
  full_context: pub("full-context").accuracy,
  grep: pub("grep").accuracy,
  bar_vs_full_context: pub("full-context").accuracy + 0.10,
  bar_vs_grep: pub("grep").accuracy + 0.10,
  margin_vs_full_context: pub("datum-recall").accuracy - (pub("full-context").accuracy + 0.10),
  margin_vs_grep: pub("datum-recall").accuracy - (pub("grep").accuracy + 0.10),
  /** The bar is above 100% for any full-context score over this. Nothing can clear it. */
  full_context_score_that_makes_the_gate_unreachable: 0.90,
};

// ---------------------------------------------------------------------- report

const totals = {
  projects: stats.length,
  projects_with_speech: ranked.length,
  flat_files: stats.reduce((a, s) => a + s.flat_files, 0),
  flat_bytes: stats.reduce((a, s) => a + s.flat_bytes, 0),
  nested_files: stats.reduce((a, s) => a + s.nested_files, 0),
  nested_bytes: stats.reduce((a, s) => a + s.nested_bytes, 0),
  utterances: stats.reduce((a, s) => a + s.utterances, 0),
  interrupts: stats.reduce((a, s) => a + s.interrupts, 0),
  text_chars: stats.reduce((a, s) => a + s.text_chars, 0),
};

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const usd = (x: number): string => `$${x.toFixed(2)}`;
const row = (cells: (string | number)[], widths: number[]): string =>
  cells.map((c, i) => (typeof c === "number" ? num(c).padStart(widths[i]!) : String(c).padEnd(widths[i]!))).join("  ");

console.log(`\n${"=".repeat(118)}`);
console.log("scale.mts — is full-context a baseline or an artefact of a small corpus?");
console.log("=".repeat(118));

console.log("\n§1 THE ARC ASYMMETRY");
for (const [k, v] of Object.entries(arcCorpus)) console.log(`  ${k.padEnd(34)} ${num(v).padStart(12)}`);
console.log(`  ${"compaction share of payload chars".padEnd(34)} ${
  pct(1 - arcCorpus.datum_visible_payload_chars / arcCorpus.full_context_payload_chars).padStart(12)}`);

console.log("\n§1 ANSWERABILITY — set level (what the grader actually scores)");
const aw = [9, 11, 7, 11, 12, 9, 10];
console.log(row(["set", "answerable", "both", "full-only", "datum-only", "neither", "traps"], aw));
for (const a of asymmetries) {
  console.log(row([a.set, a.answerable, a.both, a.full_only.length, a.datum_only.length, a.neither.length, a.traps], aw));
}
for (const a of asymmetries) {
  console.log(`  ${a.set}: full_only=${JSON.stringify(a.full_only)} datum_only=${JSON.stringify(a.datum_only)} neither=${JSON.stringify(a.neither)}`);
  console.log(`  ${a.set}: record-level full_only=${JSON.stringify(a.record_full_only)} datum_only=${JSON.stringify(a.record_datum_only)}`);
  console.log(`  ${a.set}: traps contaminated only with compaction=${JSON.stringify(a.trap_contam_full_only)} only without=${JSON.stringify(a.trap_contam_datum_only)}`);
  console.log(`  ${a.set}: expect entries reachable only from a compaction summary = ${
    a.entries_only_in_compaction.length} of ${a.expect_entries} ${JSON.stringify(a.entries_only_in_compaction)}`);
}

console.log("\n§1 THE SAME FULL-CONTEXT ARM, SCORED ON 550 UTTERANCES AND ON THE 542 THE STORE ACCEPTS");
const vw = [9, 22, 10, 14, 10, 14];
console.log(row(["set", "payload", "accuracy", "answerable", "traps", "contamination"], vw));
for (const [label, rows] of [["all 550", arcScoredAll], ["datum-visible 542", arcScoredVisible]] as const) {
  for (const s of rows) {
    console.log(row([s.set, label, pct(s.accuracy), `${s.answerable_correct}/${s.answerable_total}`,
      `${s.trap_correct}/${s.trap_total}`, pct(s.contamination)], vw));
  }
}

console.log("\n§2 PER-PROJECT CORPUS (corpus.mts's definition; flat .jsonl only, as corpus.mts reads)");
const cw = [56, 5, 6, 8, 10, 6, 9, 11, 11, 11];
console.log(row(["project", "files", "nested", "flat MB", "nested MB", "utts", "interrupt", "text chars", "payload tok", "span"], cw));
for (const s of stats) {
  console.log(row([
    `${s.root}:${s.project}`.slice(0, 56), s.flat_files, s.nested_files,
    (s.flat_bytes / 1e6).toFixed(1), (s.nested_bytes / 1e6).toFixed(1),
    s.utterances, s.interrupts, s.text_chars, s.payload_tokens,
    s.first === "-" ? "-" : `${s.first}..${s.last}`,
  ], cw));
}
console.log(row(["TOTAL", totals.flat_files, totals.nested_files,
  (totals.flat_bytes / 1e6).toFixed(1), (totals.nested_bytes / 1e6).toFixed(1),
  totals.utterances, totals.interrupts, totals.text_chars,
  estTokens(fullContext([...byProject.values()].flat())), ""], cw));
console.log(`  all .jsonl under both roots: ${num(totals.flat_files + totals.nested_files)} files, ${
  ((totals.flat_bytes + totals.nested_bytes) / 1e9).toFixed(2)} GB`);
console.log(`  nested (subagent) .jsonl not read by corpus.mts: ${num(totals.nested_files)} files, ${
  (totals.nested_bytes / 1e6).toFixed(0)} MB — machine prose, excluded by contract`);
console.log(`  ~/.omp/agent/sessions under corpus.mts's native envelope test: ${
  JSON.stringify(Object.fromEntries(ompNative))} human utterances`);

console.log("\n§3 WHERE FULL-CONTEXT STOPS BEING POSSIBLE");
const sw = [50, 6, 7, 13, 8, 7, 13];
console.log(row(["corpus", "projs", "utts", "tok/question", "200k", "1M", "$/1k q"], sw));
for (const r of scaleRows) {
  console.log(row([r.label, r.projects, r.utterances, r.tokens_per_question,
    r.fits_200k ? "yes" : "NO", r.fits_1m ? "yes" : "NO", usd(r.usd_per_1k_questions)], sw));
}
console.log(row(["datum-recall (retrieves; flat in corpus size)", "-", "-", datumTokens, "yes", "yes",
  usd(costPer1kQuestions(datumTokens))], sw));
console.log(`  cumulative tokens, projects added largest first: ${
  cumulative.map((c) => `${c.projects}:${num(c.tokens)}`).join("  ")}`);
console.log(`  200k window exceeded at ${frontier.projects_to_exceed_200k ?? "never"} project(s); 1M at ${
  frontier.projects_to_exceed_1m ?? "never on this machine"}`);
console.log(`  corpus ${frontier.corpus_first_day}..${frontier.corpus_last_day} = ${
  frontier.span_days} days, ${num(Math.round(frontier.tokens_per_day))} est. tokens/day; EXTRAPOLATION: 1M at day ${
  frontier.days_from_first_utterance_to_exceed_1m ?? "-"}`);

console.log("\n§3 FULL-CONTEXT SCORED IN EVIDENCE MODE OVER EACH PAYLOAD");
const gw = [50, 9, 9, 11, 7, 14];
console.log(row(["corpus", "set", "accuracy", "answerable", "traps", "contamination"], gw));
for (const r of scaleRows) {
  for (const s of r.scores) {
    console.log(row([r.label, s.set, pct(s.accuracy), `${s.answerable_correct}/${s.answerable_total}`,
      `${s.trap_correct}/${s.trap_total}`, pct(s.contamination)], gw));
  }
}

console.log(`\n§3 NO-RETRIEVAL AT DATUM-RECALL'S BUDGET (newest utterances that fit ${num(datumTokens)} est. tokens)`);
console.log(row(["corpus", "set", "accuracy", "answerable", "traps", "contamination"], gw));
for (const r of scaleRows) {
  for (const s of r.budget_matched.scores) {
    console.log(row([`${r.label} — ${r.budget_matched.utterances} utts`, s.set, pct(s.accuracy),
      `${s.answerable_correct}/${s.answerable_total}`, `${s.trap_correct}/${s.trap_total}`, pct(s.contamination)], gw));
  }
}
console.log(`  datum-recall, same budget, published held-out: ${pct(gate.datum_recall)} accuracy, ${
  pct(pub("datum-recall").contamination)} contamination, 4/4 traps (RESULTS.md §5)`);

console.log("\n§4 THE GATE");
console.log(`  datum-recall ${pct(gate.datum_recall)} · full-context ${pct(gate.full_context)} · grep ${pct(gate.grep)}`);
console.log(`  bar vs full-context ${pct(gate.bar_vs_full_context)} → margin ${pct(gate.margin_vs_full_context)}`);
console.log(`  bar vs grep         ${pct(gate.bar_vs_grep)} → margin ${pct(gate.margin_vs_grep)}`);
console.log(`  the +10 gate is unreachable for any baseline scoring above ${pct(gate.full_context_score_that_makes_the_gate_unreachable)}`);

/**
 * Every ratio quoted in `SCALE.md` prose, printed rather than left to the reader's arithmetic. A
 * ratio nobody can reproduce is a ratio nobody should believe.
 */
const arcStat = stats.find((s) => s.root === "claude" && s.project.endsWith("GitHub-arc"));
const arcJsonlBytes = (arcStat?.flat_bytes ?? 0) + (arcStat?.nested_bytes ?? 0);
const days = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const derived = {
  arc_payload_ratio_all_over_visible: arcCorpus.full_context_payload_chars / arcCorpus.datum_visible_payload_chars,
  arc_span_days: arcStat ? days(arcStat.first, arcStat.last) : 0,
  arc_jsonl_bytes: arcJsonlBytes,
  arc_nested_share_of_bytes: arcJsonlBytes > 0 ? (arcStat?.nested_bytes ?? 0) / arcJsonlBytes : 0,
  human_share_of_bytes_opened: totals.text_chars / totals.flat_bytes,
  human_share_of_all_bytes: totals.text_chars / (totals.flat_bytes + totals.nested_bytes),
  whole_machine_over_arc_tokens: frontier.total_tokens / arcCorpus.full_context_payload_tokens,
  full_context_over_datum_tokens_arc: arcCorpus.full_context_payload_tokens / datumTokens,
  full_context_over_datum_tokens_everything: frontier.total_tokens / datumTokens,
  datum_recall_over_budget_matched_heldout_arc:
    gate.datum_recall - (scaleRows[0]?.budget_matched.scores.find((s) => s.set === "heldout")?.accuracy ?? 0),
  datum_recall_over_grep_heldout: gate.datum_recall - gate.grep,
};
console.log("\n§4 DERIVED RATIOS");
const ratio = (v: number): string => Number.isInteger(v) ? num(v)
  : v < 0.01 ? `${(v * 100).toFixed(3)}%`
  : v < 1 ? pct(v)
  : v.toFixed(2);
for (const [k, v] of Object.entries(derived)) console.log(`  ${k.padEnd(46)} ${ratio(v).padStart(13)}`);

const out = {
  generated_at: new Date().toISOString(),
  roots: { claude: CLAUDE_ROOT, omp: OMP_ROOT },
  arc_asymmetry: arcCorpus,
  arc_full_context_scored: { all_550: arcScoredAll, datum_visible_542: arcScoredVisible },
  answerability: asymmetries,
  projects: stats,
  totals,
  omp_native_utterances: Object.fromEntries(ompNative),
  scales: scaleRows,
  frontier,
  datum_recall_tokens_per_question: datumTokens,
  derived,
  gate,
};
writeFileSync(`${HERE}results-scale.json`, `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n${"=".repeat(118)}\nwrote results-scale.json\n`);
