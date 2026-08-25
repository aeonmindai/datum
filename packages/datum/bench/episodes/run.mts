/**
 * Episode retrieval benchmark. Three arms over the same 40 questions, graded by `grade.mts`, which
 * implements `grade.md`. Read `grade.md` first — it is the authority and this file is required to be
 * a faithful implementation of it, not an interpretation.
 *
 *   npx tsx bench/episodes/run.mts
 *   npx tsx bench/episodes/run.mts --arms=grep,full-context --repeats=3
 *   DATUM_TOKEN=$(cat /tmp/benchkey.txt) npx tsx bench/episodes/run.mts --arms=datum
 *
 * Nothing here imports from `src/`. The datum arm is an HTTP client like any other, so a route
 * change costs an environment variable and no code change.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { grade, tokens, type Question, type Verdict } from "./grade.mjs";
import { fullContext, grepLines, readHumanUtterances } from "./corpus.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const QS: Question[] = JSON.parse(readFileSync(`${HERE}questions.json`, "utf8"));

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const ARMS = arg("arms", "grep,full-context,datum").split(",").map((s) => s.trim()).filter(Boolean);
const REPEATS = Math.max(1, Number(arg("repeats", "3")));
const ANSWERER = arg("answerer", "evidence") as "evidence" | "llm";
const GREP_LINES = Number(arg("grep-lines", "40"));
const GREP_WINDOW = Number(arg("grep-window", "2000"));
const DATUM_LIMIT = Number(arg("datum-limit", "20"));
const QUERY_TERMS = Number(arg("query-terms", "4"));
const QUERY = arg("query", "derived") as "derived" | "topic";

const DATUM_BASE = process.env.DATUM_BASE_URL ?? "http://127.0.0.1:8477";
const DATUM_PATH = process.env.DATUM_EPISODES_PATH ?? "/v1/episodes";
const DATUM_SCOPE = process.env.DATUM_SCOPE ?? "org/aeonmind/proj/arc";
const DATUM_TOKEN = process.env.DATUM_TOKEN ?? "";

/** grade.md §8. An estimate, labelled as one: 4 characters per token, the usual English heuristic. */
const estTokens = (s: string): number => Math.ceil(s.length / 4);

// ------------------------------------------------------- the query derivation
//
// One rule, applied identically to all 40 questions and to both the grep arm and the datum arm. No
// query is hand-written for a question: hand-tuning the baseline's query is how a baseline gets
// quietly rigged, and hand-tuning the subject's query is worse.

const STOP = new Set([
  "the", "and", "what", "which", "who", "whom", "whose", "when", "where", "why", "how", "did", "does",
  "was", "were", "had", "has", "have", "that", "this", "these", "those", "with", "from", "for", "his",
  "her", "him", "she", "they", "them", "their", "there", "here", "into", "onto", "over", "under",
  "about", "after", "before", "then", "than", "also", "just", "only", "same", "other", "another",
  "said", "say", "says", "saying", "tell", "told", "call", "called", "name", "named", "give", "gave",
  "want", "wanted", "ask", "asked", "asking", "set", "put", "make", "made", "take", "took", "get",
  "agent", "agents", "jish", "aug", "august", "night", "morning", "evening", "later", "small",
  "figure", "figures", "number", "numbers", "thing", "things", "instead", "three", "two", "one",
  "back", "down", "out", "not", "but", "all", "any", "own", "very", "much", "many", "more", "most",
  "been", "being", "will", "would", "could", "should", "must", "may", "might", "can", "does",
  "quote", "sentence", "exact", "still", "actually", "genuinely", "concrete", "specify", "specified",
  "reported", "report", "reach", "reached", "state", "stated", "hold", "held", "left", "hours",
  "minutes", "seconds", "second", "minute", "hour", "start", "began", "came", "went", "kept",
]);

const { utterances, interrupts } = await readHumanUtterances();
const datumVisible = utterances.filter((u) => !u.pasted);

/** Document frequency over the human corpus, so the query leads with its rarest terms. */
const df = new Map<string, number>();
for (const u of utterances) {
  for (const t of new Set(tokens(u.text))) df.set(t, (df.get(t) ?? 0) + 1);
}

