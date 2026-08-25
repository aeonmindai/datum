/**
 * The grader. Implements `grade.md` §2–§5 and nothing else; that file is the authority and this one
 * is required to be a faithful transcription of it. No model is involved at any point.
 *
 * `verify.mts` attacks this file with hand-written wrong answers before any arm is scored.
 */

export type Verdict = "correct" | "wrong" | "abstained";

export interface Question {
  id: string;
  question: string;
  expect: string[];
  forbid: string[];
  kind: "decision" | "correction" | "preference" | "target-change" | "abandoned" | "who-said" | "when";
  difficulty: "easy" | "medium" | "hard";
  abstain?: boolean;
  /** Required when a `forbid` entry is all-numeric: the subject that anchors it. grade.md §5. */
  forbid_subject?: string[];
  spans_utterances?: boolean;
  source: {
    file: string;
    line: number;
    session: string;
    ts: string;
    quote: string;
    only_in_transcript?: boolean;
    also?: { file: string; line: number; quote: string }[];
    /** For traps: probes asserted to match zero human utterances. */
    absent_probes?: string[];
  };
}

/**
 * Unit aliases, longest first so the alternation never settles for a prefix. Folding happens only
 * where a unit is glued or spaced onto a *number*, which is the only place it can change a verdict:
 * `1s`, `1 sec` and `1 second` must all satisfy the entry `1 second`. Doing it number-adjacently is
 * what makes a bare `s` and a bare `h` safe to accept — outside that position they are just letters,
 * and `tokens / s / user` keeps its `s`.
 */
const UNIT_ALIAS: Record<string, string> = {
  "tok/sec": "tok/s", "tokens/s": "tok/s", "tok/s": "tok/s", "t/s": "tok/s", tps: "tok/s",
  milliseconds: "ms", millisecond: "ms", ms: "ms",
  seconds: "second", second: "second", secs: "second", sec: "second", s: "second",
  minutes: "minute", minute: "minute", mins: "minute", min: "minute",
  hours: "hour", hour: "hour", hrs: "hour", hr: "hour", h: "hour",
  gigabytes: "gb", gigabyte: "gb", gib: "gb", gb: "gb",
  percent: "%", pct: "%", "%": "%",
};
const UNIT_RE = new RegExp(
  `(\\d)\\s*(${Object.keys(UNIT_ALIAS).sort((a, b) => b.length - a.length)
    .map((u) => u.replace(/[/%]/g, (c) => `\\${c}`)).join("|")})\\b`, "g");

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
};

/** grade.md §2. */
export function norm(input: string): string {
  let s = input.normalize("NFKC").toLowerCase();
  s = s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-").replace(/\u00d7/g, "x");
  s = s.replace(/[$\u00a3\u20ac]/g, "");
  // Repeat: 1,234,567 needs more than one pass.
  for (let i = 0; i < 4; i += 1) s = s.replace(/(\d),(\d{3})(?![\d])/g, "$1$2");
  // A bare number with a k suffix. `14k` -> `14000`, and only when nothing alphanumeric follows.
  s = s.replace(/\b(\d+(?:\.\d+)?)k\b/g, (_m, n: string) => String(Number(n) * 1000));
  s = s.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g,
    (m) => NUMBER_WORDS[m] ?? m);
  // A multiplier glued to its number: `25x` -> `25 x`. `8x8` is left alone, there is no boundary.
  s = s.replace(/(\d)x\b/g, "$1 x");
  // Fold a unit onto its number and canonicalise it in one pass, so `30s`, `30 sec` and
  // `30 seconds` all become `30 second`.
  s = s.replace(UNIT_RE, (_m, d: string, u: string) => `${d} ${UNIT_ALIAS[u] ?? u}`);
  s = s.replace(/%/g, " % ");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * grade.md §3. `-` and `+` are separators, not token characters: the corpus writes `10–30` and
 * `90+`, and a numeric expect entry must reach the `10`, the `30` and the `90` inside them. `.`,
 * `/` and `=` are kept because they are load-bearing *inside* a token — `13.26`, `tok/s`, `v=4` —
 * and then trimmed from the ends, so a sentence-final `640.` is still the number 640.
 */
