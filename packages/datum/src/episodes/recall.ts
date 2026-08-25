import type { Db, DbRole } from "../db/pool.js";
import { resolveChain } from "../domain/scope.js";
import { planQuery, type QueryPlan } from "./query.js";
import type { EpisodeRow } from "./types.js";

/**
 * Recall: ask a question in the words you would use, get back what was actually said.
 *
 * `searchEpisodes` takes a query and honours it exactly, which is right for a caller that already
 * knows what it is looking for. This is the other half — the caller has a *question*, phrased the
 * way people phrase questions, and the words in it are frequently not the words in the answer.
 *
 * Three tiers, and the third is the one that earns its keep:
 *
 *   term+window  the answer, when the question named a time and its words appear
 *   term         the ordinary case, no time named
 *   window       the question named a time and NONE of its words appear in what was said
 *
 * Tier three exists because the measured failure was information-theoretic, not a ranking
 * problem. Asked "what GEMV efficiency figure did Jish reject as nonsense", the utterance is
 * "GEMV kernel at 15% peak is pure bs" and the question's distinctive words — rejected, nonsense,
 * percentages — appear nowhere in the corpus at all. No ranking recovers that. But the question
 * also said "the evening of 15 Aug", and nineteen utterances exist in that window. Handing back
 * nineteen dated quotes is what a person would do, and it is a real answer where there was none.
 *
 * The plan travels with the result. A search that quietly ignores half a caller's words is the
 * same failure as an answer that quietly drops its own caveat.
 */

/** A window worth more than this is not a window, it is a search. Reported when it bites. */
const WINDOW_CAP = 60;

export type RecallTier = "term+window" | "term" | "window";

export interface RecallHit {
  episode: EpisodeRow;
  tier: RecallTier;
  /** Length-normalised sum of the idf of the terms this episode contains. 0 for a window hit. */
  score: number;
  /** Which of the caller's terms matched, so a weak hit is visibly weak. */
  matched_terms: string[];
}

export interface RecallResult {
  hits: RecallHit[];
  plan: QueryPlan;
  /** Plain-language account of what was done, for a caller that will never read the plan object. */
  note: string;
}

interface Row extends EpisodeRow {
  matched_terms: string[] | null;
  score: string | null;
  in_window: boolean;
}

const SQL = `WITH q AS (
   SELECT t.term, w.idf
     FROM unnest($2::text[]) WITH ORDINALITY AS t(term, i)
     JOIN unnest($3::float8[]) WITH ORDINALITY AS w(idf, j) ON t.i = w.j
 ),
 scoped AS (
   SELECT * FROM datum.episodes
    WHERE scope = ANY($1::text[])
      AND (NOT $7::boolean OR (occurred_at >= $4 AND occurred_at < $5))
 ),
 scored AS (
   SELECT e.*,
          -- ILIKE beside the tsquery: a code identifier or a decimal is one opaque word to English
          -- stemming, and those are the highest-value terms in this corpus.
          coalesce(array_agg(q.term) FILTER (WHERE q.term IS NOT NULL), ARRAY[]::text[]) AS mt,
          -- Length normalisation. Summed idf rewards long text for matching more terms by chance:
          -- a 1,500-character paste beat the 40-character sentence that was the actual answer.
          -- 240 is roughly the p90 human utterance here, so a normal sentence is barely touched
          -- and a pasted wall is divided by about three.
          coalesce(sum(q.idf), 0) / (1 + ln(1 + length(e.text)::numeric / 240)) AS sc
     FROM scoped e
     LEFT JOIN q ON e.episode_fts @@ plainto_tsquery('english', q.term)
                 OR e.text ILIKE '%' || q.term || '%'
    GROUP BY e.id, e.scope, e.session_id, e.seq, e.parent_id, e.occurred_at, e.actor,
             e.role, e.text, e.git_branch, e.git_commit, e.cwd, e.source, e.hash,
             e.ingested_at, e.episode_fts
 )
 SELECT id, scope, session_id, seq, parent_id, occurred_at, actor, role, text,
        git_branch, git_commit, cwd, source, hash, ingested_at,
        mt AS matched_terms, sc::text AS score,
        ($4::timestamptz IS NOT NULL AND occurred_at >= $4 AND occurred_at < $5) AS in_window
   FROM scored
  WHERE cardinality(mt) > 0 OR $7::boolean
  -- Ordered on the underlying expressions, never the output aliases. ORDER BY resolves an alias
  -- first, so \`sc::text AS score\` silently sorted "5.5" above "11.7" — lexicographically.
  ORDER BY cardinality(mt) > 0 DESC, sc DESC, occurred_at ASC
  LIMIT $6`;

