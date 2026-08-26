/**
 * Episode retrieval benchmark. Four arms over one question set, graded by `grade.mts`, which
 * implements `grade.md`. Read `grade.md` first — it is the authority and this file is required to be
 * a faithful implementation of it, not an interpretation.
 *
 *   npx tsx bench/episodes/run.mts
 *   npx tsx bench/episodes/run.mts --arms=grep,full-context --repeats=3
 *   npx tsx bench/episodes/run.mts --questions=questions-heldout.json
 *   DATUM_TOKEN=$(cat /tmp/benchkey.txt) npx tsx bench/episodes/run.mts --arms=datum,datum-recall
 *
 * Nothing here imports from `src/`. Both datum arms are HTTP clients like any other, so a route
 * change costs an environment variable and no code change.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expectSatisfied, grade, tokens, type Question, type Verdict } from "./grade.mjs";
import { fullContext, grepLines, readHumanUtterances } from "./corpus.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

/**
 * grade.md §10. One runner, three question sets. `--questions=` names the file; the label in every
 * output filename and report header is derived from that name, so a tuned number, a held-out number
 * and a clean number can never be mistaken for each other.
 *
 * `--out=` overrides only the filename. It exists so a re-measurement against changed retrieval code
 * can be written beside the earlier one instead of on top of it: an overwritten results file is an
 * erased comparison.
 */