/**
 * Two query regimes, both mechanical, both applied identically to every arm. Which one produced a
 * number must appear next to it.
 *
 * `derived` — content terms lifted from the *question*. This is the realistic case and it is brutal:
 * the questions deliberately paraphrase, because a question that reuses the corpus's own wording
 * leaks its answer into the query. Nothing here is tuned per question.
 *
 * `topic` — the rarest content terms of the source utterance, with every term that occurs in an
 * `expect` or `forbid` entry removed. This models the person who remembers roughly what the
 * conversation was about but not the value, which is the person the product is for. It is an
 * **oracle-topic upper bound** and must be labelled as one: it is built from the ground-truth record,
 * so it guarantees the target contains those terms and reduces the task to ranking one record out of
 * 542. It never contains the answer, and it is the same for all three arms.
 */
function queryTerms(q: Question): string[] {
  const source = QUERY === "topic" ? topicSource(q) : q.question;
  const banned = QUERY === "topic"
    ? new Set([...q.expect, ...q.forbid].flatMap((e) => tokens(e)))
    : new Set<string>();
  const seen = new Set<string>();
  const cand: string[] = [];
  for (const t of tokens(source)) {
    if (t.length < 4 || STOP.has(t) || /^\d/.test(t) || seen.has(t) || banned.has(t)) continue;
    seen.add(t);
    cand.push(t);
  }
  // Rarest first: a term in two utterances locates a conversation, a term in two hundred does not.
  cand.sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || b.length - a.length);
  return cand.slice(0, QUERY_TERMS);
}

const byKey = new Map(utterances.map((u) => [`${u.file}:${u.line}`, u.text]));
function topicSource(q: Question): string {
  return [byKey.get(`${q.source.file}:${q.source.line}`) ?? "",
    ...(q.source.also ?? []).map((a) => byKey.get(`${a.file}:${a.line}`) ?? "")].join("\n");
}

// --------------------------------------------------------------------- arms

interface Retrieved { context: string; units: number; detail?: Record<string, unknown> }

/**
 * grade.md §8. `grep -F -i -n -a` over the raw `.jsonl`, one call per query term, hits unioned in
 * file order. Each hit is a whole JSONL record and a record can be 100 kB of assistant output, so a
 * hit is reduced to a window centred on the match — which is what `grep` in a terminal actually
 * shows you, and what an engineer would paste.
 */
async function armGrep(q: Question): Promise<Retrieved> {
  const seen = new Set<string>();
  const chunks: string[] = [];
  const terms = queryTerms(q);
  for (const term of terms) {
    for (const hit of await grepLines(term, GREP_LINES)) {
      const key = `${hit.file}:${hit.line}`;
      if (seen.has(key) || seen.size >= GREP_LINES) continue;
      seen.add(key);
      const at = hit.text.toLowerCase().indexOf(term.toLowerCase());
      const from = Math.max(0, (at < 0 ? 0 : at) - Math.floor(GREP_WINDOW / 2));
      chunks.push(`${hit.file.slice(0, 8)}:${hit.line}: ${hit.text.slice(from, from + GREP_WINDOW)}`);
    }
  }
  return { context: chunks.join("\n"), units: chunks.length, detail: { terms } };
}

const FULL = fullContext(utterances);

function armFullContext(): Retrieved {
  return { context: FULL, units: utterances.length };
}

interface EpisodeHit {
  id: string; session_id: string; seq: number; occurred_at: string; actor: string; role: string;
  text: string; git_branch: string | null; matched?: string; rank?: number;
}

/**
 * grade.md §8. One request per query term, episodes unioned in arrival order and capped at the same
 * limit — deliberately the same OR semantics `armGrep` gets from one `grep` call per term.
 *
 * The first run of this benchmark sent all four terms as a single `q`, which the endpoint resolves
 * as one FTS query requiring every term. grep meanwhile got four independent searches unioned. Datum
 * abstained on 28 of 40 questions and the number measured that asymmetry, not retrieval. Equalising
 * the semantics helps datum, which is exactly why it is being said out loud here.
 */
