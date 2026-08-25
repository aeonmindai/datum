import type { Db, DbRole } from "../db/pool.js";
import { resolveChain } from "../domain/scope.js";
import type { EpisodeRow } from "./types.js";

/**
 * Reading back what was said.
 *
 * Retrieval here is allowed to be fuzzy, and that is not a hole in the no-guessing rule: a
 * near-miss *number* is a lie, while a near-miss *quote* stamped with who said it, when, and on
 * which branch is a citation the reader judges. So every hit carries the tier that produced it and
 * the caller can always tell an exact hit from a rescue.
 *
 * Nothing here writes, and nothing here turns an episode into an assertion — promotion from
 * conversation to fact stays an explicit act by a person or an instrument.
 */

const COLUMNS = `e.id, e.scope, e.session_id, e.seq, e.parent_id, e.occurred_at, e.actor, e.role,
  e.text, e.git_branch, e.git_commit, e.cwd, e.source, e.hash, e.ingested_at`;

const DEFAULT_LIMIT = 25;

/**
 * Rescue threshold for the trigram tier, measured against the real corpus: a transposition in
 * `qtip2b_grouped_gemm` scores 0.667 while the nearest unrelated sentence sharing the word
 * "grouped" scores 0.211, so 0.45 separates a typo from a coincidence. Postgres' own default for
 * `<%` is 0.6, tight enough that a second typo in a long identifier drops out entirely.
 */
const TRIGRAM_THRESHOLD = 0.45;

export type MatchTier = "phrase" | "fts" | "trigram" | "filter";

export interface EpisodeQuery {
  scope: string;
  text?: string;
  actor?: string;
  role?: string;
  branch?: string;
  session?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface EpisodeHit {
  episode: EpisodeRow;
  rank: number;
  matched: MatchTier;
}

interface RankedRow extends EpisodeRow {
  rank: number;
}

/** LIKE has two metacharacters and `_` is the one that appears in every code identifier. */
function likeContains(needle: string): string {
  return `%${needle.replace(/([\\%_])/g, "\\$1")}%`;
}

/**
 * $1..$7 are the scope chain and the flat filters, shared by every tier. $8 excludes rows a higher
 * tier already returned, $9 is the remaining budget, $10 is the tier's own query text.
 */
const BASE_WHERE = `e.scope = ANY($1::text[])
      AND ($2::text IS NULL OR e.actor = $2)
      AND ($3::text IS NULL OR e.role = $3)
      AND ($4::text IS NULL OR e.git_branch = $4)
      AND ($5::text IS NULL OR e.session_id = $5)
      AND ($6::timestamptz IS NULL OR e.occurred_at >= $6::timestamptz)
      AND ($7::timestamptz IS NULL OR e.occurred_at <= $7::timestamptz)`;

function baseParams(chain: string[], q: EpisodeQuery): unknown[] {
  return [
    chain,
    q.actor ?? null,
    q.role ?? null,
    q.branch ?? null,
    q.session ?? null,
    q.since ?? null,
    q.until ?? null,
  ];
}

function tierSql(rank: string, predicate: string): string {
  return `SELECT ${COLUMNS}, ${rank} AS rank
            FROM datum.episodes e
           WHERE ${BASE_WHERE}
             AND NOT (e.id = ANY($8::text[]))
             AND ${predicate}
           ORDER BY rank DESC, e.occurred_at DESC, e.id DESC
           LIMIT $9`;
}

/**
 * Exact containment, then full-text, then trigram — and that order is not negotiable.
 *
 * Phrase and full-text are both precise, so a short phrase result is topped up from full-text and
 * every row still says which tier found it. Trigram is consulted only when the precise tiers found
 * nothing at all: it exists to rescue a mistyped identifier, not to pad a page with sentences that
 * happen to share letters.
 *
 * `resolveChain` means a query at `org/x/proj/y` also sees what was said at `org/x`, unless that
 * project declared itself isolated.
 */
export async function searchEpisodes(
  db: Db,
  q: EpisodeQuery,
  dbRole: DbRole = "app",
): Promise<EpisodeHit[]> {
  const limit = Math.max(1, Math.min(q.limit ?? DEFAULT_LIMIT, 500));
  const { chain } = await resolveChain(db, q.scope, dbRole);
  const needle = q.text?.trim() ?? "";
  const base = baseParams(chain, q);

  if (needle.length === 0) {
    const { rows } = await db.query<EpisodeRow>(
      dbRole,
      `SELECT ${COLUMNS}
         FROM datum.episodes e
        WHERE ${BASE_WHERE}
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT $8`,
      [...base, limit],
    );
    return rows.map((episode) => ({ episode, rank: 0, matched: "filter" as const }));
  }

  const hits: EpisodeHit[] = [];
  const seen: string[] = [];
  const collect = (rows: RankedRow[], matched: MatchTier): void => {
    for (const { rank, ...episode } of rows) {
      seen.push(episode.id);
      hits.push({ episode, rank, matched });
    }
  };

  const phrase = await db.query<RankedRow>(dbRole, tierSql("1::float8", "e.text ILIKE $10"), [
    ...base,
    seen,
    limit,
    likeContains(needle),
  ]);
  collect(phrase.rows, "phrase");

  if (hits.length < limit) {
    const fts = await db.query<RankedRow>(
      dbRole,
      tierSql(
        "ts_rank_cd(e.episode_fts, websearch_to_tsquery('english', $10))::float8",
        "e.episode_fts @@ websearch_to_tsquery('english', $10)",
      ),
      [...base, seen, limit - hits.length, needle],
    );
    collect(fts.rows, "fts");
  }

  if (hits.length === 0) {
    // `<%` is index-assisted but reads its cutoff from a GUC, so the threshold is set for this
    // transaction only rather than left behind on a pooled connection for the next caller.
    const rows = await db.tx(dbRole, async (client) => {
      await client.query(`SET LOCAL pg_trgm.word_similarity_threshold = ${TRIGRAM_THRESHOLD}`);
      const res = await client.query<RankedRow>(
        tierSql("word_similarity($10, e.text)::float8", "$10 <% e.text"),
        [...base, seen, limit, needle],
      );
      return res.rows;
    });
    collect(rows, "trigram");
  }

  return hits;
}

/**
 * One conversation, in the order it happened.
 *
 * `around` is what makes a search hit readable: a quote alone is deniable, a quote with the turns
 * either side of it is not. The window is nearest-by-position over rows that exist, not a `seq`
 * range, so a transcript with holes in it still returns a contiguous run of real turns, and a hit
 * at the very start or end of a session still comes back with a full window rather than half of one.
 */
export async function getSession(
  db: Db,
  sessionId: string,
  opts: { limit?: number; around?: number } = {},
  dbRole: DbRole = "app",
): Promise<EpisodeRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, 2000));

  if (opts.around === undefined) {
    const { rows } = await db.query<EpisodeRow>(
      dbRole,
      `SELECT ${COLUMNS}
         FROM datum.episodes e
        WHERE e.session_id = $1
        ORDER BY e.seq
        LIMIT $2`,
      [sessionId, limit],
    );
    return rows;
  }

  // Each side is walked through the (session_id, seq) index for at most `limit` rows, and the outer
  // pick keeps the closest `limit` of them, which is what re-centres the window at a session edge.
  const { rows } = await db.query<EpisodeRow>(
    dbRole,
    `WITH nearby AS (
       (SELECT ${COLUMNS} FROM datum.episodes e
          WHERE e.session_id = $1 AND e.seq <= $2 ORDER BY e.seq DESC LIMIT $3)
       UNION ALL
       (SELECT ${COLUMNS} FROM datum.episodes e
          WHERE e.session_id = $1 AND e.seq > $2 ORDER BY e.seq LIMIT $3)
     ), picked AS (
       SELECT * FROM nearby ORDER BY abs(seq - $2), seq LIMIT $3
     )
     SELECT * FROM picked ORDER BY seq`,
    [sessionId, opts.around, limit],
  );
  return rows;
}

