import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import { createMission } from "../src/domain/store.js";
import { recordEpisode, type EpisodeInput } from "../src/episodes/types.js";
import { resumeState, type ResumeState } from "../src/episodes/resume.js";
import { promote } from "./helpers/cases.js";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";

/**
 * "Where were we yesterday?", against a real Postgres.
 *
 * Nothing here is stubbed. The thing under test is a set of queries over an append-only table with
 * a trigger and a grant on it, so a fake would test nothing at all.
 *
 * The failure this closes is measured, not hypothetical: eight compaction events in eleven days of
 * Arc work, and re-orientation after one of them cost 49 tool calls and 51 minutes. Each test below
 * names the specific way a resume can lie — wrong session, stale thread, a question silently
 * dropped, an empty object where an explanation belongs — because a confidently wrong starting
 * point is worse than none.
 */

const ORG = "acme";
const PROJ = `org/${ORG}/proj/arc`;
const EMPTY = `org/${ORG}/proj/vacant`;
const LONELY = `org/${ORG}/proj/lonely`;

const OLD_SESSION = "9c1f0f2a-old-session";
const NEW_SESSION = "4d267202-new-session";
const LONELY_SESSION = "0b0b0b0b-lonely-session";

const HOUR = 3_600_000;
const AT = Date.now();

/** Seq 9 — the last human turn in the newer session, and nobody spoke after it. */
const UNANSWERED =
  "Should we ship stage-2 before the bake, or hold it for the release branch?";
/** Seq 0 — also a question, but the human spoke again at seq 3, so the thread moved past it. */
const ANSWERED = "Can we get the stage-2 kernel under 40 ms?";
/** Long, multi-line, and deliberately over the 200-char reminder budget. */
const LONG_TURN = [
  "Ran it three more times to be sure:",
  "  43.8 ms, 44.1 ms, 44.0 ms at batch 256 with the fused epilogue,",
  "  against 61.2 ms on the old path, which is the number that has been quoted in every",
  "  status update for the last week and is now dead.",
].join("\n");

let pg: TestPostgres;
let db: Db;

interface Turn {
  role: "human" | "agent";
  text: string;
}

const NEWER_TURNS: Turn[] = [
  { role: "human", text: ANSWERED },
  { role: "agent", text: "Measuring now — the current path is 61.2 ms at batch 256." },
  { role: "agent", text: "Rewrote the epilogue fusion; it lands at 44 ms." },
  { role: "human", text: "Good. Keep the fusion and delete the old path." },
  { role: "agent", text: "Old path deleted, bench still green." },
  { role: "agent", text: LONG_TURN },
  { role: "human", text: "Numbers look stable enough." },
  { role: "agent", text: "Pushed to perf/stage2." },
  { role: "agent", text: "CI is green on perf/stage2." },
  { role: "human", text: UNANSWERED },
];

const OLDER_TURNS: Turn[] = [
  { role: "human", text: "Kick off the bake on master." },
  { role: "agent", text: "Bake started." },
  { role: "human", text: "How long will the bake take?" },
];

function turn(
  scope: string,
  session: string,
  branch: string,
  seq: number,
  t: Turn,
  occurredAt: number,
): EpisodeInput {
  return {
    scope,
    session_id: session,
    seq,
    occurred_at: new Date(occurredAt),
    actor: t.role === "human" ? "human:jish" : "agent:claude",
    role: t.role,
    text: t.text,
    git_branch: branch,
    git_commit: "0".repeat(40),
    cwd: "/Users/jish/Documents/GitHub/arc",
    source: { kind: "claude-code-transcript", file: `${session}.jsonl`, line: seq + 1 },
  };
}

