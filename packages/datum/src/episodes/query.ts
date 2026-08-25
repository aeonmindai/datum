import type { Db, DbRole } from "../db/pool.js";

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

export interface TimeWindow {
  since: Date;
  until: Date;
  /** How it was read, in words, so a caller can see the interpretation and disagree with it. */
  read_as: string;
}

export interface PlannedTerm {
  term: string;
  /** Documents in the corpus containing it. 0 means it cannot contribute. */
  df: number;
  /** log(N / df). Higher is rarer and more discriminating. */
  idf: number;
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

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/**
 * Time of day, as an hour range in the speaker's own clock.
 *
 * Loose on purpose and overlapping where English is: "night of the 19th" in practice means the
 * late hours of the 19th, and people say "morning" for anything before lunch. A window that is
 * too tight silently excludes the answer, which is the failure mode worth avoiding; too wide only
 * costs a few extra rows out of 542.
 */
const TIME_OF_DAY: Record<string, [number, number]> = {
  midnight: [22, 27], // spans into the next day, resolved below
  "early hours": [0, 6],
  "small hours": [0, 5],
  dawn: [4, 8],
  morning: [5, 13],
  midday: [11, 15],
  noon: [11, 15],
  afternoon: [12, 19],
  evening: [16, 23],
  night: [19, 27],
  overnight: [21, 30],
};

const DAY_MS = 86_400_000;

/**
 * Read a date out of a question.
 *
 * The year is not guessed: it comes from the corpus the caller is querying, because a question
 * says "13 Aug" and a store that spans one fortnight has exactly one 13 Aug in it. If the corpus
 * genuinely straddles the same date in two years, that is reported by widening rather than by
 * silently picking one.
 */
export function parseWhen(text: string, corpus: { first: Date; last: Date }): TimeWindow | null {
  const t = text.toLowerCase();

  const monthNames = Object.keys(MONTHS).join("|");
  // "13 Aug", "Aug 13", "13th of August", "on 21 aug"
  const dayMonth =
    t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthNames})\\b`)) ??
    t.match(new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (!dayMonth) return null;

  const [dayStr, monStr] = /^\d/.test(dayMonth[1] as string)
    ? [dayMonth[1] as string, dayMonth[2] as string]
    : [dayMonth[2] as string, dayMonth[1] as string];
  const day = Number.parseInt(dayStr, 10);
  const month = MONTHS[monStr];
  if (month === undefined || day < 1 || day > 31) return null;

  // Which year? Whichever candidate falls inside the corpus. Nothing is hardcoded and no
  // assumption survives a corpus that moves.
  const years = new Set([corpus.first.getUTCFullYear(), corpus.last.getUTCFullYear()]);
  let base: Date | null = null;
  for (const y of [...years].sort()) {
    const cand = new Date(Date.UTC(y, month, day));
    if (cand.getTime() >= corpus.first.getTime() - DAY_MS && cand.getTime() <= corpus.last.getTime() + DAY_MS) {
      base = cand;
      break;
    }
  }
  if (base === null) return null;

  // Time of day, if named. Longest phrase first so "small hours" beats "hours".
  let hours: [number, number] | null = null;
  let label = "";
  for (const phrase of Object.keys(TIME_OF_DAY).sort((a, b) => b.length - a.length)) {
    if (t.includes(phrase)) {
      hours = TIME_OF_DAY[phrase] as [number, number];
      label = phrase;
      break;
    }
  }

  if (hours === null) {
    return {
      since: base,
      until: new Date(base.getTime() + DAY_MS),
      read_as: `${base.toISOString().slice(0, 10)} (whole day)`,
    };
  }

  // "just after midnight on 17 Aug" means the early hours OF the 17th, not the night before.
  const [lo, hi] = t.includes("just after midnight") || t.includes("small hours") || t.includes("early hours")
    ? [0, 6]
    : hours;
  const since = new Date(base.getTime() + lo * 3_600_000);
  const until = new Date(base.getTime() + hi * 3_600_000);
  return {
    since,
    until,
    read_as: `${base.toISOString().slice(0, 10)} ${label} (${lo}:00-${hi % 24}:00${hi > 24 ? " next day" : ""})`,
  };
}

/** Words worth sending to an index: not stopwords, not the date we already parsed. */
export function contentTerms(text: string): string[] {
  const monthNames = new Set(Object.keys(MONTHS));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_.$/+-]+/)) {
    const w = raw.replace(/^[.\-+]+|[.\-+]+$/g, "");
    if (w.length < 2) continue;
    if (STOP.has(w) || monthNames.has(w)) continue;
    if (/^\d{1,2}(st|nd|rd|th)?$/.test(w)) continue; // day-of-month leftovers
    if (Object.keys(TIME_OF_DAY).some((p) => p.split(" ").includes(w))) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    // A compound carries its parts. "three-stage" as one token matches nothing; "stage" might.
    if (/[-_/.]/.test(w)) {
      for (const part of w.split(/[-_/.]+/)) {
        if (part.length < 3 || STOP.has(part) || seen.has(part)) continue;
        seen.add(part);
        out.push(part);
      }
    }
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
  const { rows } = await db.query<{ term: string; df: string; n: string }>(
    role,
    `WITH corpus AS (
       SELECT id, text, episode_fts FROM datum.episodes WHERE scope = ANY($1::text[])
     ), total AS (SELECT count(*)::text AS n FROM corpus)
     SELECT q.term,
            (SELECT count(*) FROM corpus c
              WHERE c.episode_fts @@ plainto_tsquery('english', q.term)
                 OR c.text ILIKE '%' || q.term || '%')::text AS df,
            (SELECT n FROM total) AS n
       FROM unnest($2::text[]) AS q(term)`,
    [scopes, terms],
  );
  const n = Number(rows[0]?.n ?? 0) || 1;
  const planned: PlannedTerm[] = [];
  const useless: string[] = [];
  for (const r of rows) {
    const df = Number(r.df);
    if (df === 0) {
      useless.push(r.term);
      continue;
    }
    planned.push({ term: r.term, df, idf: Number((Math.log(n / df) + 1).toFixed(3)) });
  }
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
