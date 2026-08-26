import type { Db, DbRole } from "../db/pool.js";
import { readWhen, TIME_PHRASES, type TimeWindow } from "./when.js";
import { expandTerms, type Variant } from "./terms.js";

/**
 * Turning a question into a query.
 *
 * The measured failure this exists for: on 40 benchmark questions, episode retrieval scored 95%
 * when handed good topic words and 62.5% when the words were taken from the question text. Reading
 * the 14 that flipped showed the problem is not paraphrase and not ranking — it is that a question
 * is phrased in *reporting* vocabulary while an utterance is phrased in *content* vocabulary:
 *
 *   asked:  "Jish rejected a GEMV kernel efficiency figure as nonsense"
 *   said:   "GEMV kernel at 15% peak is pure bs. Other projects do it at 50%"
 *
 * The terms that reached the index were `rejected`, `nonsense`, `efficiency`, `percentages`. Not
 * one of them appears in the utterance, so no amount of better matching could have found it. That
 * is information-theoretic, not a tuning problem.
 *
 * What every one of those 14 questions DID carry was a time: "the evening of 13 Aug", "just after
 * midnight on 17 Aug", "the night of 19 Aug". Episodes are timestamped and the search ignored it.
 * A time window collapses 542 episodes to a handful, and at that size returning the window itself
 * is a better answer than returning nothing — which is what a person would do if asked what was
 * said on Tuesday evening.
 *
 * So: parse the time, weight the terms by how rare they actually are in this corpus rather than by
 * a hand-written list, and report what was used. Search that silently discards half a caller's
 * words is the same sin as an answer that silently drops its own caveat.
 */

export type { TimeWindow };

export interface PlannedTerm {
  term: string;
  /** Documents in the corpus containing it. 0 means it cannot contribute. */
  df: number;
  /** log(N / df). Higher is rarer and more discriminating. */
  idf: number;
  /** The form actually sent to the index, and how it was derived from `term`. */
  probe: string;
  via: Variant["kind"];
}

export interface QueryPlan {
  terms: PlannedTerm[];
  /** Live episodes in scope. The rarity bar is derived from this, never from a constant. */
  corpus_size: number;
  /** Sent by the caller and present nowhere in the corpus. Reported, never silently dropped. */
  useless: string[];
  window: TimeWindow | null;
}

/** Words that carry no topic. Deliberately short: rarity is measured, not guessed at. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "by",
  "from", "as", "is", "are", "was", "were", "be", "been", "being", "it", "its", "this",
  "that", "these", "those", "he", "she", "they", "his", "her", "their", "what", "which",
  "who", "whom", "whose", "when", "where", "why", "how", "did", "does", "do", "done",
  "can", "could", "should", "would", "will", "shall", "may", "might", "must", "have",
  "has", "had", "not", "no", "yes", "only", "same", "other", "another", "two", "three",
  "there", "then", "than", "them", "you", "your", "i", "me", "my", "we", "us", "our",
  "give", "gave", "name", "named", "call", "called", "about", "into", "out", "up", "down",
  "just", "also", "both", "each", "any", "all", "some", "one", "if", "so", "such",
]);

const MONTH_WORDS = new Set([
  "jan","january","feb","february","mar","march","apr","april","may","jun","june",
  "jul","july","aug","august","sep","sept","september","oct","october","nov","november",
  "dec","december",
]);

/**
 * Reading a date out of a question now lives in `when.ts`, which resolves phrases this file used to
 * flatten. "Late on 14 Aug" was read here as the whole of 14 Aug - four times wider than asked -
 * and the answer then lost to 22 unrelated rows in the same day.
 */
export function parseWhen(text: string, corpus: { first: Date; last: Date }): TimeWindow | null {
  return readWhen(text, corpus);
}

