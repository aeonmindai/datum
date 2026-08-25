/**
 * Verifies the instrument before it is allowed to measure anything.
 *
 * Two jobs, and the run fails on the first violation of either:
 *
 *  1. `grade.md` §9 — every construction rule on `questions.json`, including reading the exact
 *     source line out of the 668 MB of transcripts and checking the quote is verbatim, and
 *     recomputing `only_in_transcript` against the Arc repo rather than trusting the label.
 *  2. `grade.md` §7 — the adversarial suite. Hand the grader answers a lenient implementation would
 *     pass and assert it refuses every one.
 *
 * Run: `npx tsx bench/episodes/verify.mts`
 */
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { entryHits, grade, isAbstention, tokens, type Question, type Verdict } from "./grade.mjs";
import { readHumanUtterances, readLine } from "./corpus.mjs";

const exec = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ARC = process.env.BENCH_ARC_DIR ?? "/Users/jish/Documents/GitHub/arc";

const QS: Question[] = JSON.parse(readFileSync(`${HERE}questions.json`, "utf8"));
const failures: string[] = [];
const notes: string[] = [];
function check(ok: boolean, msg: string): void { if (!ok) failures.push(msg); }

// ---------------------------------------------------------------- §9.1 shape

check(QS.length === 40, `expected 40 questions, got ${QS.length}`);
const ids = QS.map((q) => q.id);
check(new Set(ids).size === 40, "duplicate question ids");
QS.forEach((q, i) => check(q.id === `E${String(i + 1).padStart(2, "0")}`, `id out of sequence at ${i}: ${q.id}`));
const traps = QS.filter((q) => q.abstain);
check(traps.length === 4, `expected 4 abstention traps, got ${traps.length}`);
for (const t of traps) check(t.expect.length === 0, `${t.id}: trap must have empty expect`);
for (const q of QS) {
  if (!q.abstain) check(q.expect.length > 0, `${q.id}: answerable question with empty expect`);
}

// -------------------------------------------------- §9.2–§9.3 source is real

const { utterances, interrupts } = await readHumanUtterances();
const byKey = new Map(utterances.map((u) => [`${u.file}:${u.line}`, u]));
const corpusBytes = utterances.reduce((n, u) => n + Buffer.byteLength(u.text), 0);
notes.push(`corpus: ${utterances.length} utterances with text + ${interrupts} interrupt markers = ${utterances.length + interrupts} human records, ${corpusBytes.toLocaleString()} bytes`);

let quoteFailures = 0;
for (const q of QS) {
  const refs = [{ file: q.source.file, line: q.source.line, quote: q.source.quote }, ...(q.source.also ?? [])];
  for (const ref of refs) {
    const u = byKey.get(`${ref.file}:${ref.line}`);
    if (!u) { failures.push(`${q.id}: ${ref.file}:${ref.line} is not a human utterance`); quoteFailures += 1; continue; }
    if (!u.text.includes(ref.quote)) {
      failures.push(`${q.id}: quote is not a verbatim substring of ${ref.file}:${ref.line}`);
      quoteFailures += 1;
    }
    // The line number must also survive an independent read straight off disk.
    const raw = await readLine(ref.file, ref.line);
    check(raw !== null && raw.includes(JSON.stringify(ref.quote).slice(1, -1).slice(0, 40)),
      `${q.id}: ${ref.file}:${ref.line} does not carry the quote when read directly`);
  }
  const u = byKey.get(`${q.source.file}:${q.source.line}`)!;
  if (u) {
    check(u.ts === q.source.ts, `${q.id}: ts ${q.source.ts} != record ${u.ts}`);
    check(u.session === q.source.session, `${q.id}: session ${q.source.session} != record ${u.session}`);
    check(!u.pasted, `${q.id}: sources a claim from a /compact summary`);
  }
}

// ------------------------------------------- §9.4–§9.6 evidence and hygiene

const corpusJoined = utterances.map((u) => u.text).join("\n");
for (const q of QS) {
  for (const e of q.expect) {
    check(entryHits(corpusJoined, e), `${q.id}: expect ${JSON.stringify(e)} matches nothing in the corpus`);
  }
  const own = byKey.get(`${q.source.file}:${q.source.line}`);
  if (!own) continue;
  const evidence = q.spans_utterances
    ? [own.text, ...(q.source.also ?? []).map((a) => byKey.get(`${a.file}:${a.line}`)?.text ?? "")].join("\n")
    : own.text;
  for (const e of q.expect) {
    check(entryHits(evidence, e), `${q.id}: expect ${JSON.stringify(e)} not present in its own evidence`);
  }
  for (const f of q.forbid) {
    check(!entryHits(evidence, f), `${q.id}: forbid ${JSON.stringify(f)} appears in its own evidence`);
  }
}

