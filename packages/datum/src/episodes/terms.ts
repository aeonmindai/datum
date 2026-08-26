/**
 * Folding a query term onto the words a person actually wrote.
 *
 * Two of the six held-out losses in `bench/episodes/RESULTS.md` §6 are not ranking failures and no
 * limit recovers them — both source utterances were measured ABSENT at limit 12, 40 and 100. They
 * are vocabulary, and nothing else:
 *
 *   asked:  "hours had been lost waiting on a login"   H08, `login` weighed at idf 7.295
 *   said:   "it took 15 mins plus I logged in"
 *
 *   asked:  "the batch-1 throughput figure"            H03, `batch-1` weighed at idf 7.295
 *   said:   "but we aren't 16.57 on b1?"
 *
 * Measured over the 542-episode store those two terms reach, and the two failures are not the same
 * failure. `batch-1` has df 0: `weighTerms` puts it in `useless` and the query proceeds on its
 * leftovers. `login` has df 1 — the 7.295 is real — and the single episode it lands on is the
 * session-handoff prompt, not the answer. So the rarest word in the question was not merely
 * unhelpful, it was confidently pointing at the wrong document.
 *
 * What each fold is worth, on that same corpus:
 *
 *   `b1`   df 1 at idf 7.295, and the one episode it matches IS the H03 source, verbatim. The
 *          abbreviation costs nothing: same rarity, right document.
 *   `log`  df 19 at idf 4.351, and those 19 include the H08 source. This one is a trade — 7.295
 *          on a wrong document for 4.351 on a set containing the right one. Reachable beats rare.
 *
 * Note what `log` costs: 4.351 is below `recall.ts`'s single-rare-term bar of 5.909, so a lone
 * stem match is deliberately not strong enough to be called evidence on its own. That is the fold
 * behaving correctly. It restores reachability and leaves the confidence judgement where it was.
 *
 * Every variant is offered ALONGSIDE the exact term and never instead of it. The exact term is the
 * only one whose rarity was earned by being written that way, so it stays first and stays whole.
 *
 * Why the fan-out is capped, and why an unbounded fold is worse than no fold at all: `recall.ts`
 * counts distinct matched terms per episode and treats two matches — or one rare one — as evidence
 * strong enough to label a hit `term`-tier. Every extra probe is another chance for an unrelated
 * episode to clear that bar, so a twenty-variant fold does not merely add noise, it relabels noise
 * as evidence and reports a confidence the caller has no basis for. The failure of *not* folding is
 * bounded and visible: the term is named in `useless` and one question is lost. Losing a question
 * is recoverable. A retrieval layer that lies about why it returned something is not. Eight is what
 * one word's real spellings look like — the term, one stem, three shorthand forms, two numeric
 * forms, and room for one compound part.
 */

export interface Variant {
  form: string;
  kind: "exact" | "stem" | "split" | "abbrev" | "numeric";
}

/** See the header: the bar is "spellings a person plausibly used", not "strings that might hit". */
const MAX_VARIANTS = 8;

/** Below this a stem is not a fold, it is a substring that matches most of the language. */
const MIN_STEM = 3;

/** Separators inside a single written token. Commas are absent on purpose: they group digits. */
const SEPARATORS = /[-_/.=+\s]+/;
const HAS_SEPARATOR = /[-_/.=+\s]/;

/** `<word><number>`, however the writer punctuated the join. */
const WORD_NUMBER = /^([a-z]+)[-_=.\s]?(\d+(?:\.\d+)?)$/;

/** A bare number, grouped or not. `42-60` is deliberately not one: it is a range, so it splits. */
const NUMERIC = /^(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)$/;

/**
 * Split parts that name nothing on their own. `per-layer` is about layers, not about `per`.
 *
 * Every entry is a bound modifier or a function word: it qualifies the part beside it rather than
 * naming a thing, so as a probe it costs a document-frequency lookup and buys no discrimination.
 * This is not a general stoplist — `contentTerms` already dropped those, and rarity is measured
 * rather than guessed at. It is the short list of things that only ever appear glued to a word.
 */
