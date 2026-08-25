import { collectProseFiles, readProseFiles } from "./walk.js";

/**
 * Subsystem 3: the trust-graded read's prose fallback.
 *
 * The one thing to understand about this file is what it does *not* do. Nothing it returns is
 * ever written to `datum.assertions`. It reads the corpus at query time, ranks lines, and hands
 * back citations. That is the whole design, and it is what lets the store stay un-rottable while
 * coverage goes up: the confidence taxonomy stays at four earned classes because prose never
 * enters it. `/v1/ask` returns these under a separate `from_prose` key, never merged into
 * `assertions`, so a prose hit can no more satisfy a mission gate than testimony can.
 *
 * ## Why BM25 and not embeddings
 *
 * Because BM25 wins on this workload and costs nothing. Datum's own research notes that
 * Okapi BM25 — published in 1994 — outperforms Mem0, MemGPT and GraphRAG on single-hop
 * retrieval, which is the shape of nearly every question an agent asks a knowledgebase
 * ("what is X", "where is Y set"). An embedding index would add a model dependency, an index
 * to keep in sync with the corpus, and a class of failure where the citation points at a line
 * that is merely *topically* near the question. A lexical score cannot do that: if a term is
 * not in the line, the line does not score for it.
 *
 * ## The one departure from textbook BM25
 *
 * BM25 is a bag of words, so `"require k4v2l16"` scores identically whether the two terms are
 * adjacent or forty words apart. For a knowledgebase that is the wrong ordering — an exact
 * phrase is almost always the intended hit and an incidental co-occurrence almost never is.
 * So a line containing the query as a contiguous token run gets a bounded multiplicative boost.
 * This is the same idea as a Lucene phrase query, kept to one constant so it is auditable.
 */

/** One ranked line of prose, with everything a reader needs to go check it. */
export interface ProseHit {
  /** Path as given, rooted at the caller's `roots` entry, so it opens as printed. */
  path: string;
  /** 1-based, matching every editor and every `file:line` convention. */
  line: number;
  /** The matched line, trimmed and length-capped. */
  text: string;
  score: number;
  /** The matched line plus a few lines either side, so the reader sees the claim in context. */
  snippet: string;
}

export interface ProseSearchOptions {
  roots: string[];
  query: string;
  limit?: number;
  maxBytes?: number;
}

/** Okapi BM25's usual parameters. Nothing here justifies inventing our own. */
const K1 = 1.2;
const B = 0.75;

/**
 * Doubling an exact-phrase hit. Chosen as the smallest boost that reliably lifts a phrase match
 * above an incidental co-occurrence of the same terms, and deliberately multiplicative rather
 * than additive so it cannot swamp the IDF signal on a rare term.
 */
const PHRASE_BOOST = 2.0;

const DEFAULT_LIMIT = 10;

/**
 * 8 MiB. The read path is inside a request, and this is the ceiling that keeps a 63.7 MB corpus
 * from turning `/v1/ask` into a scan. Callers who want the whole corpus pass a bigger number and
 * accept the latency; nobody gets to accept it by accident.
 */
export const DEFAULT_PROSE_MAX_BYTES = 8 * 1024 * 1024;

/** Lines either side of the hit included in `snippet`. */
const CONTEXT_LINES = 2;

/** A generated or minified file can hold a megabyte on one line; a citation must stay readable. */
const MAX_TEXT_CHARS = 400;
const MAX_SNIPPET_LINE_CHARS = 300;

/**
 * Lowercase tokens, plus the sub-words of any compound identifier.
 *
 * The reason for the sub-words is concrete: the highest-value queries against a code-adjacent
 * corpus are identifiers. `gather_forward` must be findable by someone who typed
 * "gather forward", and `QtipGeometry` by someone who typed "qtip geometry", so a compound
 * emits both itself and its parts. Emitting both rather than only the parts is what keeps the
 * exact identifier the stronger match: it is a rarer token, so IDF rates it higher.
 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  for (const chunk of input.split(/[^A-Za-z0-9_]+/)) {
    if (chunk.length === 0) continue;
    const whole = chunk.toLowerCase();
    out.push(whole);
    for (const part of chunk.split("_")) {
      if (part.length === 0) continue;
      const camel = part.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z]+|[0-9]+/g);
      if (!camel) continue;
      for (const piece of camel) {
        const lowered = piece.toLowerCase();
        if (lowered !== whole) out.push(lowered);
      }
    }
  }
  return out;
}

/**
 * A token stream rendered as space-separated words with sentinel spaces at both ends, so a
 * substring test is automatically a token-boundary test: " gather forward " cannot match
 * inside " gathered forwards ".
 */