// ------------------------------------------------------- §9.7 trap absence

for (const t of traps) {
  // grade.md §5: an all-numeric forbid entry carries no subject of its own and must declare one.
  const floating = t.forbid.filter((f) => tokens(f).every((x) => /^-?\d+(\.\d+)?$/.test(x)));
  if (floating.length) {
    check((t.forbid_subject ?? []).length > 0,
      `${t.id}: all-numeric forbid ${JSON.stringify(floating)} with no forbid_subject to anchor it`);
  }
  const probes = t.source.absent_probes ?? [];
  check(probes.length > 0, `${t.id}: trap carries no absent_probes`);
  for (const p of probes) {
    const hit = utterances.find((u) => entryHits(u.text, p));
    check(hit === undefined,
      `${t.id}: probe ${JSON.stringify(p)} matches ${hit?.file}:${hit?.line} — the trap is answerable`);
  }
}

// ------------------------------- compaction-summary dependency, asked for by the integrator
//
// The ingest path drops the 8 `isCompactSummary` records, taking the corpus from 550 utterances with
// text to the 542 episodes Datum actually stores. They are dropped because a compaction summary is a
// document that has *already* discarded its qualifiers, and storing one as testimony from a named
// human would let 15-21k characters of second-hand prose outrank every real sentence in the corpus.
//
// That exclusion is only safe if no question's answer lives *only* inside a summary. Where one does,
// the question stays and the loss is reported, because a benchmark that deletes the cases its
// subject fails measures nothing. This block decides which of those two it is, mechanically.

const datumVisible = utterances.filter((u) => !u.pasted);
const summaries = utterances.filter((u) => u.pasted);
const datumJoined = datumVisible.map((u) => u.text).join("\n");
const summaryOnly: string[] = [];
for (const q of QS) {
  for (const e of q.expect) {
    if (!entryHits(datumJoined, e)) summaryOnly.push(`${q.id}:${JSON.stringify(e)}`);
  }
  const own = byKey.get(`${q.source.file}:${q.source.line}`);
  if (own?.pasted) summaryOnly.push(`${q.id}: source record is a compaction summary`);
}
notes.push(`datum-visible set: ${datumVisible.length} episodes (${utterances.length} utterances - ${summaries.length} compaction summaries, ${Buffer.byteLength(datumJoined).toLocaleString()} bytes)`);
notes.push(summaryOnly.length === 0
  ? "compaction-summary dependency: NONE — every answer survives the ingest exclusion, so datum loses no question to it"
  : `compaction-summary dependency: ${summaryOnly.length} — ${summaryOnly.join(", ")} (kept; reported as a real loss for datum)`);

// -------------------------------------- §9.8 only_in_transcript, recomputed

const commit = (await exec("git", ["-C", ARC, "rev-parse", "HEAD"])).stdout.trim();
const tracked = (await exec("git", ["-C", ARC, "ls-files", "-z"], { maxBuffer: 1 << 28 })).stdout
  .split("\0").filter(Boolean);
const fileTokens: { path: string; toks: string[]; set: Set<string> }[] = [];
for (const f of tracked) {
  let body: string;
  try {
    if (statSync(`${ARC}/${f}`).size > 4 << 20) continue; // no source file this large carries prose
    body = readFileSync(`${ARC}/${f}`, "latin1");
  } catch { continue; }
  const toks = tokens(body);
  fileTokens.push({ path: f, toks, set: new Set(toks) });
}
notes.push(`arc commit ${commit}, ${fileTokens.length}/${tracked.length} tracked files scanned`);

function fileHoldsWholeFact(q: Question): string | null {
  const wanted = q.expect.map((e) => tokens(e));
  if (wanted.length === 0) return null;
  for (const f of fileTokens) {
    // Cheap reject: every entry's first token must at least be in the file.
    if (!wanted.every((w) => f.set.has(w[0]!) || [...f.set].some((t) => t.startsWith(w[0]!)))) continue;
    const joined = f.toks.join(" ");
    if (q.expect.every((e) => entryHits(joined, e))) return f.path;
  }
  return null;
}

