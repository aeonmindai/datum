import { loadSource, walk } from "./source.js";
import type { DoctrineStrength, RuleCandidate, UnenforcedFinding } from "./types.js";

/**
 * Unenforced doctrine: rules a human wrote down that no machine checks.
 *
 * This is the by-product the design doc singles out, and it is deliberately a *report*, not
 * assertions. Deciding that an imperative sentence in a document is a real org rule is a human's
 * call; an extractor that promoted its own readings into the record is the exact failure that
 * produced 808 copies of one hallucinated preference in the mem0 audit. So findings go to the
 * proposal queue, and never to `assertions`.
 *
 * Three design choices carry most of the accuracy:
 *
 * 1. **Sentences, not lines.** Doctrine is hard-wrapped at 80 columns, so `**W=256 or no bake.**`
 *    is split across two physical lines. A line-based scan structurally cannot see it. Blocks are
 *    unwrapped, split into sentences, and each sentence is mapped back to the line its first
 *    character sits on.
 * 2. **Mention is not enforcement.** The cross-check runs against the text of what was *derived as
 *    an enforcer*, not against every config file. `cudnn` appears in ten `Cargo.toml` files as an
 *    optional feature — that is availability, the opposite of a ban, and a raw grep would read it
 *    as the ban being enforced.
 * 3. **Retracted doctrine is skipped.** A corpus that marks corrections in place (Arc has 449 such
 *    markers) will otherwise have its superseded rules reported as live unenforced ones, which is
 *    the same "most emphatic match wins" failure the store was built to avoid.
 */

/**
 * Ranked. `absolute` is what a reader needs to see first: a "never" that nothing enforces is a hard
 * constraint rotting quietly, while an unenforced "must" is often just a preference.
 */
