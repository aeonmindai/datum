import type { Db, DbRole } from "../db/pool.js";
import { resolveChain } from "../domain/scope.js";
import { missions } from "../domain/store.js";
import type { EpisodeRow } from "./types.js";

/**
 * "Where were we yesterday?"
 *
 * A fresh session starts blind. The rules and the facts arrive — they are in the store — but the
 * thread of work does not, because it only ever existed in a conversation. Measured on the Arc
 * corpus: eight compaction events in eleven days, and re-orientation after one of them cost up to
 * 49 tool calls and 51 minutes before any new work happened. That is archaeology the store already
 * holds the bytes to prevent.
 *
 * Everything below is a read. No assertion is created, ever. An episode records that somebody
 * spoke, not that they were right, and the moment a resume path starts minting facts out of what
 * it read, this becomes the recall-to-re-extraction loop that put 808 copies of one invented
 * preference into a production store. Promotion stays an explicit act by a person or an instrument.
 *
 * The second rule here is that a thin answer says so. An out-of-date resume presented as current is
 * worse than no resume: it is a confident wrong starting point and the reader cannot tell. So
 * `drift`, `age_hours` and `note` are part of the contract, not decoration.
 */

export interface ResumeSession {
  id: string;
  started: Date;
  ended: Date;
  episodes: number;
  /** Every branch spoken on during the session, most-spoken first. */
  branches: string[];
}

export interface ResumeThreadEntry {
  actor: string;
  role: string;
  occurred_at: Date;
  text: string;
  git_branch: string | null;
}

export interface ResumeQuestion {
  episode_id: string;
  text: string;
  occurred_at: Date;
}

export interface ResumeMission {
  statement: string;
  state: string;
  gates_reached: number;
  gates_total: number;
  /** `subject.predicate` for each unreached gate only a human can close. */
  awaiting_human: string[];
}

export interface ResumeDrift {
  /** The branch the resumed thread was spoken on, which may not be the branch anyone is on now. */
  branch: string | null;
  note: string;
}

export interface ResumeState {
  scope: string;
  last_session: ResumeSession | null;
  thread: ResumeThreadEntry[];
  open_questions: ResumeQuestion[];
  missions: ResumeMission[];
  drift: ResumeDrift | null;
  age_hours: number | null;
  note: string | null;
}

export interface ResumeOptions {
  scope: string;
  /** Resume a named session rather than the most recent one. Still bounded by the scope chain. */
  session?: string | undefined;
  limit?: number | undefined;
  staleHours?: number | undefined;
}

const DEFAULT_LIMIT = 12;
const DEFAULT_STALE_HOURS = 24;
/** A reminder, not a transcript. Long enough to recognise a turn, short enough to read twelve. */
const TEXT_CHARS = 200;

type ThreadRow = Pick<EpisodeRow, "actor" | "role" | "occurred_at" | "text" | "git_branch">;
type QuestionRow = Pick<EpisodeRow, "id" | "text" | "occurred_at">;

interface SessionRow {
  session_id: string;
  started: Date;
  ended: Date;
  episodes: number;
  human_episodes: number;
  /** `EXTRACT` yields numeric, which pg hands back as a string to avoid losing precision. */
  age_hours: string;
}

/**
 * A transcript turn is multi-line and can run to thousands of characters. Flattening and clipping
 * is deliberately lossy: the caller is being reminded what was under discussion, and if it needs
 * an utterance verbatim it has the session id and can read the episodes themselves.
 */
function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TEXT_CHARS ? `${flat.slice(0, TEXT_CHARS - 1)}…` : flat;
}