/**
 * The entry to run `git log -S` on: the one matching the fewest tracked files at HEAD, ties broken
 * by length. "Longest" is the obvious proxy and it is the wrong one — on E32 it picks `15 minute`,
 * a phrase in six commits and in no way the distinctive part of the fact, over `3.6 hour`, which is
 * in none. Rarity is the property that makes a pickaxe result mean anything.
 */
const rarestCache = new Map<string, string>();
function rarestEntry(q: Question): string {
  const hit = rarestCache.get(q.id);
  if (hit !== undefined) return hit;
  const pick = [...q.expect]
    .map((e) => ({ e, n: fileTokens.filter((f) => entryHits(f.toks.join(" "), e)).length }))
    .sort((a, b) => a.n - b.n || b.e.length - a.e.length)[0]!.e;
  rarestCache.set(q.id, pick);
  return pick;
}

let onlyCount = 0;
const holders: string[] = [];
for (const q of QS) {
  if (q.abstain) {
    check(q.source.only_in_transcript !== true, `${q.id}: a trap cannot be only_in_transcript`);
    continue;
  }
  const holder = fileHoldsWholeFact(q);
  let computed = holder === null;
  let pickaxe = "";
  if (computed) {
    const distinctive = rarestEntry(q);
    const r = await exec("git", ["-C", ARC, "log", "--format=%h", `-S${distinctive}`], { maxBuffer: 1 << 28 });
    pickaxe = r.stdout.trim();
    if (pickaxe) computed = false;
  }
  if (computed) onlyCount += 1;
  holders.push(`${q.id} ${computed ? "ONLY" : "REPO"} ${holder ?? (pickaxe ? `history:${pickaxe.split("\n").length}:${rarestEntry(q)}` : "-")}`);
  if ((q.source.only_in_transcript ?? false) !== computed) {
    failures.push(`${q.id}: only_in_transcript recorded ${q.source.only_in_transcript ?? false}, computed ${computed}` +
      (holder ? ` (held whole by ${holder})` : pickaxe ? ` (git log -S found ${pickaxe.split("\n").length} commits)` : ""));
  }
}
check(onlyCount >= 8, `only ${onlyCount} questions are only_in_transcript, need >= 8`);
notes.push(`only_in_transcript: ${onlyCount}`);
if (process.env.BENCH_SHOW_HOLDERS) for (const h of holders) console.log(`  ${h}`);

// ------------------------------------------------- §7 adversarial validation

const byId = new Map(QS.map((q) => [q.id, q]));
function q(id: string): Question { const r = byId.get(id); if (!r) throw new Error(`no ${id}`); return r; }

interface Adversary { label: string; q: Question; answer: string; expectVerdict?: Verdict }
const SUITE: Adversary[] = [
  { label: "plausible-but-wrong number", q: q("E08"), answer: "He restated the bar as 250 tok/s and 90% quality with the model fitting." },
  { label: "near-miss number a substring grader passes ($280 vs $28)", q: q("E35"), answer: "He said it could have been closed for $280." },
  { label: "near-miss number a substring grader passes (21s vs 1s)", q: q("E10"), answer: "He set the bound at 21 seconds." },
  { label: "superseded value, live at a different date", q: q("E02"), answer: "The agent was reporting 96% and Jish had been promised 90+." },
  { label: "right number, wrong subject", q: q("E05"), answer: "He said GEMV had reached 90% of peak and that other projects manage 50%." },
  { label: "confidently-worded non-answer", q: q("E13"), answer: "The record is unambiguous on this point and the decision was taken deliberately." },
  { label: "hedged wrong answer must not read as abstention", q: q("E02"), answer: "I can't be certain, but the figure was 96%." },
  { label: "trap answered confidently", q: q("E37"), answer: "He set the price at $44 per million tokens." },
  { label: "trap answered with a plausible invented value", q: q("E38"), answer: "He required an MTP acceptance rate of 85%." },
  { label: "live and superseded value stated together", q: q("E02"), answer: "He moved the number from 84% up to 96% over the run." },
  { label: "forbidden value is a list index, not its subject", q: q("E38"), answer: "Not on record. Nearby the log reads: 84 explainer terms, 3 crash fixes, 85 unmeasured claims, 4 errors.", expectVerdict: "correct" },
  { label: "same forbidden value attached to its subject", q: q("E38"), answer: "The acceptance rate came back at 85%." },
  { label: "forbidden value anchored a few tokens from its subject", q: q("E40"), answer: "Provenance 4eba13905, 55 tok/s, +46% on B200, Qwen3-32B." },
  { label: "question restated as the answer", q: q("E19"), answer: "Jish imposed a three-stage ordering on the evening of 14 August." },
  { label: "empty string", q: q("E14"), answer: "" },
  { label: "whitespace only", q: q("E14"), answer: "   \n\t  " },
  { label: "partial answer missing one required entry", q: q("E21"), answer: "He refused FA2 as the default and mandated FA4->MLA." },
  { label: "partial answer missing one required entry", q: q("E17"), answer: "He killed the viterbi box because it was wasting money." },
  { label: "topically adjacent but wrong utterance", q: q("E01"), answer: "He compared 640 tok/s against 40 tok/s." },
  { label: "off-by-one-order-of-magnitude number", q: q("E12"), answer: "He said he needed 1400 aggregate and rejected 140." },
  { label: "unit swapped", q: q("E26"), answer: "He set the threshold at 5 hours of code work." },
  { label: "plausible region invented for a trap", q: q("E39"), answer: "He required the boxes to run in us-east." },
  { label: "correct-shaped abstention on an answerable question", q: q("E14"), answer: "That is not on record.", expectVerdict: "abstained" },
];