const MARKERS: ReadonlyArray<{ pattern: RegExp; strength: DoctrineStrength }> = [
  { pattern: /\bunder no circumstances\b/i, strength: "absolute" },
  { pattern: /\bno exceptions?\b/i, strength: "absolute" },
  { pattern: /\bnon-negotiable\b/i, strength: "absolute" },
  { pattern: /\bnever\b/i, strength: "absolute" },
  { pattern: /\bforbidden\b|\bforbid(s|den)?\b/i, strength: "absolute" },
  { pattern: /\bbanned\b|\bis a ban\b|\bban(s)? (this|that|it)\b/i, strength: "absolute" },
  { pattern: /\bprohibited\b/i, strength: "absolute" },
  { pattern: /\bmust not\b|\bmustn't\b|\bshall not\b|\bshan't\b/i, strength: "absolute" },
  { pattern: /\bmay not\b|\bcannot\b|\bcan not\b/i, strength: "prohibition" },
  { pattern: /\bdo not\b|\bdon't\b/i, strength: "prohibition" },
  // `NO DEGRADED ARTIFACTS`, `W=256 or no bake` — an emphasised or shouted negation is how a hard
  // ban is actually written in these documents, and none of the keyword forms above catch it.
  { pattern: /\bNO\s+[A-Z][A-Z-]+/, strength: "prohibition" },
  { pattern: /\*\*[^*]*\bor no\s+\w+[^*]*\*\*/i, strength: "prohibition" },
  { pattern: /\bmust\b|\brequired\b|\bmandatory\b/i, strength: "obligation" },
  { pattern: /\balways\b/i, strength: "obligation" },
];

/**
 * A sentence carrying one of these is not live doctrine, whatever its imperative says. Arc corrects
 * in place, so the corpus is full of rules whose text still shouts while the decision has moved.
 */
const RETRACTED =
  /(~~|\bRETRACTED\b|\bSUPERSEDED\b|\bsuperseded by\b|\bno longer\b|\bwas wrong\b|\bthis reverses\b|\breversed\b|\bcorrected in\b|\bwithdrawn\b|❌|⛔ ?RETRACT)/i;

/**
 * A "never" that reports history is not a rule. `has never been deployed`, `was never measured
 * directly`, `had never run on CUDA` are all findings about the past, and admitting them buries the
 * actual bans under narrative. This is the single biggest precision lever in the scan: on Arc it is
 * the difference between a report whose head is doctrine and one whose head is a changelog.
 */
const DESCRIPTIVE: readonly RegExp[] = [
  /\b(has|have|had|was|were|been|being)\s+(\w+\s+)?never\b/i,
  /\bnever\s+(been|ran|run|reported|measured|deployed|existed|happened|worked|tested|shipped|landed|printed|scanned|merged|reproduced|observed|attempted|arrived|returned|fired)\b/i,
  /\b(is|are|it|that|which|this)\s+never\s+(been|a|an|the)\b/i,
  // "do not always transfer", "ratios do not always hold" — a hedge, not an obligation.
  /\bnot always\b/i,
  // "must have been", "must be why" — epistemic inference rather than obligation.
  /\bmust\s+(have|be\s+(why|because|the reason))\b/i,
];

/**
 * Signals that a document presents itself as rules. Used only to rank: an unenforced "never" inside
 * `DOCTRINE.md` under "Hard invariants" deserves the top of the report, while the same sentence in a
 * session log usually does not. Dropping the latter would be a judgement the scanner has no standing
 * to make, so it is ranked down rather than hidden.
 */
const DOCTRINAL_FILE = /doctrine|rules?|protocol|polic|invariant|convention|standard|guideline|contributing|agents|discipline|access_rule/i;
const DOCTRINAL_HEADING = /doctrine|\brule/i;
const DOCTRINAL_HEADING_STRONG = /invariant|non-negotiable|must|never|ban|forbid|prohibit|discipline|hard\b|policy|regression/i;
/** `NO DEGRADED ARTIFACTS` — the shouted-negation heading, same idiom the sentence markers catch. */
const DOCTRINAL_HEADING_SHOUT = /\bNO\s+[A-Z][A-Z]/;

/**
 * A sentence that names a mechanism: a backticked span, a CLI flag, an `UPPER_SNAKE` identifier or a
 * `key=value`. A rule that names one is checkable; one that does not is a sentiment, and ranking the
 * two the same is what makes a doctrine report unreadable.
 */
const NAMES_A_MECHANISM =
  /`[^`]{2,60}`|(?<![\w-])--[A-Za-z][\w-]{2,40}|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[A-Za-z]\w*\s*=\s*\d/;

/** Connectives that mark a sentence as explaining a rule rather than being one. */
const EXPLANATORY = /\b(because|so that|which is why|the reason|for days|i\.e\.|e\.g\.|turns out)\b/i;

/**
 * Words too generic to be the object of a rule.
 *
 * The imperative vocabulary itself is in here, and that matters: without it `GREEDY IS BANNED`
 * resolves its target to `banned` — the marker — instead of `greedy`, and then cross-checks the
 * enforcement corpus for the word "banned", which answers nothing about greedy.
 */
const STOPWORDS: Record<string, true> = {
  never: true, always: true, must: true, should: true, this: true, that: true, with: true,
  from: true, they: true, them: true, then: true, than: true, when: true, what: true, which: true,
  will: true, would: true, could: true, been: true, being: true, have: true, does: true, into: true,
  every: true, each: true, only: true, ever: true, also: true, more: true, most: true, less: true,
  because: true, before: true, after: true, above: true, below: true, here: true, there: true,
  thing: true, things: true, rule: true, rules: true, doctrine: true, note: true, notes: true,
  make: true, made: true, take: true, said: true, says: true, real: true, same: true, other: true,
  work: true, works: true, used: true, using: true, like: true, just: true, even: true, both: true,
  under: true, over: true, without: true, within: true, whole: true, still: true, again: true,
  banned: true, forbidden: true, prohibited: true, mandatory: true, required: true, forever: true,
  absolute: true, absolutely: true, exception: true, exceptions: true, violating: true,
  negotiable: true, regression: true, invariant: true, invariants: true, policy: true,
};

export interface DoctrineScanOptions {
  dir: string;
  /**
   * Directories to scan, repo-relative. Restricted on purpose: a doctrine report is only useful if
   * it covers the org's own documents, and vendored docs bury it.
   */
  roots?: readonly string[];
  /** Extra individual files to include even if outside `roots`. */
  files?: readonly string[];
  /** Cap on findings returned, strongest first. */
  limit?: number;
}

export interface DoctrineScan {
  findings: UnenforcedFinding[];
  /** Every document actually read. */
  sources: string[];
  /** Imperative sentences that were checked and found to be enforced. Reported as a count only. */
  enforcedCount: number;
  /** Sentences skipped for carrying a retraction marker. */
  retractedCount: number;
}

const DEFAULT_ROOTS = ["docs", "memory", "doc", ".github"] as const;
const DEFAULT_FILES = ["README.md", "CONTRIBUTING.md", "AGENTS.md", "CODE_OF_CONDUCT.md", "SECURITY.md"] as const;

/**
 * Cross-check imperative prose against what actually enforces things.
 *
 * `enforcers` is the derived rule set: subjects, claims and the verbatim enforcing line. Building the
 * corpus from *derived enforcement* rather than from raw config text is what stops a Cargo feature
 * declaration from reading as a ban on the thing it enables.
 */
export function scanDoctrine(
  opts: DoctrineScanOptions,
  enforcers: readonly RuleCandidate[],
): DoctrineScan {
  const corpus = buildCorpus(enforcers);
  const found = new Map<string, UnenforcedFinding>();
  const sources: string[] = [];
  let enforcedCount = 0;
  let retractedCount = 0;

  const roots = opts.roots ?? DEFAULT_ROOTS;
  const docs = new Set<string>();
  for (const root of roots) for (const rel of walk(opts.dir, { only: [root], extensions: [".md"] })) docs.add(rel);
  for (const rel of opts.files ?? DEFAULT_FILES) docs.add(rel);

  for (const rel of [...docs].sort()) {
    const file = loadSource(opts.dir, rel);
    if (!file) continue;
    sources.push(rel);
    const fileSignal = DOCTRINAL_FILE.test(rel) ? 3 : 0;

    for (const block of blocksOf(file.lines)) {
      const headingSignal = block.heading
        ? (DOCTRINAL_HEADING.test(block.heading) ? 2 : 0) +
          (DOCTRINAL_HEADING_STRONG.test(block.heading) ? 2 : 0) +
          (DOCTRINAL_HEADING_SHOUT.test(block.heading) ? 2 : 0)
        : 0;

      for (const sentence of sentencesOf(block)) {
        const marker = markerFor(sentence.text);
        if (!marker) continue;
        if (RETRACTED.test(sentence.text) || (block.heading && RETRACTED.test(block.heading))) {
          retractedCount++;
          continue;
        }
        if (DESCRIPTIVE.some((pattern) => pattern.test(sentence.text))) continue;

        const tokens = distinctiveTokens(sentence.text);
        // With no distinctive token there is nothing to look up, so "unenforced" would be an
        // assertion about our own ignorance rather than about the repo. Say nothing.
        if (tokens.length === 0) continue;
        const target = targetToken(sentence.text, marker.marker, tokens);
        if (corpus.has(target)) {
          enforcedCount++;
          continue;
        }

        const statement =
          sentence.text.length > 400 ? `${sentence.text.slice(0, 397)}...` : sentence.text;
        const source = `${rel}:${sentence.line}`;
        // The same rule is often written in several documents. Collapsing on the statement turns
        // six copies into one finding that says it is written in six places, which is both less
        // noise and a more damning fact than any single citation.
        const key = statement.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const existing = found.get(key);
        if (existing) {
          existing.also_at.push(source);
          continue;
        }
        found.set(key, {
          statement,
          source,
          file: rel,
          line: sentence.line,
          heading: block.heading,
          strength: marker.strength,
          marker: marker.marker,
          target,
          tokens,
          doctrinal:
            fileSignal +
            headingSignal +
            // A rule that names a mechanism is checkable; one that does not is a sentiment.
            (NAMES_A_MECHANISM.test(sentence.text) ? 2 : 0) +
            (statement.length <= 120 ? 2 : statement.length <= 200 ? 1 : 0) +
            // An explanation of a rule is not the rule, and it is the paragraph that a
            // heading-weighted score would otherwise float above the one-line ban above it.
            (EXPLANATORY.test(sentence.text) ? -2 : 0),
          also_at: [],
          why: `nothing that fails a build, a job or a merge mentions \`${target}\``,
        });
      }
    }
  }

  // Ranked by signal first, not by strength. A crisp `**W=256 or no bake.**` under a shouted heading
  // is more useful to a reader than a paragraph that happens to contain the word "never", and
  // strength alone cannot tell those apart.
  const rank: Record<DoctrineStrength, number> = { absolute: 0, prohibition: 1, obligation: 2 };
  const findings = [...found.values()].sort(
    (a, b) =>
      b.doctrinal - a.doctrinal ||
      rank[a.strength] - rank[b.strength] ||
      b.also_at.length - a.also_at.length ||
      a.source.localeCompare(b.source),
  );
  return {
    findings: opts.limit ? findings.slice(0, opts.limit) : findings,
    sources,
    enforcedCount,
    retractedCount,
  };
}

