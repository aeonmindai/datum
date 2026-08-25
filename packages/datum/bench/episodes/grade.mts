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

/** One `expect`/`forbid` entry against a response: contiguous token subsequence. */
export function entryHits(response: string, entry: string): boolean {
  const want = tokens(entry);
  if (want.length === 0) return false;
  const have = tokens(response);
  outer: for (let i = 0; i + want.length <= have.length; i += 1) {
    for (let j = 0; j < want.length; j += 1) {
      if (!tokenSatisfies(have[i + j]!, want[j]!)) continue outer;
    }
    return true;
  }
  return false;
}

export function expectSatisfied(response: string, expect: string[]): boolean {
  return expect.every((e) => entryHits(response, e));
}

export function forbidTrips(response: string, forbid: string[]): boolean {
  return forbid.some((f) => entryHits(response, f));
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
  const n = norm(response);
  if (!ABSTAIN_RE.test(n)) return false;
  const respNums = new Set(tokens(response).filter((t) => NUMERIC.test(t)).map((t) => String(Number(t))));
  for (const entry of [...q.expect, ...q.forbid]) {
    for (const t of tokens(entry)) {
      if (NUMERIC.test(t) && respNums.has(String(Number(t)))) return false;
    }
  }
  return true;
}

export interface Graded {
  verdict: Verdict;
  /** Set when a `forbid` entry hit, whatever the verdict. Reported as contamination in evidence mode. */
  contaminated: boolean;
  missing: string[];
}

/**
 * grade.md §5. `applyForbid` false is evidence mode on an answerable question, where a stale value
 * in the retrieved context is contamination rather than a false assertion. Traps always apply it.
 */
export function grade(q: Question, response: string, applyForbid = true): Graded {
  const contaminated = forbidTrips(response, q.forbid);
  if (q.abstain) {
    const abstained = isAbstention(response, q);
    return { verdict: abstained ? "correct" : "wrong", contaminated, missing: [] };
  }
  const missing = q.expect.filter((e) => !entryHits(response, e));
  if (applyForbid && contaminated) return { verdict: "wrong", contaminated, missing };
  if (missing.length === 0) return { verdict: "correct", contaminated, missing };
  if (isAbstention(response, q)) return { verdict: "abstained", contaminated, missing };
  return { verdict: "wrong", contaminated, missing };
}