export function tokens(input: string): string[] {
  return norm(input)
    .split(/[^a-z0-9./%=]+/)
    .map((t) => t.replace(/^[./=]+/, "").replace(/[./=]+$/, ""))
    .filter((t) => t.length > 0);
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

function numEq(a: string, b: string): boolean {
  return Number(a) === Number(b);
}

/** A response token satisfies an expect token. grade.md §3. */
function tokenSatisfies(resp: string, want: string): boolean {
  const wantNum = NUMERIC.test(want);
  const respNum = NUMERIC.test(resp);
  if (wantNum || respNum) return wantNum && respNum && numEq(resp, want);
  return resp.startsWith(want);
}

/** Every start index at which an entry's token run occurs. grade.md §3. */
function matchPositions(have: string[], entry: string): number[] {
  const want = tokens(entry);
  const at: number[] = [];
  if (want.length === 0) return at;
  outer: for (let i = 0; i + want.length <= have.length; i += 1) {
    for (let j = 0; j < want.length; j += 1) {
      if (!tokenSatisfies(have[i + j]!, want[j]!)) continue outer;
    }
    at.push(i);
  }
  return at;
}

/** One `expect`/`forbid` entry against a response: contiguous token subsequence. */
export function entryHits(response: string, entry: string): boolean {
  return matchPositions(tokens(response), entry).length > 0;
}

export function expectSatisfied(response: string, expect: string[]): boolean {
  return expect.every((e) => entryHits(response, e));
}

/** grade.md §5. How far from a bare number its subject may sit and still anchor it. */
export const ANCHOR_WINDOW = 12;

/**
 * grade.md §5, anchored `forbid`.
 *
 * An entry made only of numeric tokens carries no subject of its own, so a bare match proves
 * nothing: measured over this corpus the unanchored rule scored `44` in "est bake 44 layers" as an
 * OpenRouter price and `85` in "85 unmeasured claims" as an MTP acceptance rate. Such an entry now
 * trips only with a `forbid_subject` token within `ANCHOR_WINDOW` tokens. Entries carrying a
 * non-numeric token — `us-east`, `$44 per million` — anchor themselves and are unchanged.
 */
export function forbidTrips(response: string, forbid: string[], subjects: string[] = []): boolean {
  const have = tokens(response);
  const subjectAt: number[] = [];
  if (subjects.length) {
    const wants = subjects.map((s) => tokens(s)).filter((t) => t.length > 0);
    for (let i = 0; i < have.length; i += 1) {
      if (wants.some((w) => w.every((t, j) => have[i + j] !== undefined && tokenSatisfies(have[i + j]!, t)))) {
        subjectAt.push(i);
      }
    }
  }
  for (const entry of forbid) {
    const want = tokens(entry);
    if (want.length === 0) continue;
    const positions = matchPositions(have, entry);
    if (positions.length === 0) continue;
    // Anchoring applies only where a subject was declared. Without one an all-numeric entry keeps
    // the unanchored §3 behaviour, which is correct for an answerable question: its `forbid` is only
    // ever applied to a one-sentence assertion (grade.md §8), never to a retrieved context, so a
    // bare number in it is an answer attempt rather than a passing digit. Traps are the case that
    // needs anchoring and `verify.mts` requires them to declare it.
    const floats = want.every((t) => NUMERIC.test(t)) && subjects.length > 0;
    if (!floats) return true;
    const end = want.length - 1;
    if (positions.some((p) => subjectAt.some((s) => s >= p - ANCHOR_WINDOW && s <= p + end + ANCHOR_WINDOW))) {
      return true;
    }
  }
  return false;
}

const ABSTAIN_RE = new RegExp(
  [
    "not on record", "no record", "not recorded", "nothing on record", "not stated",
    "never stated", "no evidence",
    "not in the (transcript|corpus|record|episodes)",
    "insufficient (evidence|information)",
    "(can not|cannot|can't|unable to) (say|tell|determine|answer|find)",
    "(do not|don't|dont) know",
    "abstain",
  ].join("|"),
);

/** grade.md §4. An abstention is a refusal that smuggles in no candidate value. */
export function isAbstention(response: string, q: Question): boolean {
  if (!ABSTAIN_RE.test(norm(response))) return false;
  // Clause 2, grade.md §4: a refusal that smuggles in a candidate value is an answer, not a refusal.
  // It reuses the *same* matchers as scoring rather than a loose numeric scan, so it inherits the
  // §5 anchoring. A loose scan disqualified "Not on record. ... 85 unmeasured claims ..." because a
  // list index happened to equal a forbidden value, which is the very confusion §5 exists to end.
  if (q.expect.length > 0 && q.expect.some((e) => entryHits(response, e))) return false;
  return !forbidTrips(response, q.forbid, q.forbid_subject ?? []);
}

export interface Graded {
  verdict: Verdict;
  /** Set when a `forbid` entry hit, whatever the verdict. Reported as contamination in evidence mode. */
  contaminated: boolean;
  missing: string[];
}

/**
 * grade.md §5 and §8.
 *
 * `mode` is not a convenience flag, it is which of two different things is being graded.
 *
 * In `llm` mode a system has *asserted* something, so `forbid` is fatal on an answerable question
 * and a trap is won by refusing.
 *
 * In `evidence` mode the response is the retrieved context and nobody has asserted anything yet, so
 * a stale value alongside the live one is contamination rather than a false claim — and a trap is
 * won by *not surfacing* the tempting value, because a retrieved context is a pile of records and
 * can never be a refusal. Grading a trap by looking for a refusal in evidence mode makes all four
 * traps unwinnable for every arm, which is a property of the grader and not a fact about any system.
 * That is exactly the bug this signature exists to prevent.
 */
export function grade(q: Question, response: string, mode: "evidence" | "llm" = "llm"): Graded {
  const contaminated = forbidTrips(response, q.forbid, q.forbid_subject ?? []);
  if (q.abstain) {
    const won = mode === "llm" ? isAbstention(response, q) : !contaminated;
    return { verdict: won ? "correct" : "wrong", contaminated, missing: [] };
  }
  const missing = q.expect.filter((e) => !entryHits(response, e));
  if (mode === "llm" && contaminated) return { verdict: "wrong", contaminated, missing };
  if (missing.length === 0) return { verdict: "correct", contaminated, missing };
  // A retrieved context is never a refusal, so evidence mode must not look for one here either. It
  // found them: `abstain` fired on Jish's own "I don't know what the fuck you're talking about"
  // sitting in an otherwise irrelevant retrieved record, and credited the arm with a refusal it
  // never made. Every such row had non-zero units. In evidence mode the only abstention is an empty
  // result, which the runner assigns.
  if (mode === "llm" && isAbstention(response, q)) return { verdict: "abstained", contaminated, missing };
  return { verdict: "wrong", contaminated, missing };
}