async function armDatum(q: Question): Promise<Retrieved> {
  const terms = queryTerms(q);
  const seen = new Set<string>();
  const eps: EpisodeHit[] = [];
  for (const term of terms) {
    const url = new URL(DATUM_PATH, DATUM_BASE);
    url.searchParams.set("scope", DATUM_SCOPE);
    url.searchParams.set("q", term);
    url.searchParams.set("limit", String(DATUM_LIMIT));
    const res = await fetch(url, { headers: DATUM_TOKEN ? { authorization: `Bearer ${DATUM_TOKEN}` } : {} });
    if (!res.ok) throw new Error(`${url.pathname}?q=${term} -> HTTP ${res.status} ${await res.text().catch(() => "")}`);
    const body = (await res.json()) as { ok?: boolean; episodes?: EpisodeHit[] };
    if (body.ok !== true || !Array.isArray(body.episodes)) throw new Error("response is not {ok:true, episodes:[]}");
    for (const e of body.episodes) {
      if (seen.has(e.id) || seen.size >= DATUM_LIMIT) continue;
      seen.add(e.id);
      eps.push(e);
    }
  }
  const context = eps
    .map((e) => `[${String(e.session_id).slice(0, 8)}:${e.seq} ${e.occurred_at}${e.git_branch ? ` branch=${e.git_branch}` : ""} matched=${e.matched ?? "?"}] ${e.actor}: ${e.text}`)
    .join("\n\n");
  const matched: Record<string, number> = {};
  for (const e of eps) matched[e.matched ?? "?"] = (matched[e.matched ?? "?"] ?? 0) + 1;
  return { context, units: eps.length, detail: { matched, terms } };
}

// ----------------------------------------------------------------- answerers

const ANSWER_SYSTEM =
  "You answer questions about a recorded conversation using ONLY the context provided. " +
  "Answer in one short sentence. If the context does not contain the answer, reply exactly: not on record.";