const SPLIT_NOISE: Record<string, true> = {
  per: true, non: true, pre: true, post: true, sub: true, multi: true, inter: true,
  intra: true, anti: true, semi: true, cross: true, and: true, the: true, for: true,
  with: true, via: true, vs: true, not: true,
};

/**
 * Verb-plus-particle written solid: `login`, `plugin`, `signin`, `checkout`, `setup`, `handoff`.
 *
 * This is the rule H08 turns on and it is the most dangerous one here, because `-in` also ends a
 * pile of ordinary words. The guard is phonological rather than a word list: English glues a
 * particle onto a verb that ends on a consonant — log, plug, sign, check, hand — while the words
 * that merely happen to end in those letters carry a vowel in front of them: train, chain, brain,
 * main, domain, certain, bargain, mountain, group. Requiring a consonant keeps `login` → `log` and
 * refuses `train` → `tra`, which is the fold that would have made this worse than nothing.
 *
 * It is not exact. `admin` → `adm`, `begin` → `beg`, `basin` → `bas` and `cabin` → `cab` all get
 * through, and each of those is a fold that widens rather than sharpens. They are tolerable only
 * because the exact term is still first and still weighed on its own measured rarity; a list of
 * exceptions would be a guess about a corpus nobody has read yet.
 */
const PARTICLES = ["out", "off", "in", "up"] as const;

const VOWELS = "aeiou";

/** Porter's definition: `y` is a consonant at the start or after a vowel, a vowel otherwise. */
function isConsonant(w: string, i: number): boolean {
  const c = w[i];
  if (c === undefined) return false;
  if (VOWELS.includes(c)) return false;
  if (c !== "y") return true;
  return i === 0 || !isConsonant(w, i - 1);
}

/** Porter's m: how many vowel-then-consonant runs the word has. The guard on every rule below. */
function measure(w: string): number {
  let shape = "";
  for (let i = 0; i < w.length; i++) shape += isConsonant(w, i) ? "c" : "v";
  return (shape.match(/vc/g) ?? []).length;
}

function hasVowel(w: string): boolean {
  for (let i = 0; i < w.length; i++) if (!isConsonant(w, i)) return true;
  return false;
}

/** suffix, replacement, minimum measure of what has to survive underneath it. */
type Rule = readonly [string, string, number];

/**
 * Nominalisations. `calculations` → `calcul` is one of the four folds this file was specified
 * against; `ation` → nothing is what produces it, and the same rule converges `calculate`,
 * `calculated` and `calculating` on a prefix of all of them.
 */
const NOMINALISATIONS: readonly Rule[] = [
  ["ational", "", 1],
  ["ization", "", 1],
  ["ication", "", 1],
  ["iveness", "", 1],
  ["fulness", "", 1],
  ["ousness", "", 1],
  ["ation", "", 1],
  ["ition", "", 1],
  ["ement", "", 1],
  ["ality", "", 1],
  ["ility", "", 1],
  ["ivity", "", 1],
];

/**
 * Porter's step 4, all at m>1. That guard is doing real work: it is what keeps `logic` from
 * becoming `log`, `layer` from becoming `lay`, `total` from becoming `tot` and `current` from
 * becoming `curr`, while still folding `specific` → `specif` and `functional` → `function`.
 */
const RESIDUALS: readonly Rule[] = [
  ["ance", "", 1],
  ["ence", "", 1],
  ["able", "", 1],
  ["ible", "", 1],
  ["ment", "", 1],
  ["ant", "", 1],
  ["ent", "", 1],
  ["ism", "", 1],
  ["ate", "", 1],
  ["ous", "", 1],
  ["ive", "", 1],
  ["ize", "", 1],
  ["ise", "", 1],
  ["er", "", 1],
  ["ic", "", 1],
  ["al", "", 1],
];

/**
 * The longest applicable suffix wins. Longest matters — `calculation` has to reach `ation` rather
 * than stop at something shorter — and making it a property of the search rather than of the
 * table's ordering means inserting a rule in the wrong place cannot quietly change what a word
 * folds to. A suffix that matches but fails its measure guard falls through to a shorter one
 * instead of aborting the step, so `rational` still reaches `ration` when `r` is too short to keep.
 */