async function assertionCount(): Promise<number> {
  const row = await db.one<{ n: string }>("app", "SELECT count(*) AS n FROM datum.assertions");
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  pg = await startPostgres();
  db = await pg.fork("datum_resume");

  // Five days back, on master: the session a resume must not mistake for current work.
  for (const [i, t] of OLDER_TURNS.entries()) {
    await recordEpisode(db, turn(PROJ, OLD_SESSION, "master", i, t, AT - 120 * HOUR + i * 60_000));
  }
  // A few hours back, on perf/stage2: the session a resume must land on.
  for (const [i, t] of NEWER_TURNS.entries()) {
    await recordEpisode(
      db,
      turn(PROJ, NEW_SESSION, "perf/stage2", i, t, AT - 4 * HOUR + i * 5 * 60_000),
    );
  }
  await recordEpisode(
    db,
    turn(LONELY, LONELY_SESSION, "main", 0, { role: "agent", text: "Booted." }, AT - HOUR),
  );

  // One reached gate and one that only a named human can ever close. `promote` writes the
  // `measured` row the only legitimate way — through the verifier role, against a verification
  // record — so the reached gate is reached for the real reason.
  await promote(db, PROJ);
  await createMission(db, {
    scope: PROJ,
    statement: "Land stage-2 and get it signed off.",
    state: "active",
    gates: [
      {
        subject: "engine",
        predicate: "aggregate_tok_s_at_b256",
        op: ">=",
        target: 700,
        requires_confidence: "measured",
      },
      {
        subject: "release",
        predicate: "approved_by_jish",
        op: "=",
        target: true,
        requires_confidence: "confirmed-by-human",
      },
    ],
    asserted_by: "human:jish",
  });
  await createMission(db, {
    scope: PROJ,
    statement: "Finish the stage-1 kernel.",
    state: "closed",
    gates: [],
    asserted_by: "human:jish",
  });
}, 240_000);

afterAll(async () => {
  await db?.close();
  await pg?.stop();
});

describe("the session it resumes", () => {
  let state: ResumeState;

  beforeAll(async () => {
    state = await resumeState(db, { scope: PROJ });
  });

  it("lands on the newest session, not the loudest one", () => {
    expect(state.last_session).not.toBeNull();
    expect(state.last_session?.id).toBe(NEW_SESSION);
    expect(state.last_session?.episodes).toBe(10);
    expect(state.last_session?.branches).toEqual(["perf/stage2"]);
    expect(state.last_session?.started.getTime()).toBeLessThan(
      state.last_session?.ended.getTime() ?? 0,
    );
  });

  it("reports its age in hours so the caller can judge for itself", () => {
    expect(state.age_hours).not.toBeNull();
    expect(state.age_hours).toBeGreaterThan(3);
    expect(state.age_hours).toBeLessThan(4);
  });

  it("says nothing about drift when the thread is fresh and on one branch", () => {
    expect(state.drift).toBeNull();
    expect(state.note).toBeNull();
  });
});