/**
 * The token the imperative is about: the distinctive token nearest the marker, preferring one that
 * follows it.
 *
 * Prohibitions put their object after the verb — "never `cudnn`", "do not add the `cudnn` feature",
 * "W=256 or no bake" — so proximity to the marker is a good proxy for "the thing being regulated",
 * and it is the fix for the failure that motivated this function: a sentence reading
 * ``Build `--features "cuda flash-attn"`; never `cudnn` `` shares the token `cuda` with the CI build
 * command, so checking "does any token appear in the enforcement corpus" declared the cudnn ban
 * enforced by the very command that builds without it.
 */
function targetToken(sentence: string, marker: string, tokens: readonly string[]): string {
  const lower = sentence.toLowerCase();
  const markerAt = lower.indexOf(marker.toLowerCase());
  if (markerAt < 0) return tokens[0]!;
  let best = tokens[0]!;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const token of tokens) {
    const at = lower.indexOf(token);
    if (at < 0) continue;
    // A token before the marker is still admissible ("`greedy` is banned") but costs double, so a
    // following object wins whenever there is one.
    const cost = at >= markerAt ? at - markerAt : (markerAt - at) * 2;
    if (cost < bestCost) {
      bestCost = cost;
      best = token;
    }
  }
  return best;
}

/**
 * Lowercased distinctive tokens drawn from everything a derived rule says about itself, plus the
 * verbatim line that enforces it. Membership in this set is what "something enforces this" means.
 */