let rejected = 0;
for (const a of SUITE) {
  const g = grade(a.q, a.answer);
  const want = a.expectVerdict ?? "wrong";
  if (g.verdict === want) rejected += 1;
  else failures.push(`adversarial: ${a.q.id} "${a.label}" graded ${g.verdict}, expected ${want}`);
}

// The one case that is asserted as a known limitation rather than a pass: token matching cannot see
// polarity, so a negated sentence carrying the right tokens scores correct. grade.md §7 records this.
const negation = grade(q("E08"), "He never said 90+ quality, 640 tok/s or that the model fits.");
notes.push(`known limitation, negated answer on E08 grades: ${negation.verdict} (documented in grade.md §7)`);
check(negation.verdict === "correct", "the documented negation limitation no longer reproduces; grade.md §7 needs updating");

// Positive controls: the grader must accept genuinely correct answers, or "rejects everything" is
// a trivially passing grader.
const CONTROLS: { q: Question; answer: string }[] = [
  { q: q("E01"), answer: "He said: you said 600 tok/s how is now that 40?" },
  { q: q("E12"), answer: "He needed 14k aggregate and was rejecting 1400." },
  { q: q("E35"), answer: "Batch 256, a 2000 word essay, then 200 other users alongside." },
  { q: q("E10"), answer: "TTFT no longer than 1s." },
  { q: q("E33"), answer: "Three agents died overnight." },
  { q: q("E37"), answer: "Not on record — Jish never set a price." },
  { q: q("E04"), answer: "1006 aggregate, 25x off sglang, and 14.58 tok/s single user." },
  { q: q("E28"), answer: "A bake must finish inside 60 minutes on a single card." },
];
let controlsPassed = 0;
for (const c of CONTROLS) {
  const g = grade(c.q, c.answer);
  if (g.verdict === "correct") controlsPassed += 1;
  else failures.push(`positive control: ${c.q.id} graded ${g.verdict} on a correct answer (missing ${JSON.stringify(g.missing)})`);
}
check(isAbstention("Not on record.", q("E37")), "abstention detector missed a plain refusal");
check(!isAbstention("I can't say for certain, but it was 84%.", q("E02")), "abstention detector swallowed a hedged answer");

// ------------------------------------------------------------------ report

const dist = (key: "kind" | "difficulty"): string =>
  Object.entries(QS.reduce<Record<string, number>>((a, x) => { a[x[key]] = (a[x[key]] ?? 0) + 1; return a; }, {}))
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");

console.log("\n=== episode benchmark verification ===");
for (const n of notes) console.log(`  ${n}`);
console.log(`  kinds: ${dist("kind")}`);
console.log(`  difficulty: ${dist("difficulty")}`);
console.log(`  quotes checked: ${QS.reduce((n, x) => n + 1 + (x.source.also?.length ?? 0), 0)}, failed: ${quoteFailures}`);
console.log(`  adversarial suite: ${SUITE.length} cases, ${rejected} rejected as required`);
console.log(`  positive controls: ${CONTROLS.length} cases, ${controlsPassed} accepted`);

if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("\nall checks pass\n");
}