describe("the thread", () => {
  it("is chronological, newest last", async () => {
    const { thread } = await resumeState(db, { scope: PROJ });
    expect(thread).toHaveLength(10);
    expect(thread[0]?.text).toBe(ANSWERED);
    expect(thread.at(-1)?.text).toBe(UNANSWERED);
    const times = thread.map((t) => t.occurred_at.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(thread[0]?.actor).toBe("human:jish");
    expect(thread[1]?.role).toBe("agent");
    expect(thread[0]?.git_branch).toBe("perf/stage2");
  });

  it("keeps the tail, not the head, when trimmed to limit", async () => {
    const { thread } = await resumeState(db, { scope: PROJ, limit: 4 });
    expect(thread).toHaveLength(4);
    expect(thread.map((t) => t.text)).toEqual([
      "Numbers look stable enough.",
      "Pushed to perf/stage2.",
      "CI is green on perf/stage2.",
      UNANSWERED,
    ]);
  });

  it("flattens and clips a turn to a reminder", async () => {
    const { thread } = await resumeState(db, { scope: PROJ });
    const long = thread.find((t) => t.text.startsWith("Ran it three more times"));
    expect(long).toBeDefined();
    expect(LONG_TURN.length).toBeGreaterThan(200);
    expect(long?.text).toHaveLength(200);
    expect(long?.text.endsWith("…")).toBe(true);
    expect(long?.text).not.toContain("\n");
  });
});

describe("open questions", () => {
  it("keeps the question nobody came back to and drops the one the human talked past", async () => {
    const { open_questions } = await resumeState(db, { scope: PROJ });
    expect(open_questions.map((q) => q.text)).toEqual([UNANSWERED]);
    expect(open_questions.map((q) => q.text)).not.toContain(ANSWERED);
    expect(open_questions[0]?.episode_id).toMatch(/^e_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(open_questions[0]?.occurred_at).toBeInstanceOf(Date);
  });

  it("is scoped to the resumed session, not the store", async () => {
    const { open_questions } = await resumeState(db, {
      scope: PROJ,
      session: OLD_SESSION,
    });
    // The older session ends on a human question, so this proves the query is session-scoped
    // rather than global: it returns that session's question, not the newer one's.
    expect(open_questions.map((q) => q.text)).toEqual(["How long will the bake take?"]);
  });
});

describe("missions", () => {
  it("counts gates and names the one only a human can close", async () => {
    const { missions } = await resumeState(db, { scope: PROJ });
    expect(missions).toHaveLength(1);
    expect(missions[0]?.statement).toBe("Land stage-2 and get it signed off.");
    expect(missions[0]?.state).toBe("active");
    expect(missions[0]?.gates_total).toBe(2);
    expect(missions[0]?.gates_reached).toBe(1);
    expect(missions[0]?.awaiting_human).toEqual(["release.approved_by_jish"]);
  });
});

describe("drift — an out-of-date resume presented as current is worse than none", () => {
  it("declares the thread stale when it is older than the bound", async () => {
    const state = await resumeState(db, { scope: PROJ, staleHours: 0 });
    expect(state.drift).not.toBeNull();
    expect(state.drift?.branch).toBe("perf/stage2");
    expect(state.drift?.note).toBe(
      `the last episode is ${state.age_hours?.toFixed(1)}h old, past the 0h bound` +
        " — treat this as stale, not as current state",
    );
  });

  it("declares branch drift when the resumed session is not where the work moved", async () => {
    const state = await resumeState(db, { scope: PROJ, session: OLD_SESSION });
    expect(state.last_session?.id).toBe(OLD_SESSION);
    expect(state.drift?.branch).toBe("master");
    // Five days old and on the wrong branch, so both limbs fire and are reported together.
    expect(state.drift?.note).toBe(
      "the resumed session was mostly on 'master' but the newest episode in scope is on" +
        " 'perf/stage2' — this thread may describe work already moved off; the last episode is" +
        ` ${state.age_hours?.toFixed(1)}h old, past the 24h bound — treat this as stale, not as` +
        " current state",
    );
  });
});

describe("a thin answer says so", () => {
  it("explains an empty scope instead of returning an empty object", async () => {
    const state = await resumeState(db, { scope: EMPTY });
    expect(state.last_session).toBeNull();
    expect(state.thread).toEqual([]);
    expect(state.open_questions).toEqual([]);
    expect(state.age_hours).toBeNull();
    expect(state.drift).toBeNull();
    expect(state.note).toBe(
      `no episodes recorded in ${EMPTY} or its ancestors — nothing to resume; 0 live mission(s) are all this scope knows`,
    );
  });

  it("explains a named session that does not exist", async () => {
    const state = await resumeState(db, { scope: PROJ, session: "no-such-session" });
    expect(state.last_session).toBeNull();
    expect(state.note).toBe(
      `no episodes recorded for session no-such-session in ${PROJ} or its ancestors — nothing to resume`,
    );
    // The missions still come back: they are true regardless of whether anyone talked.
    expect(state.missions).toHaveLength(1);
  });

  it("admits when the session is one agent talking to itself", async () => {
    const state = await resumeState(db, { scope: LONELY });
    expect(state.last_session?.episodes).toBe(1);
    expect(state.note).toBe(
      "this session is a single episode — there is no thread here, only one utterance; " +
        "no human turns in this session — everything below is an agent talking to itself",
    );
  });
});

describe("the invariant: a resume reads, it never promotes", () => {
  it("creates no assertion, whatever it was asked", async () => {
    const before = await assertionCount();
    await resumeState(db, { scope: PROJ });
    await resumeState(db, { scope: PROJ, session: OLD_SESSION, staleHours: 0, limit: 50 });
    await resumeState(db, { scope: EMPTY });
    await resumeState(db, { scope: LONELY });
    expect(await assertionCount()).toBe(before);
  });
});