function applyLongest(w: string, rules: readonly Rule[]): string {
  let best = w;
  let bestLen = -1;
  for (const [suffix, replacement, minMeasure] of rules) {
    if (suffix.length <= bestLen || !w.endsWith(suffix)) continue;
    const stem = w.slice(0, w.length - suffix.length) + replacement;
    if (stem.length < MIN_STEM || measure(stem) <= minMeasure) continue;
    best = stem;
    bestLen = suffix.length;
  }
  return best;
}

function plurals(w: string): string {
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ies")) {
    const stem = `${w.slice(0, -3)}i`;
    return stem.length < MIN_STEM ? w : stem;
  }
  // `status`, `corpus`, `focus`, `bus`: that `s` is not a plural and stripping it is pure damage.
  if (w.endsWith("ss") || w.endsWith("us")) return w;
  if (!w.endsWith("s")) return w;
  const stem = w.slice(0, -1);
  return stem.length < MIN_STEM ? w : stem;
}

/**
 * Past and progressive. `logged` → `logg` → `log` is the second of the four specified folds, and
 * the undoubling is what gets it there.
 *
 * Porter would then restore a silent `e` on `hoping` → `hope`. That restoration is omitted, because
 * every variant here is spent as an `ILIKE '%v%'` substring probe and as a `tsquery` term: a stem
 * that adds a letter the inflected form does not contain cannot match the inflected form, which is
 * the entire reason the fold exists. `hop` finds `hoping`; `hope` does not.
 */
function pastAndProgressive(w: string): string {
  if (w.endsWith("eed")) {
    const stem = w.slice(0, -1);
    return measure(stem) > 0 ? stem : w;
  }
  const suffix = w.endsWith("ing") ? "ing" : w.endsWith("ed") ? "ed" : null;
  if (suffix === null) return w;
  let stem = w.slice(0, w.length - suffix.length);
  if (!hasVowel(stem) || stem.length < MIN_STEM) return w;
  const last = stem[stem.length - 1];
  const prev = stem[stem.length - 2];
  if (last !== undefined && last === prev && !"lsz".includes(last) && stem.length - 1 >= MIN_STEM) {
    stem = stem.slice(0, -1);
  }
  return stem;
}

/** `query` and `queries` both land on `queri`, which is the point: stems have to converge. */
function yToI(w: string): string {
  if (!w.endsWith("y") || w.length - 1 < MIN_STEM) return w;
  const stem = w.slice(0, -1);
  return hasVowel(stem) ? `${stem}i` : w;
}

/** `architecture` → `architectur`, the third specified fold. m>1 keeps `use` intact. */
function dropSilentE(w: string): string {
  if (!w.endsWith("e") || w.length - 1 < MIN_STEM) return w;
  const stem = w.slice(0, -1);
  return measure(stem) > 1 ? stem : w;
}

/** `controlled` survives step 1b as `controll`; this is what makes it `control`. */
function undoubleL(w: string): string {
  if (!w.endsWith("ll") || w.length - 1 < MIN_STEM) return w;
  const stem = w.slice(0, -1);
  return measure(w) > 1 ? stem : w;
}

function suffixStem(w: string): string {
  let s = plurals(w);
  s = pastAndProgressive(s);
  s = yToI(s);
  s = applyLongest(s, NOMINALISATIONS);
  s = applyLongest(s, RESIDUALS);
  s = dropSilentE(s);
  s = undoubleL(s);
  return s;
}

function stripParticle(w: string): string {
  for (const p of PARTICLES) {
    if (!w.endsWith(p)) continue;
    const head = w.slice(0, w.length - p.length);
    if (head.length < MIN_STEM) continue;
    if (!isConsonant(head, head.length - 1)) continue;
    return head;
  }
  return w;
}

function stemWord(word: string): string {
  const s = suffixStem(word);
  const bare = stripParticle(s);
  // One pass only. `logins` → `login` → `log`, and nothing chains further: a fold that folds its
  // own output has no fixed point anyone chose.
  return bare === s ? s : suffixStem(bare);
}

