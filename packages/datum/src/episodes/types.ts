import type { Db, DbRole } from "../db/pool.js";
import { asRejection } from "../domain/errors.js";
import { newId, sha256Hex } from "../domain/identity.js";

/**
 * An episode is a record that an utterance occurred. It is not a claim about the world.
 *
 * Nothing in this file turns an episode into an assertion, and nothing ever should. The
 * database already forbids the dangerous half of that — a row whose evidence names an
 * episode cannot be `measured` or `derived` — but the reason there is no `promote()` here
 * is the other half: an automatic prose-to-fact path is how one audited memory deployment
 * accumulated 10,134 entries at 97.8% junk, 808 of them copies of a single invented
 * preference. Promotion is an explicit act by a person or an instrument, elsewhere.
 */

export interface EpisodeRow {
  id: string;
  scope: string;
  session_id: string;
  seq: number;
  parent_id: string | null;
  occurred_at: Date;
  actor: string;
  role: "human" | "agent" | "system";
  text: string;
  git_branch: string | null;
  git_commit: string | null;
  cwd: string | null;
  source: Record<string, unknown>;
  hash: string;
  ingested_at: Date;
}

export interface EpisodeInput {
  scope: string;
  session_id: string;
  seq: number;
  occurred_at: string | Date;
  actor: string;
  role: "human" | "agent" | "system";
  text: string;
  parent_id?: string | null;
  git_branch?: string | null;
  git_commit?: string | null;
  cwd?: string | null;
  source: Record<string, unknown> & { kind: string };
}

/**
 * `episode_fts` is absent on purpose: a BEFORE INSERT trigger owns that column, and a writer
 * that supplies its own tsvector is a writer whose search index can disagree with its text.
 */
const RETURNING = `
  id, scope, session_id, seq, parent_id, occurred_at, actor, role, text,
  git_branch, git_commit, cwd, source, hash, ingested_at`;

/** JSON with object keys sorted at every depth, so the hash is stable across writers. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

const toIso = (t: string | Date): string =>
  typeof t === "string" ? new Date(t).toISOString() : t.toISOString();

/**
 * The canonical body an episode's hash is taken over.
 *
 * `source` and `parent_id` are excluded. Two ingests of the same conversation may disagree
 * about which file on disk the bytes came from and about whether the parent record happened
 * to be in scope that run; they do not disagree about who said what, when, on which branch.
 * Including either would mint a second row for one utterance, which is the exact failure the
 * unique hash exists to prevent. `git_branch` and `cwd` ARE included, because the same
 * sentence said on two branches is two moments — that qualifier is the thing compaction
 * strips and the thing this table exists to keep.
 */
export interface EpisodeCanonicalBody {
  scope: string;
  session_id: string;
  seq: number;
  occurred_at: string;
  actor: string;
  role: string;
  text: string;
  git_branch: string | null;
  git_commit: string | null;
  cwd: string | null;
}

export function episodeHash(body: EpisodeCanonicalBody): string {
  return `sha256:${sha256Hex(canonicalize(body))}`;
}

export interface RecordEpisodeResult {
  episode: EpisodeRow;
  /** False when this exact utterance was already on record: ingest is idempotent by hash. */
  created: boolean;
}

/**
 * Append one episode, idempotently.
 *
 * There is no "does this hash exist?" lookup in front of the INSERT, for the same reason
 * `assertFact` has none: a pre-check reports success for content that never reached the
 * table's CHECK constraints, so a malformed actor or an empty utterance would be accepted
 * on the second call and refused on the first. The database decides on every path.
 */
export async function recordEpisode(
  db: Db,
  input: EpisodeInput,
  role: DbRole = "app",
): Promise<RecordEpisodeResult> {
  const body: EpisodeCanonicalBody = {
    scope: input.scope,
    session_id: input.session_id,
    seq: input.seq,
    occurred_at: toIso(input.occurred_at),
    actor: input.actor,
    role: input.role,
    text: input.text,
    git_branch: input.git_branch ?? null,
    git_commit: input.git_commit ?? null,
    cwd: input.cwd ?? null,
  };
  const hash = episodeHash(body);

  try {
    const inserted = await db.query<EpisodeRow>(
      role,
      `INSERT INTO datum.episodes
         (id, scope, session_id, seq, parent_id, occurred_at, actor, role, text,
          git_branch, git_commit, cwd, source, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
       ON CONFLICT (hash) DO NOTHING
       RETURNING ${RETURNING}`,
      [
        newId("e"),
        body.scope,
        body.session_id,
        body.seq,
        input.parent_id ?? null,
        body.occurred_at,
        body.actor,
        body.role,
        body.text,
        body.git_branch,
        body.git_commit,
        body.cwd,
        JSON.stringify(input.source),
        hash,
      ],
    );
    const row = inserted.rows[0];
    if (row) return { episode: row, created: true };
  } catch (err) {
    throw asRejection(err) ?? err;
  }

  // DO NOTHING swallowed the row, so this utterance is already on record. Re-select rather
  // than reconstruct it: the stored row carries the id and ingested_at of the first writer,
  // which is what a caller citing this episode has to reference.
  const existing = await db.one<EpisodeRow>(
    role,
    `SELECT ${RETURNING} FROM datum.episodes WHERE hash = $1`,
    [hash],
  );
  if (!existing) throw new Error(`episode ${hash} conflicted but could not be re-read`);
  return { episode: existing, created: false };
}
