import type { Db, DbRole } from "../db/pool.js";
import { newId } from "../domain/identity.js";
import { collectProseFiles, fileLabel, readProseFiles } from "./walk.js";

/**
 * Subsystem 4: prose to proposals.
 *
 * ## The rule this file exists to obey
 *
 * Prose may never become an assertion by machine. It may only become a *candidate*, in
 * `datum.proposals`, which a human promotes. Migration 009 explains the quarantine; this is the
 * only writer.
 *
 * ## The loop that must not form
 *
 * A customer audit of 10,134 mem0 production entries found 97.8% junk, including **808 copies of
 * one hallucinated preference**. It got there because the extractor read the memory it had itself
 * written: recall fed re-extraction, and each pass laundered the previous pass's mistake into
 * fresh "evidence". So the invariant here is not "be careful", it is structural:
 *
 * > **The extraction path issues no SELECT against `datum.proposals` or `datum.assertions`.**
 *
 * Read this file and check it. `extractProposals` takes a `Db` solely to INSERT. It decides what
 * to extract from the bytes of the corpus and nothing else — extraction is a pure function of the
 * prose, so the same corpus yields the same candidates whether the store is empty or full. There
 * is no query to remove later, no filter to forget, and no feedback edge for a mistake to travel
 * along. Duplicate suppression is the database's `proposal_identity` unique constraint, not a
 * lookup, which is the same guarantee arrived at without reading anything back.
 *
 * ## Why the patterns are deliberately stingy
 *
 * No LLM, no heuristic prose understanding. Three narrow families, each requiring the *whole*
 * matched region to be a self-contained measurement or definition. The reason is economic:
 * review is the bottleneck, so a low-yield extractor whose proposals are usually right is worth
 * far more than a high-yield one nobody trusts. Twenty candidates a reviewer accepts beats two
 * hundred they stop reading at fifteen.
 */

/** The identity this module writes under. Part of `proposal_identity`, so it is a version. */
export const PROSE_EXTRACTOR = "prose/patterns@1";