export function expandTerm(term: string): Variant[] {
  const trimmed = term.trim();
  const lower = trimmed.toLowerCase();

  // A probe with no alphanumeric content is a wildcard in one half of the match predicate and a
  // no-op in the other: `text ILIKE '%%'` returns the whole corpus while `plainto_tsquery` reduces
  // to an empty query that returns nothing. There is no safe probe to offer here, so none is
  // offered — reported as an empty list rather than silently coerced into something that matches.
  if (!/[a-z0-9]/.test(lower)) return [];

  const out: Variant[] = [];
  const seen = new Set<string>();
  const add = (form: string, kind: Variant["kind"]): void => {
    if (out.length >= MAX_VARIANTS) return;
    const key = form.toLowerCase();
    if (key === "" || seen.has(key)) return;
    seen.add(key);
    out.push({ form, kind });
  };

  add(trimmed, "exact");

  // Only a single run of letters is ever stemmed, and an alphanumeric run is never cut. Measured on
  // the Arc corpus: `qtip2b_grouped_gemm` has df 1 while `qtip` has df 5, and one of those five is
  // the human asking "what's the difference between qtip and qtip2b" — a question about a different
  // kernel. Folding the identifier would not have widened a key, it would have merged two kernels
  // into one bucket and made the corpus unable to tell them apart. `tok/s` and `page_size` are the
  // same shape of thing. They still gain their parts below, added to a form left exactly as written.
  if (/^[a-z]+$/.test(lower) && lower.length >= 4) {
    const s = stemWord(lower);
    if (s.length >= MIN_STEM && s !== lower) add(s, "stem");
  }

  const wordNumber = WORD_NUMBER.exec(lower);
  if (wordNumber) {
    const word = wordNumber[1] as string;
    const num = wordNumber[2] as string;
    add(`${word}${num}`, "abbrev");
    add(`${word}-${num}`, "abbrev");
    // `<initial><number>` only from a word long enough that a person would shorten it. `b1` for
    // `batch-1` is how it was actually written; `f8` for `fp8` is not, and one letter plus a digit
    // is among the highest-collision strings in the language.
    //
    // The reverse — `b1` back to `batch-1` — is not generated, because recovering the word from
    // its initial means inventing one. That asymmetry is real and it is not hidden: this fold
    // closes H03 only because the question carried the long form and the utterance the short one.
    if (word.length >= 4) add(`${word[0] as string}${num}`, "abbrev");
  }

  const isNumber = NUMERIC.test(lower);
  if (isNumber) {
    const bare = lower.replace(/,/g, "");
    const dot = bare.indexOf(".");
    const intPart = dot === -1 ? bare : bare.slice(0, dot);
    const fracPart = dot === -1 ? null : bare.slice(dot + 1);
    add(bare, "numeric");
    // `1400` → `1,400`; the other direction is the comma strip above.
    const grouped = intPart.replace(/\B(?=(?:\d{3})+(?!\d))/g, ",");
    add(fracPart === null ? grouped : `${grouped}.${fracPart}`, "numeric");
    if (fracPart !== null) {
      // `757.5` ↔ `757.50`. Digits only: a unit is a claim about what the number measures and
      // this function has no way to know one.
      add(`${bare}0`, "numeric");
      const trimmedFrac = fracPart.replace(/0+$/, "");
      add(trimmedFrac === "" ? intPart : `${intPart}.${trimmedFrac}`, "numeric");
    }
  }

  // A number is never split: `757.50` is one quantity, not a `757` beside a `50`. Neither is an
  // alphanumeric run — the split is on written separators only, which is what keeps `qtip2b` whole.
  if (!isNumber && HAS_SEPARATOR.test(lower)) {
    for (const part of lower.split(SEPARATORS)) {
      if (part === "") continue;
      if (/^\d+$/.test(part)) {
        add(part, "split");
        continue;
      }
      if (part.length < MIN_STEM || SPLIT_NOISE[part] === true) continue;
      add(part, "split");
    }
  }

  return out;
}

export function expandTerms(terms: string[]): Map<string, Variant[]> {
  const out = new Map<string, Variant[]>();
  for (const term of terms) {
    if (out.has(term)) continue;
    out.set(term, expandTerm(term));
  }
  return out;
}