async function answerLlm(q: Question, context: string): Promise<string> {
  const url = process.env.BENCH_ANSWERER_URL;
  const model = process.env.BENCH_ANSWERER_MODEL;
  if (!url || !model) throw new Error("--answerer=llm needs BENCH_ANSWERER_URL and BENCH_ANSWERER_MODEL");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.BENCH_ANSWERER_KEY ? { authorization: `Bearer ${process.env.BENCH_ANSWERER_KEY}` } : {}),
    },
    body: JSON.stringify({
      model, temperature: 0,
      messages: [
        { role: "system", content: ANSWER_SYSTEM },
        { role: "user", content: `${context}\n\n---\nQuestion: ${q.question}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`answerer HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? "";
}

// -------------------------------------------------------------------- the run

interface Row {
  id: string; arm: string; repeat: number; verdict: Verdict; contaminated: boolean;
  missing: string[]; units: number; chars: number; est_tokens: number; ms: number;
  detail?: Record<string, unknown>;
}

async function retrieve(arm: string, q: Question): Promise<Retrieved> {
  if (arm === "grep") return armGrep(q);
  if (arm === "full-context") return armFullContext();
  if (arm === "datum") return armDatum(q);
  throw new Error(`unknown arm ${arm}`);
}

const rows: Row[] = [];
const armErrors = new Map<string, string>();

for (let repeat = 0; repeat < REPEATS; repeat += 1) {
  for (const arm of ARMS) {
    if (armErrors.has(arm)) continue;
    for (const q of QS) {
      const t0 = performance.now();
      let r: Retrieved;
      try {
        r = await retrieve(arm, q);
      } catch (e) {
        armErrors.set(arm, e instanceof Error ? e.message : String(e));
        break;
      }
      const response = ANSWERER === "llm" ? await answerLlm(q, r.context) : r.context;
      const ms = performance.now() - t0;

      // grade.md §8: in evidence mode nobody has asserted anything, so `forbid` is contamination on
      // an answerable question and a verdict only on a trap.
      let g = grade(q, response, ANSWERER);
      if (ANSWERER === "evidence" && r.units === 0 && !q.abstain) {
        g = { verdict: "abstained", contaminated: false, missing: q.expect };
      }
      rows.push({
        id: q.id, arm, repeat, verdict: g.verdict, contaminated: g.contaminated, missing: g.missing,
        units: r.units, chars: r.context.length, est_tokens: estTokens(r.context), ms,
        ...(r.detail ? { detail: r.detail } : {}),
      });
    }
  }
}

// ---------------------------------------------------------------- aggregation

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const stddev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

function aggregate(arm: string) {
  const mine = rows.filter((r) => r.arm === arm);
  if (mine.length === 0) return null;
  const perRepeat: number[] = [];
  for (let r = 0; r < REPEATS; r += 1) {
    const set = mine.filter((x) => x.repeat === r);
    if (set.length === QS.length) perRepeat.push(set.filter((x) => x.verdict === "correct").length / QS.length);
  }
  const first = mine.filter((r) => r.repeat === 0);
  const count = (v: Verdict): number => first.filter((r) => r.verdict === v).length;
  const unstable = QS.filter((q) => new Set(mine.filter((r) => r.id === q.id).map((r) => r.verdict)).size > 1)
    .map((q) => q.id);

  const slice = (pred: (q: Question) => boolean): number => {
    const ids = new Set(QS.filter(pred).map((q) => q.id));
    if (!ids.size) return NaN;
    return first.filter((r) => ids.has(r.id) && r.verdict === "correct").length / ids.size;
  };

  const C = count("correct"), W = count("wrong"), A = count("abstained");
  const answerable = new Set(QS.filter((q) => !q.abstain).map((q) => q.id));
  const trapIds = new Set(QS.filter((q) => q.abstain).map((q) => q.id));

  const matched: Record<string, number> = {};
  for (const r of first) {
    for (const [k, v] of Object.entries((r.detail?.["matched"] ?? {}) as Record<string, number>)) {
      matched[k] = (matched[k] ?? 0) + v;
    }
  }

  return {
    correct: C, wrong: W, abstained: A,
    accuracy: C / QS.length,
    error_rate: W / QS.length,
    abstain_rate: A / QS.length,
    trust: (C - W) / QS.length,
    over_abstain: first.filter((r) => answerable.has(r.id) && r.verdict === "abstained").length / answerable.size,
    trap_accuracy: first.filter((r) => trapIds.has(r.id) && r.verdict === "correct").length / trapIds.size,
    contamination: first.filter((r) => r.contaminated).length / QS.length,
    accuracy_repeats: perRepeat,
    accuracy_mean: mean(perRepeat),
    accuracy_stddev: stddev(perRepeat),
    unstable: unstable.length,
    unstable_ids: unstable,
    by_difficulty: Object.fromEntries((["easy", "medium", "hard"] as const)
      .map((d) => [d, slice((q) => q.difficulty === d)])),
    by_kind: Object.fromEntries([...new Set(QS.map((q) => q.kind))]
      .map((k) => [k, slice((q) => q.kind === k)])),
    only_in_transcript_accuracy: slice((q) => q.source.only_in_transcript === true),
    lost: first.filter((r) => r.verdict !== "correct").map((r) => `${r.id}:${r.verdict}${r.missing.length ? `(${r.missing.join("|")})` : ""}`),
    est_tokens_mean: Math.round(mean(first.map((r) => r.est_tokens))),
    est_tokens_total: first.reduce((a, r) => a + r.est_tokens, 0),
    chars_mean: Math.round(mean(first.map((r) => r.chars))),
    units_mean: Number(mean(first.map((r) => r.units)).toFixed(1)),
    ms_mean: Number(mean(first.map((r) => r.ms)).toFixed(1)),
    ms_p95: Number((first.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(first.length * 0.95)] ?? 0).toFixed(1)),
    ...(Object.keys(matched).length ? { matched } : {}),
  };
}

const out = {
  generated_at: new Date().toISOString(),
  answerer: ANSWERER,
  answerer_note: ANSWERER === "evidence"
    ? "verdicts measure retrieval sufficiency: the retrieved context IS the response, so a verdict is the arm's accuracy ceiling. grade.md §8."
    : `llm answerer ${process.env.BENCH_ANSWERER_MODEL}, temperature 0, identical prompt for every arm`,
  arms: ARMS,
  repeats: REPEATS,
  query_regime: QUERY,
  query_regime_note: QUERY === "topic"
    ? "ORACLE-TOPIC UPPER BOUND: query terms are the rarest content terms of the ground-truth utterance with every expect/forbid term removed. Built from the answer's record, so it guarantees the target contains them; it never contains the answer, and it is identical for all arms."
    : "query terms lifted from the question text only. The questions paraphrase deliberately, so this is the hard regime and it is the realistic one.",
  config: { GREP_LINES, GREP_WINDOW, DATUM_LIMIT, QUERY_TERMS, DATUM_BASE, DATUM_PATH, DATUM_SCOPE },
  corpus: {
    utterances_with_text: utterances.length,
    interrupt_markers: interrupts,
    human_records: utterances.length + interrupts,
    bytes: Buffer.byteLength(utterances.map((u) => u.text).join("\n")),
    datum_visible_episodes: datumVisible.length,
    compaction_summaries_excluded: utterances.length - datumVisible.length,
    compaction_summary_dependency: "none — verify.mts asserts every expect entry of all 40 questions matches inside the 542-episode datum-visible set, so the isCompactSummary exclusion costs datum no question",
  },
  questions: {
    total: QS.length,
    by_kind: Object.fromEntries([...new Set(QS.map((q) => q.kind))]
      .map((k) => [k, QS.filter((q) => q.kind === k).length])),
    by_difficulty: Object.fromEntries((["easy", "medium", "hard"] as const)
      .map((d) => [d, QS.filter((q) => q.difficulty === d).length])),
    only_in_transcript: QS.filter((q) => q.source.only_in_transcript).length,
    abstention_traps: QS.filter((q) => q.abstain).length,
  },
  arm_errors: Object.fromEntries(armErrors),
  results: Object.fromEntries(ARMS.map((a) => [a, aggregate(a)])),
  rows: rows.filter((r) => r.repeat === 0),
};
const OUT_FILE = QUERY === "derived" ? "results.json" : `results-${QUERY}.json`;
writeFileSync(`${HERE}${OUT_FILE}`, `${JSON.stringify(out, null, 2)}\n`);

// -------------------------------------------------------------------- report

const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "  -  ");
console.log(`\n${"=".repeat(100)}`);
console.log(`episode retrieval benchmark — answerer=${ANSWERER}, query=${QUERY}, repeats=${REPEATS}, ${QS.length} questions`);
console.log(out.query_regime_note);
console.log(out.answerer_note);
console.log(`corpus: ${utterances.length} human utterances / ${out.corpus.bytes.toLocaleString()} bytes; datum sees ${datumVisible.length} episodes`);
console.log("=".repeat(100));
console.log(["arm".padEnd(13), "acc".padStart(7), "±sd".padStart(7), "wrong".padStart(7),
  "abst".padStart(7), "trust".padStart(7), "traps".padStart(7), "contam".padStart(7),
  "tok/q".padStart(8), "ms/q".padStart(8), "unstab".padStart(7)].join(" "));
for (const arm of ARMS) {
  const a = out.results[arm];
  if (!a) { console.log(`${arm.padEnd(13)}  not run: ${armErrors.get(arm) ?? "no rows"}`); continue; }
  console.log([arm.padEnd(13), pct(a.accuracy).padStart(7), pct(a.accuracy_stddev).padStart(7),
    pct(a.error_rate).padStart(7), pct(a.abstain_rate).padStart(7), pct(a.trust).padStart(7),
    pct(a.trap_accuracy).padStart(7), pct(a.contamination).padStart(7),
    String(a.est_tokens_mean).padStart(8), String(a.ms_mean).padStart(8),
    String(a.unstable).padStart(7)].join(" "));
}
console.log("-".repeat(100));
for (const arm of ARMS) {
  const a = out.results[arm];
  if (!a) continue;
  console.log(`${arm}`);
  console.log(`  difficulty  ${Object.entries(a.by_difficulty).map(([k, v]) => `${k} ${pct(v)}`).join("  ")}`);
  console.log(`  kind        ${Object.entries(a.by_kind).map(([k, v]) => `${k} ${pct(v)}`).join("  ")}`);
  console.log(`  only_in_transcript ${pct(a.only_in_transcript_accuracy)}   input tokens total ${a.est_tokens_total.toLocaleString()}   repeats ${a.accuracy_repeats.map((x) => pct(x)).join(" ")}`);
  if (a.matched) console.log(`  datum match tiers ${JSON.stringify(a.matched)}`);
  console.log(`  lost: ${a.lost.length ? a.lost.join("  ") : "none"}`);
}
for (const [arm, err] of armErrors) console.log(`\n!! ${arm} arm did not run: ${err}`);
console.log(`${"=".repeat(100)}\nwrote ${OUT_FILE}\n`);