export async function recallEpisodes(
  db: Db,
  opts: { scope: string; question: string; limit?: number },
  role: DbRole = "app",
): Promise<RecallResult> {
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 100);
  const { chain } = await resolveChain(db, opts.scope, role);
  const plan = await planQuery(db, chain, opts.question, role);

  const terms = plan.terms.map((t) => t.term);
  const idf = plan.terms.map((t) => t.idf);
  const since = plan.window?.since ?? null;
  const until = plan.window?.until ?? null;

  const run = async (windowed: boolean, cap: number): Promise<Row[]> => {
    const { rows } = await db.query<Row>(role, SQL, [chain, terms, idf, since, until, cap, windowed]);
    return rows;
  };

  // A named time is an assertion about where the answer is, so it filters rather than nudges.
  // Ranking it as a tiebreak let a long unrelated document from outside the window outscore the
  // right sentence inside it — measured, on the exact question this was built to fix.
  //
  // Falling back to the whole scope only when the window is empty: an empty window means the date
  // was misread, and a misread date should degrade to an ordinary search rather than to silence.
  let rows = await run(plan.window !== null, limit);
  let fellBack = false;
  if (plan.window && rows.length === 0) {
    rows = await run(false, limit);
    fellBack = true;
  }

  // When a time was named and not one query word appears inside it, there is no ranking signal at
  // all - every row scores zero, and ordering zeros by timestamp returns an arbitrary slice. So
  // the window itself becomes the answer: it is what a person asked "what did you say on Tuesday
  // evening" would hand over. Nineteen dated quotes from the right evening beats 550 from the
  // whole fortnight by a factor of 29 and still contains the answer, which is the entire claim.
  //
  // "No term matched" is too strict a trigger. A row sharing one common word with the question -
  // `say`, `actually`, `reported` - is not evidence, and twelve such rows displaced the answer
  // sitting in the same window: measured, on a question whose target was 23:46 inside a window
  // that held 28 utterances. So the bar is two terms, or one rare enough to be a key on its own.
  // Derived from the corpus in front of us. A hardcoded size was wrong the moment it was typed:
  // on a seven-episode store it set the bar above the maximum achievable idf, so no single term
  // could ever count as rare and the branch was dead.
  const rareBar = Math.log(Math.max(plan.corpus_size, 4) / 4) + 1;
  const idfOf = new Map(plan.terms.map((t) => [t.term, t.idf]));
  const discriminating = (r: Row): boolean => {
    const m = r.matched_terms ?? [];
    if (m.length >= 2) return true;
    return m.some((t) => (idfOf.get(t) ?? 0) >= rareBar);
  };

  let windowTotal: number | null = null;
  if (plan.window && !fellBack && !rows.some(discriminating)) {
    const counted = await db.one<{ n: string }>(
      role,
      `SELECT count(*)::text AS n FROM datum.episodes
        WHERE scope = ANY($1::text[]) AND occurred_at >= $2 AND occurred_at < $3`,
      [chain, since, until],
    );
    windowTotal = Number(counted?.n ?? 0);
    if (windowTotal > rows.length) rows = await run(true, Math.min(windowTotal, WINDOW_CAP));
    // Ranking by a score nobody should trust is worse than not ranking: in window mode the order
    // that carries information is the order things were said in.
    rows.sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
  }

  const hits: RecallHit[] = rows.map((r) => {
    const matched = r.matched_terms ?? [];
    // A weak hit is labelled as what it is. Calling a single common word a term match would tell
    // the caller it had evidence it does not have.
    const strong = discriminating(r);
    const tier: RecallTier = strong ? (r.in_window ? "term+window" : "term") : "window";
    const { matched_terms: _m, score: _s, in_window: _w, ...episode } = r;
    return {
      episode: episode as EpisodeRow,
      tier,
      score: Number(Number(r.score ?? 0).toFixed(2)),
      matched_terms: matched,
    };
  });

  const parts: string[] = [];
  if (plan.window) parts.push(`window ${plan.window.read_as}`);
  if (fellBack) parts.push("that window was empty, so this is a search of the whole scope");
  if (plan.terms.length > 0) {
    parts.push(`terms ${plan.terms.slice(0, 6).map((t) => `${t.term}(${t.idf})`).join(" ")}`);
  }
  if (plan.useless.length > 0) {
    // Named, not swallowed. "Nothing in this corpus ever used that word" is a useful answer.
    parts.push(`absent from corpus: ${plan.useless.slice(0, 8).join(", ")}`);
  }
  const windowOnly = hits.filter((h) => h.tier === "window").length;
  if (hits.length > 0 && windowOnly === hits.length) {
    const total = windowTotal ?? hits.length;
    parts.push(
      total > hits.length
        ? `no term matched — showing ${hits.length} of ${total} said in that window`
        : `no term matched — this is all ${hits.length} said in that window`,
    );
  }
  if (hits.length === 0) {
    parts.push(
      plan.terms.length === 0 && !plan.window
        ? "no usable terms and no date in the question"
        : "nothing matched",
    );
  }

  return { hits, plan, note: parts.join("; ") };
}