export async function resumeState(
  db: Db,
  opts: ResumeOptions,
  role: DbRole = "app",
): Promise<ResumeState> {
  const limit = Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT));
  const staleHours = Math.max(0, opts.staleHours ?? DEFAULT_STALE_HOURS);
  const { chain } = await resolveChain(db, opts.scope, role);

  const live = (await missions(db, opts.scope, role))
    .filter((m) => m.state !== "closed")
    .map<ResumeMission>((m) => ({
      statement: m.statement,
      state: m.state,
      gates_reached: m.gates.filter((g) => g.reached === true).length,
      gates_total: m.gates.length,
      // A gate the verifier can close by itself is not waiting on anybody. A gate demanding
      // `confirmed-by-human` is the mission asking a named person a specific question, and that
      // is the one thing a resume should put in front of them before anything else.
      awaiting_human: m.gates
        .filter((g) => g.reached !== true && g.requires_confidence === "confirmed-by-human")
        .map((g) => `${g.subject}.${g.predicate}`),
    }));

  const session = await db.one<SessionRow>(
    role,
    `SELECT session_id,
            min(occurred_at) AS started,
            max(occurred_at) AS ended,
            count(*)::int AS episodes,
            count(*) FILTER (WHERE role = 'human')::int AS human_episodes,
            EXTRACT(EPOCH FROM (now() - max(occurred_at))) / 3600.0 AS age_hours
       FROM datum.episodes
      WHERE scope = ANY($1::text[])
        AND ($2::text IS NULL OR session_id = $2)
      GROUP BY session_id
      ORDER BY max(occurred_at) DESC
      LIMIT 1`,
    [chain, opts.session ?? null],
  );

  if (!session) {
    return {
      scope: opts.scope,
      last_session: null,
      thread: [],
      open_questions: [],
      missions: live,
      drift: null,
      age_hours: null,
      note: opts.session
        ? `no episodes recorded for session ${opts.session} in ${opts.scope} or its ancestors — nothing to resume`
        : `no episodes recorded in ${opts.scope} or its ancestors — nothing to resume; ${live.length} live mission(s) are all this scope knows`,
    };
  }

  const [branchRows, threadRows, questionRows, newest] = await Promise.all([
    db.query<{ git_branch: string; n: number }>(
      role,
      `SELECT git_branch, count(*)::int AS n
         FROM datum.episodes
        WHERE session_id = $1 AND git_branch IS NOT NULL
        GROUP BY git_branch
        ORDER BY count(*) DESC, git_branch ASC`,
      [session.session_id],
    ),
    // `seq` rather than `occurred_at`: it is the position within the session as ingested, so it
    // orders turns that share a timestamp — which transcript exports produce constantly.
    db.query<ThreadRow>(
      role,
      `SELECT actor, role, occurred_at, text, git_branch
         FROM datum.episodes
        WHERE session_id = $1
        ORDER BY seq DESC
        LIMIT $2`,
      [session.session_id, limit],
    ),
    // The "unfinished" signal, and it is a heuristic: a human turn ending in '?' that no later
    // human turn in the session follows. One indexed query, no model, and honest about what it
    // knows — that the last thing the human did was ask something. Its limits, plainly: a question
    // the agent answered perfectly still shows up if the human then went to lunch; "tell me why X"
    // is missed for want of a '?'; and since "a human spoke again" is the only close signal
    // available without judging the reply, at most one question per session can ever qualify.
    // A pointer, not a verdict.
    db.query<QuestionRow>(
      role,
      `SELECT e.id, e.text, e.occurred_at
         FROM datum.episodes e
        WHERE e.session_id = $1
          AND e.role = 'human'
          AND right(btrim(e.text), 1) = '?'
          AND NOT EXISTS (
            SELECT 1 FROM datum.episodes later
             WHERE later.session_id = e.session_id
               AND later.role = 'human'
               AND later.seq > e.seq
          )
        ORDER BY e.seq`,
      [session.session_id],
    ),
    db.one<{ session_id: string; git_branch: string | null }>(
      role,
      `SELECT session_id, git_branch
         FROM datum.episodes
        WHERE scope = ANY($1::text[])
        ORDER BY occurred_at DESC, seq DESC
        LIMIT 1`,
      [chain],
    ),
  ]);

  const branches = branchRows.rows.map((r) => r.git_branch);
  const dominant = branches[0] ?? null;
  const ageHours = Math.round(Number(session.age_hours) * 100) / 100;

  const drifts: string[] = [];
  if (newest?.git_branch && dominant && newest.git_branch !== dominant) {
    drifts.push(
      `the resumed session was mostly on '${dominant}' but the newest episode in scope is on '${newest.git_branch}' — this thread may describe work already moved off`,
    );
  }
  if (ageHours > staleHours) {
    drifts.push(
      `the last episode is ${ageHours.toFixed(1)}h old, past the ${staleHours}h bound — treat this as stale, not as current state`,
    );
  }

  const notes: string[] = [];
  if (session.episodes === 1) {
    notes.push("this session is a single episode — there is no thread here, only one utterance");
  }
  if (session.human_episodes === 0) {
    notes.push("no human turns in this session — everything below is an agent talking to itself");
  }

  return {
    scope: opts.scope,
    last_session: {
      id: session.session_id,
      started: session.started,
      ended: session.ended,
      episodes: session.episodes,
      branches,
    },
    thread: threadRows.rows.reverse().map((r) => ({
      actor: r.actor,
      role: r.role,
      occurred_at: r.occurred_at,
      text: shorten(r.text),
      git_branch: r.git_branch,
    })),
    // Not shortened: a clipped question is a question the reader has to go and look up anyway.
    open_questions: questionRows.rows.map((r) => ({
      episode_id: r.id,
      text: r.text,
      occurred_at: r.occurred_at,
    })),
    missions: live,
    drift: drifts.length > 0 ? { branch: dominant, note: drifts.join("; ") } : null,
    age_hours: ageHours,
    note: notes.length > 0 ? notes.join("; ") : null,
  };
}