function buildCorpus(enforcers: readonly RuleCandidate[]): Set<string> {
  const corpus = new Set<string>();
  for (const rule of enforcers) {
    // A non-binding rule enforces nothing by definition, so it must not absolve doctrine. This is
    // the difference between "we have a config for it" and "violating it fails something".
    if (!rule.binding) continue;
    const text = `${rule.subject} ${rule.claim} ${rule.enforcerText} ${JSON.stringify(rule.object)}`;
    for (const token of tokenise(text)) corpus.add(token);
  }
  return corpus;
}

function tokenise(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^A-Za-z0-9_:=.+-]+/)) {
    if (raw.length < 3) continue;
    // Split compound identifiers too, so `mistralrs-core/cudnn` contributes `cudnn`.
    out.push(raw);
    for (const part of raw.split(/[/:=.\-_+]+/)) if (part.length >= 3) out.push(part);
  }
  return out;
}

interface Block {
  /** Nearest enclosing markdown heading text, without the leading `#`s. */
  heading: string | null;
  /** Unwrapped text of one paragraph, list item or heading. */
  text: string;
  /** 1-based line of each character in `text`, same length. */
  lineOf: number[];
}

/**
 * Split a markdown document into blocks, unwrapping hard-wrapped lines.
 *
 * Fenced code is dropped: a `never` inside an example is not doctrine, it is a demonstration. Tables
 * are dropped for the same reason — a cell is a data point, not a rule.
 */
function blocksOf(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];
  let bufferLines: number[] = [];
  let fenced = false;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const text = buffer.join("");
    const lineOf = bufferLines;
    buffer = [];
    bufferLines = [];
    if (text.trim().length > 0) blocks.push({ heading, text, lineOf });
  };

  for (const [index, raw] of lines.entries()) {
    const lineNo = index + 1;
    if (/^\s*(```|~~~)/.test(raw)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      flush();
      continue;
    }
    const head = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (head) {
      flush();
      heading = head[1]!.replace(/[*`]/g, "").trim();
      // The heading itself is a block: `## D4. GREEDY IS BANNED — FOREVER.` is the rule.
      blocks.push({ heading, text: head[1]!, lineOf: new Array(head[1]!.length).fill(lineNo) });
      continue;
    }
    if (/^\s*\|/.test(raw)) {
      flush();
      continue;
    }
    // A new list item or a numbered item starts a new block; continuation lines join the current one.
    if (/^\s*(?:[-*+]\s|\d+[.)]\s)/.test(raw) && buffer.length > 0) flush();
    const piece = buffer.length === 0 ? trimmed : ` ${trimmed}`;
    buffer.push(piece);
    for (let i = 0; i < piece.length; i++) bufferLines.push(lineNo);
  }
  flush();
  return blocks;
}

interface Sentence {
  text: string;
  line: number;
}