function phraseForm(tokens: readonly string[]): string {
  return ` ${tokens.join(" ")} `;
}

interface Candidate {
  path: string;
  /** 0-based index into the document's lines. */
  index: number;
  /** Query-term frequencies in this line. Only query terms are counted; nothing else is needed. */
  tf: Map<string, number>;
  /** Line length in tokens, for BM25's length normalisation. */
  dl: number;
  phrase: boolean;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Search the corpus and return ranked citations. Never writes anything, anywhere.
 *
 * The document unit is a **line**, not a file. A file-level score would tell a reader which
 * document to go read, which is what a search engine does; this has to answer with a `file:line`
 * a reviewer can check in one look, and the line is the smallest unit that still carries a claim.
 */
export async function searchProse(opts: ProseSearchOptions): Promise<ProseHit[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const maxBytes = opts.maxBytes ?? DEFAULT_PROSE_MAX_BYTES;

  const queryTokens = tokenize(opts.query);
  if (queryTokens.length === 0) return [];
  const terms = [...new Set(queryTokens)];
  const termIndex: Record<string, true> = {};
  for (const term of terms) termIndex[term] = true;
  // A single token is not a phrase, and boosting it would double every hit uniformly.
  const phrase = queryTokens.length > 1 ? phraseForm(queryTokens) : null;

  const files = await collectProseFiles(opts.roots, maxBytes);
  const docs = await readProseFiles(files);

  const df = new Map<string, number>();
  const candidates: Candidate[] = [];
  // Held so snippets can be built for the winners without a second read. Bounded by `maxBytes`,
  // which is the budget we already promised the caller.
  const retained = new Map<string, string[]>();
  let documentCount = 0;
  let tokenTotal = 0;

  for (const doc of docs) {
    let retain = false;
    for (let i = 0; i < doc.lines.length; i++) {
      const raw = doc.lines[i] ?? "";
      const tokens = tokenize(raw);
      // A blank line is not a retrievable unit, so it must not drag `avgdl` down; counting it
      // would make every real line look long and suppress its score.
      if (tokens.length === 0) continue;
      documentCount += 1;
      tokenTotal += tokens.length;

      let tf: Map<string, number> | null = null;
      for (const token of tokens) {
        if (!Object.hasOwn(termIndex, token)) continue;
        tf ??= new Map();
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }
      if (!tf) continue;

      for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
      candidates.push({
        path: doc.path,
        index: i,
        tf,
        dl: tokens.length,
        phrase: phrase !== null && phraseForm(tokens).includes(phrase),
      });
      retain = true;
    }
    if (retain) retained.set(doc.path, doc.lines);
  }

  if (candidates.length === 0) return [];
  const avgdl = documentCount > 0 ? tokenTotal / documentCount : 1;

  // Robertson-Sparck Jones IDF in the form that is always positive. The textbook variant goes
  // negative for terms in more than half the corpus, which would make a common word actively
  // penalise a line that contains it — nonsense for a citation ranking.
  const idf = new Map<string, number>();
  for (const term of terms) {
    const n = df.get(term) ?? 0;
    idf.set(term, Math.log(1 + (documentCount - n + 0.5) / (n + 0.5)));
  }

  const scored = candidates.map((candidate) => {
    let score = 0;
    for (const [term, freq] of candidate.tf) {
      const weight = idf.get(term) ?? 0;
      const norm = freq + K1 * (1 - B + (B * candidate.dl) / avgdl);
      score += (weight * (freq * (K1 + 1))) / norm;
    }
    if (candidate.phrase) score *= PHRASE_BOOST;
    return { candidate, score };
  });

  // Path then line breaks ties, so two identical queries return the identical ordering. A
  // citation whose rank depends on filesystem iteration order is not reproducible.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.candidate.path < b.candidate.path ? -1 : a.candidate.path > b.candidate.path ? 1 : 0) ||
      a.candidate.index - b.candidate.index,
  );

  const hits: ProseHit[] = [];
  for (const { candidate, score } of scored.slice(0, limit)) {
    const lines = retained.get(candidate.path) ?? [];
    const from = Math.max(0, candidate.index - CONTEXT_LINES);
    const to = Math.min(lines.length, candidate.index + CONTEXT_LINES + 1);
    hits.push({
      path: candidate.path,
      line: candidate.index + 1,
      text: clip((lines[candidate.index] ?? "").trim(), MAX_TEXT_CHARS),
      score,
      snippet: lines
        .slice(from, to)
        .map((l) => clip(l, MAX_SNIPPET_LINE_CHARS))
        .join("\n"),
    });
  }
  return hits;
}