const QUESTIONS_FILE = arg("questions", "questions.json");
const QUESTIONS_PATH = QUESTIONS_FILE.startsWith("/") ? QUESTIONS_FILE : `${HERE}${QUESTIONS_FILE}`;
const QS: Question[] = JSON.parse(readFileSync(QUESTIONS_PATH, "utf8"));
const SET = QUESTIONS_FILE.replace(/^.*\//, "").replace(/\.json$/, "").replace(/^questions-?/, "") || "tuned";

const ARMS = arg("arms", "grep,full-context,datum,datum-recall").split(",").map((s) => s.trim()).filter(Boolean);
const REPEATS = Math.max(1, Number(arg("repeats", "3")));
const ANSWERER = arg("answerer", "evidence") as "evidence" | "llm";
const GREP_LINES = Number(arg("grep-lines", "40"));
const GREP_WINDOW = Number(arg("grep-window", "2000"));
const DATUM_LIMIT = Number(arg("datum-limit", "20"));
const RECALL_LIMIT = Number(arg("recall-limit", "12"));
const QUERY_TERMS = Number(arg("query-terms", "4"));
const QUERY = arg("query", "derived") as "derived" | "topic";
const OUT_OVERRIDE = arg("out", "");
/**
 * The composition every set's strata are re-weighted onto: 16/40 temporal, which is
 * `questions-heldout.json`. Chosen because it is the *least* temporal of the three, so re-weighting
 * onto it can only remove credit the window tier was getting from a set that happened to name more
 * dates. Re-weighting onto the more favourable composition would be picking the flattering baseline.
 */
const REWEIGHT = Number(arg("reweight", String(16 / 40)));

// --------------------------------------------------- the temporal stratifier
//
// The window tier can only fire on a question that names a time, and the three sets do not carry
// times in the same proportion: 30/40, 16/40, 30/40. Comparing their totals therefore compares
// composition as much as retrieval, so every accuracy here is also reported split on this predicate.
//
// Three regexes over the question text and nothing else — no ground truth, no server plan, so the
// same question is classified identically for all four arms. `any` reproduces the counts published
// in THIRD.md (30 / 16 / 30) and its ten non-temporal third-set ids exactly.
const T_DATE = /\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*(\d{1,2})\b|\b(\d{1,2})(st|nd|rd|th)\b|\b(yesterday|today|tonight)\b/i;
const T_CLOCK = /\b\d{1,2}\s*:\s*\d{2}\b|\b\d{1,2}\s*(am|pm)\b|\b(midnight|noon|midday)\b|\bsmall hours\b/i;
const T_PART = /\b(morning|afternoon|evening|night|overnight|dawn|dusk|late on|early on|lunchtime)\b/i;
const isTemporal = (q: Question): boolean =>
  T_DATE.test(q.question) || T_CLOCK.test(q.question) || T_PART.test(q.question);

const DATUM_BASE = process.env.DATUM_BASE_URL ?? "http://127.0.0.1:8477";
const DATUM_PATH = process.env.DATUM_EPISODES_PATH ?? "/v1/episodes";
const RECALL_PATH = process.env.DATUM_RECALL_PATH ?? "/v1/recall";
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

/**
 * `alt` is an ablation of the same retrieval, graded alongside it and never instead of it. Only
 * `datum-recall` sets it: the same episodes with every `window`-tier row deleted, which is what the
 * arm would have handed over had the window tier not existed.
 */
interface Retrieved {
  context: string;
  units: number;
  detail?: Record<string, unknown>;
  alt?: { context: string; units: number };
}

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

interface RecallHit extends EpisodeHit {
  tier: "term+window" | "term" | "window";
  score: number;
  matched_terms: string[];
}

const TIER_ORDER = ["term+window", "term", "window"] as const;

/**
 * grade.md §10. One request, carrying the **entire question text verbatim**. No term extraction
 * happens on this side in any regime — reading the question is the server's job now, and that is the
 * whole claim under test. `tier` records how each episode was reached: `term` (shared vocabulary),
 * `window` (returned because the question named a time and nothing shared a word), or both.
 *
 * Tier attribution for the answer is done by re-checking `expect` against the context restricted to
 * one tier, using the same §3 matcher the verdict uses. No second rule is invented here. `window_only`
 * is the number that matters: the answer was in front of the agent *only* because of the date.
 */
async function armDatumRecall(q: Question): Promise<Retrieved> {
  const url = new URL(RECALL_PATH, DATUM_BASE);
  url.searchParams.set("scope", DATUM_SCOPE);
  url.searchParams.set("question", q.question);
  url.searchParams.set("limit", String(RECALL_LIMIT));
  const res = await fetch(url, { headers: DATUM_TOKEN ? { authorization: `Bearer ${DATUM_TOKEN}` } : {} });
  if (!res.ok) throw new Error(`${url.pathname} -> HTTP ${res.status} ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as
    { ok?: boolean; note?: string; plan?: Record<string, unknown>; episodes?: RecallHit[] };
  if (body.ok !== true || !Array.isArray(body.episodes)) throw new Error("response is not {ok:true, episodes:[]}");
  const eps = body.episodes;

  const render = (list: RecallHit[]): string => list
    .map((e) => `[${String(e.session_id).slice(0, 8)}:${e.seq} ${e.occurred_at}${e.git_branch ? ` branch=${e.git_branch}` : ""} tier=${e.tier} score=${e.score}] ${e.actor}: ${e.text}`)
    .join("\n\n");
  const context = render(eps);

  const tiers: Record<string, number> = {};
  for (const e of eps) tiers[e.tier] = (tiers[e.tier] ?? 0) + 1;
  const plan = body.plan ?? {};
  const detail: Record<string, unknown> = {
    tiers,
    note: body.note ?? "",
    terms: ((plan["terms"] as { term: string }[] | undefined) ?? []).map((t) => t.term),
    window: (plan["window"] as { read_as?: string } | undefined)?.read_as ?? null,
  };
  if (!q.abstain && expectSatisfied(context, q.expect)) {
    detail["answer_tier"] = TIER_ORDER
      .find((t) => expectSatisfied(render(eps.filter((e) => e.tier === t)), q.expect)) ?? "combined";
    detail["window_only"] = !expectSatisfied(render(eps.filter((e) => e.tier !== "window")), q.expect);
  }
  // The window-tier ablation, graded by the same grader in the same run rather than reasoned about
  // afterwards. It is an upper bound on what a windowless build would score: deleting the tier from
  // the result set removes rows and changes nothing else, whereas deleting the mechanism would also
  // remove the window *filter*, which is what currently stops a long out-of-window document from
  // outscoring the right sentence inside the window.
  const noWindow = eps.filter((e) => e.tier !== "window");
  return {
    context,
    units: eps.length,
    detail,
    alt: { context: render(noWindow), units: noWindow.length },
  };
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
  temporal: boolean;
  /** The same question graded on the window-tier ablation. Only `datum-recall`, evidence mode only. */
  nowin_verdict?: Verdict;
  nowin_units?: number;
  detail?: Record<string, unknown>;
}

async function retrieve(arm: string, q: Question): Promise<Retrieved> {
  if (arm === "grep") return armGrep(q);
  if (arm === "full-context") return armFullContext();
  if (arm === "datum") return armDatum(q);
  if (arm === "datum-recall") return armDatumRecall(q);
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

      // The ablation is graded by the same call, with the same empty-result rule, so its number is
      // comparable to the number beside it and not to a different grader's idea of correct. In `llm`
      // mode it is skipped rather than approximated: that would be a second generation, not an
      // ablation of this one.
      let nowin: { verdict: Verdict } | undefined;
      if (r.alt && ANSWERER === "evidence") {
        nowin = grade(q, r.alt.context, ANSWERER);
        if (r.alt.units === 0 && !q.abstain) nowin = { verdict: "abstained" };
      }
      rows.push({
        id: q.id, arm, repeat, verdict: g.verdict, contaminated: g.contaminated, missing: g.missing,
        units: r.units, chars: r.context.length, est_tokens: estTokens(r.context), ms,
        temporal: isTemporal(q),
        ...(nowin ? { nowin_verdict: nowin.verdict, nowin_units: r.alt?.units ?? 0 } : {}),
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

  // grade.md §10. `datum-recall` tiers. `episode_tiers` counts retrieved episodes; `answer_tiers`
  // counts *questions whose answer was actually present*, attributed to the strongest tier that
  // carried it on its own; `window_only` counts the answers that were present only because the
  // question named a time, which is the specific claim the window tier makes.
  const episodeTiers: Record<string, number> = {};
  const answerTiers: Record<string, number> = {};
  let windowOnly = 0;
  for (const r of first) {
    for (const [k, v] of Object.entries((r.detail?.["tiers"] ?? {}) as Record<string, number>)) {
      episodeTiers[k] = (episodeTiers[k] ?? 0) + v;
    }
    const at = r.detail?.["answer_tier"];
    if (typeof at === "string") answerTiers[at] = (answerTiers[at] ?? 0) + 1;
    if (r.detail?.["window_only"] === true) windowOnly += 1;
  }

  const msPerRepeat: number[] = [];
  for (let r = 0; r < REPEATS; r += 1) {
    const set = mine.filter((x) => x.repeat === r);
    if (set.length === QS.length) msPerRepeat.push(mean(set.map((x) => x.ms)));
  }

  // The temporal stratification, per repeat so it carries its own variance. `reweighted` places this
  // set's two strata on the held-out set's 16/40 composition, which is the only way a third-set
  // number and a held-out number can be compared without comparing how many dates were typed.
  const stratum = (want: boolean, repeat: number): number => {
    const set = mine.filter((x) => x.repeat === repeat && x.temporal === want);
    return set.length ? set.filter((x) => x.verdict === "correct").length / set.length : NaN;
  };
  const repeatIdx = Array.from({ length: REPEATS }, (_, i) => i);
  const tRep = repeatIdx.map((r) => stratum(true, r)).filter((x) => Number.isFinite(x));
  const nRep = repeatIdx.map((r) => stratum(false, r)).filter((x) => Number.isFinite(x));
  const nTemporal = QS.filter(isTemporal).length;
  const temporalBlock = {
    temporal_n: nTemporal,
    non_temporal_n: QS.length - nTemporal,
    temporal_accuracy: mean(tRep),
    temporal_stddev: stddev(tRep),
    non_temporal_accuracy: mean(nRep),
    non_temporal_stddev: stddev(nRep),
    reweight_temporal_share: REWEIGHT,
    accuracy_reweighted: REWEIGHT * mean(tRep) + (1 - REWEIGHT) * mean(nRep),
    temporal_lost: first.filter((r) => r.temporal && r.verdict !== "correct").map((r) => r.id),
    non_temporal_lost: first.filter((r) => !r.temporal && r.verdict !== "correct").map((r) => r.id),
  };

  // The window-tier ablation. Graded, not inferred: every repeat re-scored on the same episodes with
  // the `window`-tier rows deleted. Upper bound on a windowless build, for the reason given at the
  // arm. Absent for every arm that does not produce tiers.
  const nowinRep: number[] = [];
  for (const r of repeatIdx) {
    const set = mine.filter((x) => x.repeat === r && x.nowin_verdict !== undefined);
    if (set.length === QS.length) nowinRep.push(set.filter((x) => x.nowin_verdict === "correct").length / QS.length);
  }
  const nowinFirst = first.filter((r) => r.nowin_verdict !== undefined);
  const withoutWindow = nowinRep.length === 0 ? null : {
    accuracy: mean(nowinRep),
    accuracy_repeats: nowinRep,
    accuracy_stddev: stddev(nowinRep),
    delta_vs_full: mean(nowinRep) - mean(perRepeat),
    lost_by_ablation: nowinFirst
      .filter((r) => r.verdict === "correct" && r.nowin_verdict !== "correct")
      .map((r) => `${r.id}:${r.nowin_verdict}`),
    gained_by_ablation: nowinFirst
      .filter((r) => r.verdict !== "correct" && r.nowin_verdict === "correct")
      .map((r) => r.id),
    units_mean: Number(mean(nowinFirst.map((r) => r.nowin_units ?? 0)).toFixed(1)),
    method: "window-tier rows deleted from the same responses and re-graded; the server has no flag to disable the tier, so the window FILTER is still in force and this is an upper bound",
  };

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
    ms_mean_repeats: msPerRepeat.map((x) => Number(x.toFixed(1))),
    ms_stddev: Number(stddev(msPerRepeat).toFixed(1)),
    trap_detail: first.filter((r) => trapIds.has(r.id))
      .map((r) => `${r.id}:${r.verdict}${r.contaminated ? "+contaminated" : ""}`),
    ...temporalBlock,
    ...(withoutWindow ? { without_window: withoutWindow } : {}),
    ...(Object.keys(episodeTiers).length
      ? { episode_tiers: episodeTiers, answer_tiers: answerTiers, window_only: windowOnly }
      : {}),
  };
}

const out = {
  generated_at: new Date().toISOString(),
  answerer: ANSWERER,
  answerer_note: ANSWERER === "evidence"
    ? "verdicts measure retrieval sufficiency: the retrieved context IS the response, so a verdict is the arm's accuracy ceiling. grade.md §8."
    : `llm answerer ${process.env.BENCH_ANSWERER_MODEL}, temperature 0, identical prompt for every arm`,
  question_set: SET,
  questions_file: QUESTIONS_FILE,
  question_set_note: SET === "tuned"
    ? "TUNED SET: the retrieval code, including /v1/recall, was designed after reading which of these 40 it failed. Any improvement here is contaminated and must be labelled as such."
    : SET === "heldout"
      ? "BURNED HELD-OUT SET: clean for exactly one run. Its six failures were then read and when.ts and terms.ts were built from two of them, so it is now as contaminated as the tuned set and is reported as a middle rung, not as the verdict."
      : "CLEAN SET: built by an agent that read neither src/ nor any results file, pairwise disjoint source lines from both other sets. Nothing has been read off it and nothing built from it. This is the number that counts.",
  arms: ARMS,
  repeats: REPEATS,
  query_regime: QUERY,
  query_regime_note: QUERY === "topic"
    ? "ORACLE-TOPIC UPPER BOUND: query terms are the rarest content terms of the ground-truth utterance with every expect/forbid term removed. Built from the answer's record, so it guarantees the target contains them; it never contains the answer, and it is identical for all arms."
    : "query terms lifted from the question text only. The questions paraphrase deliberately, so this is the hard regime and it is the realistic one.",
  config: {
    GREP_LINES, GREP_WINDOW, DATUM_LIMIT, RECALL_LIMIT, QUERY_TERMS,
    DATUM_BASE, DATUM_PATH, RECALL_PATH, DATUM_SCOPE,
  },
  corpus: {
    utterances_with_text: utterances.length,
    interrupt_markers: interrupts,
    human_records: utterances.length + interrupts,
    bytes: Buffer.byteLength(utterances.map((u) => u.text).join("\n")),
    datum_visible_episodes: datumVisible.length,
    compaction_summaries_excluded: utterances.length - datumVisible.length,
    compaction_summary_dependency: SET === "tuned"
      ? "none — verify.mts asserts every expect entry of all 40 E questions matches inside the 542-episode datum-visible set, so the isCompactSummary exclusion costs datum no question"
      : SET === "heldout"
        ? "none — HELDOUT.md §2 asserts every H question's source record survives corpus.mts's filter (isCompactSummary included) and every expect token appears in it"
        : "none — SCALE.md establishes answerability is identical between the 542 stored episodes and the 550 utterances full-context receives, in both directions, for every question of every set",
  },
  questions: {
    total: QS.length,
    by_kind: Object.fromEntries([...new Set(QS.map((q) => q.kind))]
      .map((k) => [k, QS.filter((q) => q.kind === k).length])),
    by_difficulty: Object.fromEntries((["easy", "medium", "hard"] as const)
      .map((d) => [d, QS.filter((q) => q.difficulty === d).length])),
    only_in_transcript: QS.filter((q) => q.source.only_in_transcript).length,
    abstention_traps: QS.filter((q) => q.abstain).length,
    temporal: QS.filter(isTemporal).length,
    temporal_note: "a calendar date, a clock time or a part of the day, by regex over the question text alone. Reproduces THIRD.md's published 30 / 16 / 30.",
  },
  arm_errors: Object.fromEntries(armErrors),
  results: Object.fromEntries(ARMS.map((a) => [a, aggregate(a)])),
  rows: rows.filter((r) => r.repeat === 0),
};
const OUT_FILE = OUT_OVERRIDE || `results-${SET}-${QUERY}.json`;
writeFileSync(`${HERE}${OUT_FILE}`, `${JSON.stringify(out, null, 2)}\n`);

// -------------------------------------------------------------------- report

const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "  -  ");
console.log(`\n${"=".repeat(100)}`);
console.log(`episode retrieval benchmark — set=${SET} (${QUESTIONS_FILE}), answerer=${ANSWERER}, query=${QUERY}, repeats=${REPEATS}, ${QS.length} questions`);
console.log(out.question_set_note);
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
  console.log(`  temporal ${a.temporal_n}q ${pct(a.temporal_accuracy)} (sd ${pct(a.temporal_stddev)})   non-temporal ${a.non_temporal_n}q ${pct(a.non_temporal_accuracy)} (sd ${pct(a.non_temporal_stddev)})   reweighted to ${(a.reweight_temporal_share * 40).toFixed(0)}/40 temporal ${pct(a.accuracy_reweighted)}`);
  if (a.without_window) {
    console.log(`  window tier deleted ${pct(a.without_window.accuracy)} (${pct(a.without_window.delta_vs_full)} vs full)   lost ${a.without_window.lost_by_ablation.join(" ") || "none"}   gained ${a.without_window.gained_by_ablation.join(" ") || "none"}`);
  }
  if (a.matched) console.log(`  datum match tiers ${JSON.stringify(a.matched)}`);
  if (a.episode_tiers) {
    console.log(`  recall episode tiers ${JSON.stringify(a.episode_tiers)}   answer tiers ${JSON.stringify(a.answer_tiers)}   window-only answers ${a.window_only}`);
  }
  console.log(`  traps: ${a.trap_detail.join("  ")}   ms/q per repeat ${a.ms_mean_repeats.join(" ")} (sd ${a.ms_stddev})`);
  console.log(`  lost: ${a.lost.length ? a.lost.join("  ") : "none"}`);
}
for (const [arm, err] of armErrors) console.log(`\n!! ${arm} arm did not run: ${err}`);
console.log(`${"=".repeat(100)}\nwrote ${OUT_FILE}\n`);