/**
 * Split a block into sentences, keeping the line each one begins on.
 *
 * The boundary is a `.`, `!` or `?` followed by whitespace and something that starts a new sentence.
 * Deliberately conservative around `**bold.**`, `e.g.`, `W=256` and version numbers, because
 * splitting mid-claim would cite the wrong line and truncate the rule.
 */
function sentencesOf(block: Block): Sentence[] {
  const out: Sentence[] = [];
  const text = block.text;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    // Allow trailing emphasis and quoting to close before the boundary: `**... bake.**`
    let j = i + 1;
    while (j < text.length && (text[j] === "*" || text[j] === "`" || text[j] === '"' || text[j] === ")" || text[j] === "”")) {
      j++;
    }
    if (j >= text.length) break;
    if (text[j] !== " ") continue;
    // `e.g.`, `i.e.`, `vs.`, decimals and abbreviations: a boundary needs whitespace on both sides
    // of a real gap plus a capital or emphasis opener after it.
    const before = text.slice(Math.max(0, i - 4), i);
    if (/\b(e\.g|i\.e|vs|cf|etc|no|fig|approx|ca)$/i.test(before)) continue;
    if (/\d$/.test(before) && /^\s*\d/.test(text.slice(j))) continue;
    const rest = text.slice(j + 1);
    if (!/^[A-Z*`_'"(\u2014\u2018\u201C\u26A0\uD83D]/.test(rest) && !/^\d/.test(rest)) continue;
    push(out, block, text.slice(start, j), start);
    start = j + 1;
  }
  push(out, block, text.slice(start), start);
  return out;
}

function push(out: Sentence[], block: Block, raw: string, offset: number): void {
  const trimmed = raw.trim();
  if (trimmed.length < 8) return;
  const lead = raw.length - raw.trimStart().length;
  out.push({ text: trimmed, line: block.lineOf[offset + lead] ?? block.lineOf[offset] ?? 1 });
}

function markerFor(sentence: string): { marker: string; strength: DoctrineStrength } | null {
  for (const { pattern, strength } of MARKERS) {
    const match = pattern.exec(sentence);
    if (match) return { marker: match[0].trim(), strength };
  }
  return null;
}

/**
 * The tokens worth looking up: things that name a mechanism rather than describe one.
 *
 * A backticked span, a CLI flag, an `UPPER_SNAKE` identifier, a `key=value` and a path are all
 * strings that would literally appear in the config that enforced them. Bare prose words are
 * admitted only as a last resort and only when they are long and not stopwords, because "always
 * measure carefully" has nothing a grep could ever confirm.
 */
export function distinctiveTokens(sentence: string): string[] {
  const strong: string[] = [];
  for (const match of sentence.matchAll(/`([^`]{2,60})`/g)) {
    for (const piece of match[1]!.split(/[\s,"']+/)) {
      const token = piece.replace(/^[-]{0,2}/, "").replace(/[.,;:)]+$/, "");
      if (token.length >= 3) strong.push(token.toLowerCase());
    }
  }
  for (const match of sentence.matchAll(/(?<![\w-])--?([A-Za-z][\w-]{2,40})/g)) strong.push(match[1]!.toLowerCase());
  for (const match of sentence.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) strong.push(match[1]!.toLowerCase());
  for (const match of sentence.matchAll(/\b([A-Za-z]\w*)\s*=\s*(\d[\w.]*)/g)) {
    strong.push(`${match[1]!.toLowerCase()}=${match[2]!.toLowerCase()}`);
    strong.push(match[1]!.toLowerCase());
  }
  for (const match of sentence.matchAll(/\b([\w.-]+\/[\w./-]+\.[A-Za-z]{1,5})\b/g)) strong.push(match[1]!.toLowerCase());
  for (const match of sentence.matchAll(/\b(\w+::\w+)\b/g)) strong.push(match[1]!.toLowerCase());

  const unique = [...new Set(strong.filter((t) => !STOPWORDS[t]))];
  if (unique.length > 0) return unique.slice(0, 8);

  // Fallback: shouted words. `GREEDY IS BANNED` names its subject in caps and nothing else does.
  const shouted = [...sentence.matchAll(/\b([A-Z]{4,20})\b/g)]
    .map((m) => m[1]!.toLowerCase())
    .filter((t) => !STOPWORDS[t]);
  return [...new Set(shouted)].slice(0, 8);
}