/** Words worth sending to an index: not stopwords, not the date we already parsed. */
export function contentTerms(text: string): string[] {
  const timeWords = new Set(TIME_PHRASES.flatMap((p) => p.phrase.split(" ")));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_.$/+-]+/)) {
    const w = raw.replace(/^[.\-+]+|[.\-+]+$/g, "");
    if (w.length < 2) continue;
    if (STOP.has(w) || MONTH_WORDS.has(w)) continue;
    if (/^\d{1,2}(st|nd|rd|th)?$/.test(w)) continue; // day-of-month leftovers
    if (timeWords.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/**
 * Measure how discriminating each term actually is, in this corpus, right now.
 *
 * A hand-written list of "vague words" would be a guess that rots. Document frequency is a
 * measurement: `nonsense` is rare in English and absent here, `efficiency` is common here and
 * therefore weak, and `qtip2b_grouped_gemm` is a near-unique key. One query for all of them.
 */
export async function weighTerms(
  db: Db,
  scopes: string[],
  terms: string[],
  role: DbRole = "app",
): Promise<{ terms: PlannedTerm[]; useless: string[]; corpusSize: number }> {
  if (terms.length === 0) return { terms: [], useless: [], corpusSize: 0 };

  // Every viable spelling of a term is sent, not just the best one. Measured on this corpus:
  // `login` has df 1 and idf 7.295 and points at the WRONG document, while its stem `log` has
  // df 19 and idf 4.351 and its 19 include the right one. Picking the rarest variant would pick
  // the confident mistake, so both go, and the ranker decides.
  //
  // Kind is a discount rather than a filter, because breadth is exactly what a fold buys and the
  // discount is what stops it drowning an exact hit. `split` carries the heaviest discount: it
  // produced every off-target match in the fold's own precision test.
  const DISCOUNT: Record<Variant["kind"], number> = {
    exact: 1,
    abbrev: 0.9,
    numeric: 0.9,
    stem: 0.7,
    split: 0.5,
  };

  const expanded = expandTerms(terms);
  const probes: Array<{ term: string; probe: string; via: Variant["kind"] }> = [];
  const seen = new Set<string>();
  for (const [term, variants] of expanded) {
    for (const v of variants) {
      // A bare number matches a timestamp, a version, a list index and nothing meaningful. The
      // fold's precision test attributed all of its off-target hits to exactly this shape.
      if (v.kind === "split" && /^\d+$/.test(v.form)) continue;
      // Length floor applies to the folds that BROADEN a term, not to the ones that respell it.
      // `b1` is two characters and is the whole point of the abbreviation fold - dropping it here
      // silently undid the fix it was built for, and the only reason it surfaced is that the
      // question it was built from was still failing afterwards.
      const floor = v.kind === "abbrev" || v.kind === "numeric" ? 2 : 3;
      if (v.kind !== "exact" && v.form.length < floor) continue;
      const key = `${term}\u0000${v.form}`;
      if (seen.has(key)) continue;
      seen.add(key);
      probes.push({ term, probe: v.form, via: v.kind });
    }
  }
  // Bounded so one pathological question cannot turn into a hundred index probes.
  const capped = probes.slice(0, 24);

  const { rows } = await db.query<{ probe: string; df: string; n: string }>(
    role,
    `WITH corpus AS (
       SELECT id, text, episode_fts FROM datum.episodes WHERE scope = ANY($1::text[])
     ), total AS (SELECT count(*)::text AS n FROM corpus)
     SELECT q.probe,
            (SELECT count(*) FROM corpus c
              WHERE c.episode_fts @@ plainto_tsquery('english', q.probe)
                 OR c.text ILIKE '%' || q.probe || '%')::text AS df,
            (SELECT n FROM total) AS n
       FROM unnest($2::text[]) AS q(probe)`,
    [scopes, capped.map((p) => p.probe)],
  );
  const n = Number(rows[0]?.n ?? 0) || 1;
  const dfOf = new Map(rows.map((r) => [r.probe, Number(r.df)]));

  const planned: PlannedTerm[] = [];
  const reached = new Set<string>();
  for (const p of capped) {
    const df = dfOf.get(p.probe) ?? 0;
    if (df === 0) continue;
    reached.add(p.term);
    planned.push({
      term: p.term,
      probe: p.probe,
      via: p.via,
      df,
      idf: Number(((Math.log(n / df) + 1) * DISCOUNT[p.via]).toFixed(3)),
    });
  }
  // "Useless" is now a stronger claim: not one spelling of this word occurs in the corpus.
  const useless = terms.filter((t) => !reached.has(t));
  planned.sort((a, b) => b.idf - a.idf);
  return { terms: planned, useless, corpusSize: n };
}

/** The corpus bounds a date has to land inside. */
export async function corpusBounds(
  db: Db,
  scopes: string[],
  role: DbRole = "app",
): Promise<{ first: Date; last: Date } | null> {
  const row = await db.one<{ first: Date | null; last: Date | null }>(
    role,
    `SELECT min(occurred_at) AS first, max(occurred_at) AS last
       FROM datum.episodes WHERE scope = ANY($1::text[])`,
    [scopes],
  );
  if (!row?.first || !row.last) return null;
  return { first: new Date(row.first), last: new Date(row.last) };
}

export async function planQuery(
  db: Db,
  scopes: string[],
  question: string,
  role: DbRole = "app",
): Promise<QueryPlan> {
  const bounds = await corpusBounds(db, scopes, role);
  const window = bounds ? parseWhen(question, bounds) : null;
  const { terms, useless, corpusSize } = await weighTerms(db, scopes, contentTerms(question), role);
  return { terms, useless, window, corpus_size: corpusSize };
}