export const PROPOSAL_STATUSES = ["pending", "accepted", "rejected", "superseded"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Which pattern produced a candidate. Recorded in the citation so review can triage by family. */
export type ProseFamily = "kv-numeric" | "is-measurement" | "definition";

export interface ProposalCitation {
  /** `path:line`. The database refuses a proposal whose `source` is empty. */
  source: string;
  /** The line as it reads in the file, so a reviewer can confirm without opening it. */
  excerpt: string;
  family: ProseFamily;
  /** Nearest enclosing markdown heading, which is usually what gives the subject its referent. */
  heading: string | null;
}

export interface ProposalCandidate {
  scope: string;
  subject: string;
  predicate: string;
  object: unknown;
  claim: string;
  kind: string;
  citation: ProposalCitation;
  extractor: string;
  /**
   * A review-ordering hint and nothing more. Deliberately not a probability and deliberately not
   * one of the four confidence classes — 009 keeps those words out of this table so that
   * promoting a row cannot promote a label along with it.
   */
  extractorConfidence: number;
}

export interface ExtractOptions {
  roots: string[];
  scope: string;
  extractor: string;
  limit?: number;
}

export interface ExtractResult {
  created: number;
  /** Candidates the `proposal_identity` constraint already covered, plus in-run duplicates. */
  skipped: number;
}

/**
 * 64 MiB. Extraction is a batch job, so the ceiling is about not being able to exhaust memory on
 * an unvetted repository rather than about latency.
 */
export const DEFAULT_EXTRACT_MAX_BYTES = 64 * 1024 * 1024;

/** Default cap on rows per run, so one command cannot flood a review queue nobody can drain. */
const DEFAULT_LIMIT = 1000;

const MAX_EXCERPT_CHARS = 300;
const MAX_SUBJECT_CHARS = 120;
const MAX_PREDICATE_CHARS = 60;

/**
 * The unit lexicon, and the predicate each unit implies.
 *
 * A closed lexicon rather than an open `[A-Za-z]+` charset is the single biggest precision lever
 * in the file: it is what stops `config 4×H200` and `at :875 and` from being read as
 * measurements. Ambiguous single letters are left out on purpose — `b` is bytes or batch size and
 * `c` is Celsius or a variable, and a wrong unit makes a wrong fact.
 */
const UNIT_PREDICATE: Record<string, string> = {
  byte: "size",
  bytes: "size",
  kb: "size",
  mb: "size",
  gb: "size",
  tb: "size",
  pb: "size",
  kib: "size",
  mib: "size",
  gib: "size",
  tib: "size",
  bit: "size",
  bits: "size",
  bpw: "bits_per_weight",
  ns: "duration",
  us: "duration",
  "µs": "duration",
  ms: "duration",
  s: "duration",
  sec: "duration",
  secs: "duration",
  seconds: "duration",
  min: "duration",
  mins: "duration",
  minutes: "duration",
  hr: "duration",
  hrs: "duration",
  hours: "duration",
  days: "duration",
  "%": "percentage",
  x: "factor",
  "×": "factor",
  "tok/s": "throughput",
  "tokens/s": "throughput",
  "req/s": "throughput",
  qps: "throughput",
  flops: "throughput",
  gflops: "throughput",
  tflops: "throughput",
  "gb/s": "bandwidth",
  "mb/s": "bandwidth",
  "tb/s": "bandwidth",
  w: "power",
  kw: "power",
  "°c": "temperature",
  gpu: "count",
  gpus: "count",
  cpu: "count",
  cpus: "count",
  core: "count",
  cores: "count",
  thread: "count",
  threads: "count",
  layer: "count",
  layers: "count",
  token: "count",
  tokens: "count",
  file: "count",
  files: "count",
  caller: "count",
  callers: "count",
};

/**
 * Words that, present anywhere on the line, disqualify it.
 *
 * This is not squeamishness, it is the corpus talking. Arc's `memory/DOCTRINE.md` retracts
 * numbers *in place*: the paragraph that claimed "2.6x at no quality cost" now reads
 * "2.1×, not 2.6×" and "**"No quality cost" is RETRACTED**", with the dead figures still on the
 * page. An extractor that lifts a retracted number and files it as a candidate does worse than
 * nothing, because it spends a reviewer's attention arguing with a claim the document already
 * withdrew.
 */
const DISQUALIFYING = [
  "retracted",
  "superseded",
  "fabricated",
  "obsolete",
  "deprecated",
  "no longer",
  "wrong",
  "never ran",
  "never verified",
  "not verified",
  "unverified",
  "estimate",
  "estimated",
  "guess",
  "assume",
  "assumed",
  "phantom",
  "todo",
  "fixme",
];

/**
 * Pronouns and bare determiners.
 *
 * Two jobs, both learned from what this extractor got wrong on Arc's corpus. As a whole subject
 * they name nothing — "Neither is a fix" is not a definition of "Neither". And at either *end* of
 * a multi-word span they are the tell that the sentence boundary was mis-segmented: "Note it is
 * 2× on the KERNEL" and "at our 2.09 bits it is 74 GB" both capture a fragment whose head is not
 * what the measurement is about.
 */
const PRONOUNS: Record<string, true> = {
  it: true,
  this: true,
  that: true,
  these: true,
  those: true,
  there: true,
  they: true,
  them: true,
  we: true,
  us: true,
  i: true,
  you: true,
  he: true,
  she: true,
  its: true,
  their: true,
  our: true,
  ours: true,
  theirs: true,
  mine: true,
  yours: true,
  his: true,
  hers: true,
  which: true,
  what: true,
  who: true,
  whose: true,
  neither: true,
  either: true,
  both: true,
  each: true,
  all: true,
  none: true,
  nothing: true,
  everything: true,
  anything: true,
  something: true,
};

/** Never a subject on their own, though fine as part of one ("one W4A16 quant"). */
const BARE_ONLY: Record<string, true> = {
  the: true,
  a: true,
  an: true,
  and: true,
  but: true,
  so: true,
  one: true,
  then: true,
  now: true,
  here: true,
  also: true,
  only: true,
  still: true,
};

/**
 * Words whose presence proves the captured span is a clause, not a subject.
 *
 * "nsys says qtip_gather_gemv_warp_kernel is 1090.5 ms" has a true measurement in it and a
 * useless subject: the fact is about the kernel, not about "nsys says qtip_...". Rather than try
 * to re-segment, the candidate is dropped. A reviewer who has to rewrite the subject is doing the
 * extractor's job, and a proposal that needs rewriting is worse than one that never appeared.
 */
const FRAGMENT_WORDS: Record<string, true> = {
  said: true,
  says: true,
  say: true,
  show: true,
  shows: true,
  showed: true,
  found: true,
  means: true,
  meant: true,
  gives: true,
  gave: true,
  took: true,
  takes: true,
  note: true,
  notes: true,
  claims: true,
  claimed: true,
  reports: true,
  reported: true,
  because: true,
  since: true,
  while: true,
  when: true,
  if: true,
  however: true,
  hence: true,
  thus: true,
  therefore: true,
  though: true,
  although: true,
  unless: true,
  until: true,
  whereas: true,
  supporting: true,
  per: true,
  via: true,
};

/** Keys that are document furniture rather than a predicate about anything. */
const EMPTY_PREDICATES: Record<string, true> = {
  note: true,
  notes: true,
  see: true,
  also: true,
  eg: true,
  ie: true,
  todo: true,
  warning: true,
  status: true,
  example: true,
  http: true,
  https: true,
  ref: true,
  refs: true,
};

// Longest first, so `tok/s` is not matched as `s` and `gib` is not matched as `bit`.
const UNIT_ALT = Object.keys(UNIT_PREDICATE)
  .sort((a, b) => b.length - a.length)
  .map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

/** Thousands separators are accepted because prose uses them; the commas are stripped on parse. */
const NUMBER = String.raw`[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?`;

/**
 * Family A. A key, a colon, and a value that is a bare measurement *and nothing else*.
 *
 * The `$` anchor is the whole guard. `Cost: 15m0s cold, in parallel with the nvcc jobs` has a
 * key and a colon and a number, and it is not a fact — it is the opening of a sentence. Requiring
 * the value to be consumed entirely by one number and at most one unit is what separates the two,
 * and it is why this family's yield is low and its precision is high.
 *
 * `/` is excluded from the key for one specific reason: without that, every `file.rs:1234` source
 * reference in the corpus reads as the key `path/to/file.rs` with the measurement `1234`. On Arc
 * that turned `cudarc-0.19.4/src/cublaslt/sys/mod.rs:747` into a proposal. A path is not a key.
 */
const KV_LINE = new RegExp(
  String.raw`^([A-Za-z][A-Za-z0-9_.+()-]*(?: [A-Za-z0-9_.+()-]+){0,4}) *: *(${NUMBER})(?: *(${UNIT_ALT}))? *$`,
  "i",
);

/**
 * Family B. "<subject> is <number> <unit>", anchored to a sentence boundary.
 *
 * Three guards carry this one. The negative lookahead forbids a copula *inside* the subject, so
 * "X is 5 GB and Y is 3 GB" cannot capture "X is 5 GB and Y" as the subject. The unit is
 * mandatory, because a bare number in prose is usually enumeration ("there are 3 reasons"). And
 * the trailing lookahead rejects a hyphen as well as a letter or digit, because `is 3 CPU-side +
 * 2 CUDA tests` is not a count of three CPUs — a unit that turns out to be the head of a
 * compound word was never a unit.
 */
const IS_MEASUREMENT = new RegExp(
  String.raw`(?:^|[.;!?]\s+)((?!(?:is|are|was|were)\b)[A-Za-z_"'][\w"'./:-]*(?:\s+(?!(?:is|are|was|were)\b)[\w"'./:%$-]+){0,4})\s+(?:is|are|was|were)\s+(?:now\s+|about\s+|approximately\s+|roughly\s+|~)?(${NUMBER})\s*(${UNIT_ALT})(?![A-Za-z0-9_/-])`,
  "gi",
);

/**
 * `4096 × 2 B = 8,192 B` is arithmetic, not a factor. A `×` or `x` followed by another number is
 * a multiplication sign, and reading it as "4096 times" produces a confident falsehood — the one
 * outcome this project exists to prevent.
 */
const MULTIPLICATION = /^\s*\d/;

/**
 * Family C. A one-word term, a copula, an article, and a definition that ends the line.
 *
 * Restricted to a single token, and then restricted again to a token that *looks like a term*:
 * it must carry a `_`, a `.`, a `/`, a `::`, interior capitalisation, or be an acronym. That
 * second restriction is not fastidiousness, it is measured. Without it, this family's entire
 * yield on Arc's `memory/` tree was fifteen candidates and roughly two real definitions —
 * "profile is the cheap precursor", "launches are the MoE router", "exclusion is a rule stated in
 * advance" all have a definition's shape and are mid-narrative prose. English "is a" is as often
 * rhetoric as definition, so the only reliable signal available without a parser is that the
 * thing being defined is spelled like a named thing.
 */
const DEFINITION = new RegExp(
  String.raw`^([A-Za-z_][\w./:-]{1,50})\s+(?:is|are)\s+(?:a|an|the)\s+([^.!?;:]{4,120})\.$`,
);

const TERM_LIKE = /[_./]|::|^[A-Z][a-z0-9]*[A-Z]|^[A-Z]{2,}$/;

const HEADING = /^ {0,3}(#{1,6})\s+(.+)$/;
const FENCE = /^\s*(?:```|~~~)/;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HORIZONTAL_RULE = /^\s*(?:[-*_]\s*){3,}$/;

/**
 * Strip markdown decoration so one regex family can read a heading, a list item and a bare
 * paragraph line identically. Emphasis, backticks and emoji carry no meaning for extraction and
 * every one of them left in place would need its own alternative in three regexes.
 */
function plainText(line: string): string {
  return line
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/[*`]/g, "")
    .replace(/__/g, "")
    .replace(LIST_MARKER, "")
    .replace(/^[^A-Za-z0-9_("'$]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanHeading(text: string): string {
  const stripped = plainText(text).replace(/[:\-—–\s]+$/, "");
  return stripped.slice(0, MAX_SUBJECT_CHARS);
}

function cleanSubject(text: string): string {
  return text
    .replace(/["'`]/g, "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SUBJECT_CHARS);
}

/**
 * The last gate before a candidate becomes a row.
 *
 * Every clause here was added because the extractor produced a specific bad proposal from Arc's
 * corpus, and the comments on `PRONOUNS` and `FRAGMENT_WORDS` name which one.
 */
function usable(subject: string, predicate: string): boolean {
  if (subject.length < 2) return false;
  if (/^[\d.,+-]+$/.test(subject)) return false;
  // A colon inside a subject means the span crossed a label boundary: "Supporting: the gather's
  // mma floor" is two things, and the measurement belongs to the second.
  if (subject.includes(":")) return false;
  // A full stop followed by a space means the span crossed a sentence boundary that the anchor
  // could not see, because `.` is a legal character inside a word ("temps fine. Floor",
  // "production toolchain. Production"). The head of such a span is the previous sentence's tail.
  if (subject.includes(". ")) return false;
  if (predicate.length < 2 || Object.hasOwn(EMPTY_PREDICATES, predicate)) return false;

  const words = subject.toLowerCase().split(" ");
  const first = words[0];
  const last = words[words.length - 1];
  if (!first || !last) return false;
  if (words.length === 1 && Object.hasOwn(BARE_ONLY, first)) return false;
  if (Object.hasOwn(PRONOUNS, first) || Object.hasOwn(PRONOUNS, last)) return false;
  return !words.some((word) => Object.hasOwn(FRAGMENT_WORDS, word));
}

interface ExtractableLine {
  /** 1-based, so it can go straight into a `path:line` citation. */
  line: number;
  /** Markdown decoration removed, whitespace collapsed. */
  text: string;
  heading: string | null;
}

/**
 * The lines a pattern is allowed to see.
 *
 * Everything skipped here is skipped because attributing a claim to it would be wrong, not
 * because it is inconvenient. Fenced and indented code is subsystem 1's input, where a parser
 * gives facts instead of guesses. A blockquote is usually a quotation from somewhere else, so
 * filing it under this document's heading would misattribute it. YAML frontmatter is document
 * metadata — `modified:` is a true statement about a file and worthless as organisational
 * knowledge, and it would fire family A on every document in the corpus. A table row needs its
 * header to mean anything, and a heading is a title rather than a claim.
 */
function* extractableLines(lines: readonly string[]): Generator<ExtractableLine> {
  let inFence = false;
  let inFrontmatter = false;
  let heading: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();

    if (i === 0 && trimmed === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (trimmed === "---" || trimmed === "...") inFrontmatter = false;
      continue;
    }
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (trimmed.length === 0) continue;

    const headingMatch = HEADING.exec(raw);
    if (headingMatch) {
      heading = cleanHeading(headingMatch[2] ?? "") || null;
      continue;
    }

    if (HORIZONTAL_RULE.test(raw)) continue;
    if (trimmed.startsWith(">")) continue;
    if (trimmed.startsWith("|")) continue;
    if (trimmed.startsWith("<")) continue;
    // Four-space indentation is a markdown code block unless it is a nested list item.
    if (/^ {4,}\S/.test(raw) && !LIST_MARKER.test(raw)) continue;

    const text = plainText(raw);
    if (text.length === 0) continue;
    yield { line: i + 1, text, heading };
  }
}

function disqualified(text: string): boolean {
  const lowered = text.toLowerCase();
  return DISQUALIFYING.some((marker) => lowered.includes(marker));
}

/**
 * Extraction confidences, as a table so the ordering is reviewable in one look.
 *
 * The ordering is an argument, not a measurement: a `key: value` line whose value is a number
 * with a unit is the least ambiguous form English offers, a mid-sentence "X is N unit" depends on
 * having segmented the subject correctly, a unitless key/value could be an enumeration, and an
 * "is a" definition is the most ambiguous of all because that construction is as often rhetoric
 * as it is a definition.
 */
const FAMILY_CONFIDENCE: Record<string, number> = {
  "kv-numeric-unit": 0.7,
  "kv-numeric-bare": 0.45,
  "is-measurement": 0.6,
  definition: 0.35,
};

/**
 * Run the three families over one document.
 *
 * Pure: input bytes in, candidates out. No database handle reaches this function, which is how
 * the "extraction never reads the record" rule is enforced rather than merely stated.
 */
export function extractFromDocument(
  path: string,
  lines: readonly string[],
  scope: string,
  extractor: string,
): ProposalCandidate[] {
  const label = fileLabel(path);
  const out: ProposalCandidate[] = [];

  for (const { line, text, heading } of extractableLines(lines)) {
    if (disqualified(text)) continue;
    const excerpt =
      text.length > MAX_EXCERPT_CHARS ? `${text.slice(0, MAX_EXCERPT_CHARS)}…` : text;
    const source = `${path}:${line}`;
    const base = { scope, extractor, claim: excerpt };

    const kv = KV_LINE.exec(text);
    if (kv) {
      const key = kv[1] ?? "";
      const value = kv[2] ?? "";
      const unit = kv[3] ?? null;
      const subject = cleanSubject(heading ?? label);
      const predicate = key
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, MAX_PREDICATE_CHARS)
        .replace(/_+$/, "");
      if (usable(subject, predicate)) {
        out.push({
          ...base,
          subject,
          predicate,
          object: {
            value: Number.parseFloat(value.replace(/,/g, "")),
            unit,
            text: unit ? `${value} ${unit}` : value,
          },
          kind: "measured",
          citation: { source, excerpt, family: "kv-numeric", heading },
          extractorConfidence:
            FAMILY_CONFIDENCE[unit ? "kv-numeric-unit" : "kv-numeric-bare"] ?? 0.4,
        });
      }
      // A line that is a key/value pair is not also a sentence, so the other families are
      // skipped rather than allowed to produce a second reading of the same characters.
      continue;
    }

    const definition = DEFINITION.exec(text);
    if (definition) {
      const term = definition[1] ?? "";
      const subject = cleanSubject(term);
      if (TERM_LIKE.test(term) && usable(subject, "is_defined_as")) {
        out.push({
          ...base,
          subject,
          predicate: "is_defined_as",
          object: { text: (definition[2] ?? "").trim() },
          kind: "state",
          citation: { source, excerpt, family: "definition", heading },
          extractorConfidence: FAMILY_CONFIDENCE["definition"] ?? 0.3,
        });
      }
      continue;
    }

    IS_MEASUREMENT.lastIndex = 0;
    for (let m = IS_MEASUREMENT.exec(text); m !== null; m = IS_MEASUREMENT.exec(text)) {
      const subject = cleanSubject(m[1] ?? "");
      const value = m[2] ?? "";
      const written = m[3] ?? "";
      const unit = written.toLowerCase();
      const predicate = UNIT_PREDICATE[unit] ?? null;
      if (!predicate || !usable(subject, predicate)) continue;
      if (predicate === "factor" && MULTIPLICATION.test(text.slice(m.index + m[0].length))) {
        continue;
      }
      out.push({
        ...base,
        subject,
        predicate,
        object: {
          value: Number.parseFloat(value.replace(/,/g, "")),
          unit,
          text: `${value} ${written}`,
        },
        kind: "measured",
        citation: { source, excerpt, family: "is-measurement", heading },
        extractorConfidence: FAMILY_CONFIDENCE["is-measurement"] ?? 0.5,
      });
    }
  }

  return out;
}

const INSERT_PROPOSAL = `
  INSERT INTO datum.proposals
    (id, scope, subject, predicate, object, claim, kind, citation, extractor,
     extractor_confidence, status)
  VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,'pending')`;

/**
 * Write candidates, skipping anything `proposal_identity` already covers.
 *
 * One statement per row, outside any transaction, and there are two reasons rather than one.
 *
 * The first is forced. `proposal_identity` is `DEFERRABLE INITIALLY IMMEDIATE`, and Postgres
 * refuses a deferrable constraint as an `ON CONFLICT` arbiter — verified, not assumed:
 * `ERROR: ON CONFLICT does not support deferrable unique constraints/exclusion constraints as
 * arbiters`. So the batch upsert this would obviously want does not exist, and catching 23505 is
 * the only way to express "skip the ones already on file".
 *
 * The second is that it is the better shape anyway. A unique violation aborts only its own
 * statement, so 999 good candidates are not lost to the 1000th duplicate, and the skip count is
 * exact rather than inferred — which matters, because "the extractor produced nothing new" and
 * "the extractor produced nothing" are different facts about a corpus and a reviewer draining a
 * queue needs to tell them apart.
 *
 * Shared with the rules subsystem, which files unenforced-doctrine findings the same way.
 */
export async function insertProposals(
  db: Db,
  candidates: readonly ProposalCandidate[],
  role: DbRole = "app",
): Promise<ExtractResult> {
  let created = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    try {
      await db.query(role, INSERT_PROPOSAL, [
        newId("prop"),
        candidate.scope,
        candidate.subject,
        candidate.predicate,
        JSON.stringify(candidate.object),
        candidate.claim,
        candidate.kind,
        JSON.stringify(candidate.citation),
        candidate.extractor,
        candidate.extractorConfidence,
      ]);
      created += 1;
    } catch (err) {
      const code = typeof err === "object" && err !== null && "code" in err ? err.code : null;
      // 23505 unique_violation: `proposal_identity` already covers this exact claim, which is
      // precisely the outcome a re-run should have.
      if (code !== "23505") throw err;
      skipped += 1;
    }
  }
  return { created, skipped };
}

/**
 * Read prose under `roots` and file candidates in `datum.proposals`.
 *
 * `db` is used for INSERT only. There is no SELECT anywhere on this path — see the header.
 */
export async function extractProposals(db: Db, opts: ExtractOptions): Promise<ExtractResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const files = await collectProseFiles(opts.roots, DEFAULT_EXTRACT_MAX_BYTES);
  const docs = await readProseFiles(files);

  const candidates: ProposalCandidate[] = [];
  // In-run duplicates are counted as skips rather than sent to the database, because
  // `proposal_identity` would refuse them anyway and the round trip buys nothing.
  const claimed = new Set<string>();
  let duplicates = 0;

  for (const doc of docs) {
    for (const candidate of extractFromDocument(doc.path, doc.lines, opts.scope, opts.extractor)) {
      const identity = `${candidate.scope}\u0000${candidate.subject}\u0000${candidate.predicate}`;
      if (claimed.has(identity)) {
        duplicates += 1;
        continue;
      }
      claimed.add(identity);
      candidates.push(candidate);
    }
  }

  // Documents arrive in sorted path order and lines in file order, so the cap keeps a stable
  // prefix: re-running with a larger limit adds candidates instead of replacing them.
  const result = await insertProposals(db, candidates.slice(0, limit));
  return { created: result.created, skipped: result.skipped + duplicates };
}