export interface EpisodeStats {
  sessions: number;
  episodes: number;
  humans: number;
  agents: number;
  first: Date | null;
  last: Date | null;
  branches: string[];
}

/** What a reader standing at this scope can see, counted over the same chain a search reads. */
export async function episodeStats(
  db: Db,
  scope: string,
  dbRole: DbRole = "app",
): Promise<EpisodeStats> {
  const { chain } = await resolveChain(db, scope, dbRole);
  const row = await db.one<{
    sessions: string;
    episodes: string;
    humans: string;
    agents: string;
    first: Date | null;
    last: Date | null;
    branches: string[] | null;
  }>(
    dbRole,
    `SELECT count(DISTINCT e.session_id)::text                     AS sessions,
            count(*)::text                                        AS episodes,
            count(*) FILTER (WHERE e.role = 'human')::text         AS humans,
            count(*) FILTER (WHERE e.role = 'agent')::text         AS agents,
            min(e.occurred_at)                                     AS first,
            max(e.occurred_at)                                     AS last,
            array_remove(array_agg(DISTINCT e.git_branch), NULL)    AS branches
       FROM datum.episodes e
      WHERE e.scope = ANY($1::text[])`,
    [chain],
  );

  return {
    sessions: Number(row?.sessions ?? 0),
    episodes: Number(row?.episodes ?? 0),
    humans: Number(row?.humans ?? 0),
    agents: Number(row?.agents ?? 0),
    first: row?.first ?? null,
    last: row?.last ?? null,
    branches: row?.branches ?? [],
  };
}
