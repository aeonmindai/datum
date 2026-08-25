import { existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import { asRejection, Rejection } from "../src/domain/errors.js";
import { ingestClaudeDir, ingestClaudeTranscript, type IngestReport } from "../src/episodes/ingest.js";
import { episodeHash, recordEpisode, type EpisodeRow } from "../src/episodes/types.js";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";

/**
 * Episode ingest, against a real Postgres and against the real Arc transcripts.
 *
 * Nothing is stubbed. The properties under test are database properties — a unique hash, an
 * append-only trigger, an actor CHECK — so a fake would test nothing at all, and the corpus
 * counts below are only meaningful because they come off 668 MB of transcripts that were not
 * written for this test.
 */

const DB = "datum_episodes_ingest";
const SCOPE = "org/aeonmind/proj/arc";
const HUMAN = "human:jish";
const CORPUS = "/Users/jish/.claude/projects/-Users-jish-Documents-GitHub-arc";

let pg: TestPostgres;
let db: Db;
let tmp: string;

const haveCorpus = existsSync(CORPUS);

beforeAll(async () => {
  pg = await startPostgres();
  db = await pg.fork(DB);
  tmp = await mkdtemp(join(tmpdir(), "datum-episodes-"));
});

afterAll(async () => {
  await db?.close();
  await pg?.stop();
});

async function countSession(sessionId: string): Promise<number> {
  const row = await db.one<{ n: number }>(
    "app",
    "SELECT count(*)::int AS n FROM datum.episodes WHERE session_id = $1",
    [sessionId],
  );
  return row?.n ?? 0;
}

async function sessionRows(sessionId: string): Promise<EpisodeRow[]> {
  const { rows } = await db.query<EpisodeRow>(
    "app",
    `SELECT id, scope, session_id, seq, parent_id, occurred_at, actor, role, text,
            git_branch, git_commit, cwd, source, hash, ingested_at
       FROM datum.episodes WHERE session_id = $1 ORDER BY seq`,
    [sessionId],
  );
  return rows;
}

async function fixture(name: string, records: Array<Record<string, unknown>>): Promise<string> {
  const path = join(tmp, name);
  await writeFile(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  return path;
}

interface CorpusFile {
  path: string;
  bytes: number;
}

/** Corpus transcripts, smallest first. */
async function corpusFiles(): Promise<CorpusFile[]> {
  const names = (await readdir(CORPUS)).filter((n) => n.endsWith(".jsonl"));
  return names
    .map((n) => ({ path: join(CORPUS, n), bytes: statSync(join(CORPUS, n)).size }))
    .sort((a, b) => a.bytes - b.bytes);
}

describe("recordEpisode", () => {
  it("is idempotent on hash and returns the first writer's row", async () => {
    const session = "sess-idempotent";
    const input = {
      scope: SCOPE,
      session_id: session,
      seq: 0,
      occurred_at: "2026-08-20T10:00:00.000Z",
      actor: HUMAN,
      role: "human" as const,
      text: "we reached the 60-minute bake once, then model confusion happened",
      git_branch: "release/openrouter-ready",
      cwd: "/Users/jish/Documents/GitHub/arc",
      source: { kind: "manual", note: "typed by hand" },
    };

    const first = await recordEpisode(db, input);
    expect(first.created).toBe(true);
    expect(first.episode.git_branch).toBe("release/openrouter-ready");

    // A different `source` must NOT mint a second row: one sentence said once is one episode,
    // regardless of which file the bytes were later found in.
    const second = await recordEpisode(db, { ...input, source: { kind: "reimport" } });
    expect(second.created).toBe(false);
    expect(second.episode.id).toBe(first.episode.id);
    expect(await countSession(session)).toBe(1);
  });

  it("hashes the branch and cwd in, so the same words in two places are two moments", async () => {
    // "757.5" is indistinguishable from "757.5 on release/openrouter-ready" once a session is
    // compacted. The qualifier is the whole point of the row, so it is in the identity: two
    // bodies differing only in branch, or only in cwd, must not collapse into one episode.
    const body = {
      scope: SCOPE,
      session_id: "sess-branch",
      seq: 0,
      occurred_at: "2026-08-20T10:30:00.000Z",
      actor: HUMAN,
      role: "human" as const,
      text: "757.5",
      git_branch: "main",
      git_commit: null,
      cwd: "/Users/jish/Documents/GitHub/arc",
    };
    expect(episodeHash({ ...body, git_branch: "release/openrouter-ready" })).not.toBe(
      episodeHash(body),
    );
    expect(episodeHash({ ...body, cwd: "/Users/jish/Documents/GitHub/arc-worktree" })).not.toBe(
      episodeHash(body),
    );
    // The two moments really do land as two rows, not just two hashes.
    const a = await recordEpisode(db, { ...body, source: { kind: "manual" } });
    const b = await recordEpisode(db, {
      ...body,
      seq: 1,
      git_branch: "release/openrouter-ready",
      source: { kind: "manual" },
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(await countSession("sess-branch")).toBe(2);
  });

  it("refuses a malformed actor rather than rewriting it", async () => {
    const bad = recordEpisode(db, {
      scope: SCOPE,
      session_id: "sess-bad-actor",
      seq: 0,
      occurred_at: "2026-08-20T10:00:00.000Z",
      actor: "jish",
      role: "human",
      text: "who is speaking?",
      source: { kind: "manual" },
    });
    await expect(bad).rejects.toBeInstanceOf(Rejection);
    const err = (await bad.catch((e: unknown) => e)) as Rejection;
    expect(err.reason).toBe("malformed_request");
    expect(err.detail.constraint).toBe("episode_actor_shape");
    expect(err.sqlstate).toBe("23514");
    expect(await countSession("sess-bad-actor")).toBe(0);
  });

  it("refuses UPDATE and DELETE with episodes_are_immutable", async () => {
    const session = "sess-immutable";
    const { episode } = await recordEpisode(db, {
      scope: SCOPE,
      session_id: session,
      seq: 0,
      occurred_at: "2026-08-20T11:00:00.000Z",
      actor: HUMAN,
      role: "human",
      text: "this sentence cannot be edited later",
      source: { kind: "manual" },
    });

    // Owner, not app: as `app` the grant system refuses first and the trigger never runs, so
    // proving the trigger requires the most privileged role there is. Both layers must hold.
    const update = await db
      .query("owner", "UPDATE datum.episodes SET text = 'edited' WHERE id = $1", [episode.id])
      .then(() => null)
      .catch((e: unknown) => asRejection(e));
    expect(update?.detail.reason).toBe("episodes_are_immutable");

    const del = await db
      .query("owner", "DELETE FROM datum.episodes WHERE id = $1", [episode.id])
      .then(() => null)
      .catch((e: unknown) => asRejection(e));
    expect(del?.detail.reason).toBe("episodes_are_immutable");

    const survivor = await sessionRows(session);
    expect(survivor).toHaveLength(1);
    expect(survivor[0]?.text).toBe("this sentence cannot be edited later");
  });

  it("refuses UPDATE to the app role before any trigger runs", async () => {
    const err = await db
      .query("app", "UPDATE datum.episodes SET text = 'edited' WHERE session_id = $1", [
        "sess-immutable",
      ])
      .then(() => null)
      .catch((e: unknown) => asRejection(e));
    expect(err?.reason).toBe("insufficient_privilege");
  });
});

describe("ingestClaudeTranscript — synthetic transcripts", () => {
  it("threads a reply onto the record it replied to", async () => {
    const session = "sess-thread";
    const file = await fixture("thread.jsonl", [
      {
        type: "user",
        timestamp: "2026-08-20T12:00:00.000Z",
        sessionId: session,
        uuid: "u1",
        parentUuid: null,
        cwd: "/Users/jish/Documents/GitHub/arc",
        gitBranch: "main",
        message: { role: "user", content: "first thing I said" },
      },
      {
        type: "user",
        timestamp: "2026-08-20T12:01:00.000Z",
        sessionId: session,
        uuid: "u2",
        parentUuid: "u1",
        cwd: "/Users/jish/Documents/GitHub/arc",
        gitBranch: "main",
        message: { role: "user", content: [{ type: "text", text: "second thing I said" }] },
      },
      {
        type: "user",
        timestamp: "2026-08-20T12:02:00.000Z",
        sessionId: session,
        uuid: "u3",
        parentUuid: "u2",
        cwd: "/Users/jish/Documents/GitHub/arc",
        gitBranch: "main",
        message: { role: "user", content: "third thing I said" },
      },
    ]);

    const report = await ingestClaudeTranscript(db, { file, scope: SCOPE, humanActor: HUMAN });
    expect(report.episodes).toBe(3);
    expect(report.duplicates).toBe(0);
    expect(report.sessions).toBe(1);
    expect(report.byRole).toEqual({ human: 3 });

    const rows = await sessionRows(session);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(rows[0]?.parent_id).toBeNull();
    expect(rows[1]?.parent_id).toBe(rows[0]?.id);
    expect(rows[2]?.parent_id).toBe(rows[1]?.id);
    expect(rows[1]?.git_branch).toBe("main");
    expect(rows[1]?.cwd).toBe("/Users/jish/Documents/GitHub/arc");
    expect(rows[1]?.source).toMatchObject({ kind: "claude-code-transcript", uuid: "u2", line: 2 });
  });

  it("skips meta records, tool results, wrappers and empty text", async () => {
    const session = "sess-noise";
    const file = await fixture("noise.jsonl", [
      // Not speech: the harness warning the model about slash commands.
      {
        type: "user",
        timestamp: "2026-08-20T13:00:00.000Z",
        sessionId: session,
        uuid: "n1",
        parentUuid: null,
        isMeta: true,
        message: { role: "user", content: "<local-command-caveat>Caveat: ...</local-command-caveat>" },
      },
      // Not speech: a tool spoke, wearing the user's slot.
      {
        type: "user",
        timestamp: "2026-08-20T13:01:00.000Z",
        sessionId: session,
        uuid: "n2",
        parentUuid: "n1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      },
      // Not speech: an injected wrapper the user never typed.
      {
        type: "user",
        timestamp: "2026-08-20T13:02:00.000Z",
        sessionId: session,
        uuid: "n3",
        parentUuid: "n2",
        message: { role: "user", content: "<command-name>/model</command-name>" },
      },
      // Not speech: whitespace.
      {
        type: "user",
        timestamp: "2026-08-20T13:03:00.000Z",
        sessionId: session,
        uuid: "n4",
        parentUuid: "n3",
        message: { role: "user", content: "   \n  " },
      },
      // Speech.
      {
        type: "user",
        timestamp: "2026-08-20T13:04:00.000Z",
        sessionId: session,
        uuid: "n5",
        parentUuid: "n4",
        gitBranch: "perf/post-fix-sweep",
        message: { role: "user", content: "the 757.5 number was on the openrouter branch" },
      },
      // Machinery, not a candidate at all: neither user nor assistant.
      {
        type: "queue-operation",
        timestamp: "2026-08-20T13:05:00.000Z",
        sessionId: session,
        uuid: "n6",
        parentUuid: "n5",
      },
    ]);

    const report = await ingestClaudeTranscript(db, { file, scope: SCOPE, humanActor: HUMAN });
    expect(report.episodes).toBe(1);
    expect(report.skipped).toBe(4);
    expect(report.byRole).toEqual({ human: 1 });

    const rows = await sessionRows(session);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("the 757.5 number was on the openrouter branch");
    // seq is the record's ordinal in the session, not a count of episodes: the four skipped
    // records still consumed 0..3, so re-running with different options renumbers nothing.
    expect(rows[0]?.seq).toBe(4);
    // The parent was filtered out, so the episode is unthreaded rather than mis-threaded.
    expect(rows[0]?.parent_id).toBeNull();
  });

  it("leaves agent prose out unless asked, and does not renumber when asked", async () => {
    const session = "sess-agent";
    const file = await fixture("agent.jsonl", [
      {
        type: "user",
        timestamp: "2026-08-20T14:00:00.000Z",
        sessionId: session,
        uuid: "a1",
        parentUuid: null,
        message: { role: "user", content: "did the bake finish?" },
      },
      {
        type: "assistant",
        timestamp: "2026-08-20T14:00:30.000Z",
        sessionId: session,
        uuid: "a2",
        parentUuid: "a1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "it reached 60 minutes once" }],
        },
      },
      // The agent operating, not talking.
      {
        type: "assistant",
        timestamp: "2026-08-20T14:00:40.000Z",
        sessionId: session,
        uuid: "a3",
        parentUuid: "a2",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        },
      },
    ]);

    const humanOnly = await ingestClaudeTranscript(db, { file, scope: SCOPE, humanActor: HUMAN });
    expect(humanOnly.episodes).toBe(1);
    expect(humanOnly.byRole).toEqual({ human: 1 });
    expect(await countSession(session)).toBe(1);

    const withAgent = await ingestClaudeTranscript(db, {
      file,
      scope: SCOPE,
      humanActor: HUMAN,
      agentActor: "agent:claude-code",
      includeAgent: true,
    });
    // The human record comes back as already on record: turning agent prose on must not
    // renumber, and therefore must not duplicate, what was ingested without it.
    expect(withAgent.episodes).toBe(2);
    expect(withAgent.duplicates).toBe(1);
    expect(withAgent.byRole).toEqual({ human: 1, agent: 1 });
    expect(withAgent.skipped).toBe(1);

    const rows = await sessionRows(session);
    expect(rows.map((r) => [r.seq, r.role, r.actor])).toEqual([
      [0, "human", HUMAN],
      [1, "agent", "agent:claude-code"],
    ]);
    expect(rows[1]?.parent_id).toBe(rows[0]?.id);
  });

  it("stops at `limit` without renumbering what it already wrote", async () => {
    const session = "sess-limit";
    const records = [0, 1, 2, 3].map((n) => ({
      type: "user",
      timestamp: `2026-08-20T16:0${n}:00.000Z`,
      sessionId: session,
      uuid: `l${n}`,
      parentUuid: n === 0 ? null : `l${n - 1}`,
      message: { role: "user", content: `limited record ${n}` },
    }));
    const file = await fixture("limit.jsonl", records);

    const partial = await ingestClaudeTranscript(db, {
      file,
      scope: SCOPE,
      humanActor: HUMAN,
      limit: 2,
    });
    expect(partial.episodes).toBe(2);
    expect(await countSession(session)).toBe(2);

    const full = await ingestClaudeTranscript(db, { file, scope: SCOPE, humanActor: HUMAN });
    expect(full.episodes).toBe(4);
    expect(full.duplicates).toBe(2);
    expect(await countSession(session)).toBe(4);
  });

  it("refuses a malformed actor before it reads a byte of the file", async () => {
    const err = (await ingestClaudeTranscript(db, {
      file: join(tmp, "does-not-exist.jsonl"),
      scope: SCOPE,
      humanActor: "jish",
    }).catch((e: unknown) => e)) as Rejection;
    expect(err).toBeInstanceOf(Rejection);
    expect(err.reason).toBe("malformed_request");
    expect(err.detail.field).toBe("humanActor");
  });

  it("ingests every .jsonl in a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "datum-episodes-dir-"));
    for (const n of [1, 2]) {
      await writeFile(
        join(dir, `s${n}.jsonl`),
        `${JSON.stringify({
          type: "user",
          timestamp: `2026-08-20T15:0${n}:00.000Z`,
          sessionId: `sess-dir-${n}`,
          uuid: `d${n}`,
          parentUuid: null,
          message: { role: "user", content: `directory record ${n}` },
        })}\n`,
        "utf8",
      );
    }
    await writeFile(join(dir, "ignored.txt"), "not a transcript\n", "utf8");

    const reports = await ingestClaudeDir(db, { dir, scope: SCOPE, humanActor: HUMAN });
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.episodes)).toEqual([1, 1]);
    expect(await countSession("sess-dir-1")).toBe(1);
    expect(await countSession("sess-dir-2")).toBe(1);
  });
});

describe.skipIf(!haveCorpus)("ingestClaudeTranscript — the real Arc corpus", () => {
  it("finds no speech in the byte-smallest transcript, and is right about that", async () => {
    const files = await corpusFiles();
    const smallest = files[0];
    expect(smallest).toBeDefined();
    if (!smallest) return;

    const report = await ingestClaudeTranscript(db, {
      file: smallest.path,
      scope: SCOPE,
      humanActor: HUMAN,
    });
    // Measured, not assumed: this session is a single `/resume` that failed. Its three user
    // records are one isMeta caveat and two `<...>` wrappers. None of them is somebody
    // speaking, and an ingest reporting otherwise would be manufacturing testimony.
    expect(report.episodes).toBe(0);
    expect(report.skipped).toBe(3);
    console.log(`[corpus] byte-smallest ${smallest.bytes} B -> ${JSON.stringify(report)}`);
  });

  it("is stable when the smallest transcript containing speech is ingested twice", async () => {
    const files = await corpusFiles();
    let chosen: CorpusFile | null = null;
    let first: IngestReport | null = null;
    for (const f of files) {
      const report = await ingestClaudeTranscript(db, {
        file: f.path,
        scope: SCOPE,
        humanActor: HUMAN,
      });
      if (report.episodes > 0) {
        chosen = f;
        first = report;
        break;
      }
    }
    expect(chosen).not.toBeNull();
    expect(first).not.toBeNull();
    if (!chosen || !first) return;

    expect(first.episodes).toBeGreaterThan(0);
    expect(first.duplicates).toBe(0);
    const before = await db.one<{ n: number }>(
      "app",
      "SELECT count(*)::int AS n FROM datum.episodes",
    );

    const second = await ingestClaudeTranscript(db, {
      file: chosen.path,
      scope: SCOPE,
      humanActor: HUMAN,
    });
    const after = await db.one<{ n: number }>(
      "app",
      "SELECT count(*)::int AS n FROM datum.episodes",
    );

    expect(second.episodes).toBe(first.episodes);
    expect(second.duplicates).toBe(first.episodes);
    expect(after?.n).toBe(before?.n);
    console.log(
      `[corpus] smallest-with-speech ${chosen.bytes} B -> first ${JSON.stringify(first)} second ${JSON.stringify(second)} rows ${before?.n} -> ${after?.n}`,
    );
  });

  it("streams the 82 MB transcript instead of loading it", async () => {
    const files = await corpusFiles();
    const largest = files[files.length - 1];
    expect(largest).toBeDefined();
    if (!largest) return;

    const rssBefore = process.memoryUsage().rss;
    const started = Date.now();
    const report = await ingestClaudeTranscript(db, {
      file: largest.path,
      scope: SCOPE,
      humanActor: HUMAN,
    });
    const fullMs = Date.now() - started;
    const rssDelta = process.memoryUsage().rss - rssBefore;

    expect(report.episodes).toBeGreaterThan(400);
    expect(report.byRole.human).toBe(report.episodes);
    expect(report.duplicates).toBe(0);
    expect(report.sessions).toBe(1);

    // The decisive streaming evidence, and the reason it is a stopwatch rather than a memory
    // reading: RSS after parsing 33,850 JSON lines is dominated by uncollected garbage, so it
    // proves nothing either way. This does. The first genuine human utterance in this file is
    // on line 30 of 33,850; a `limit: 1` pass therefore touches the first few KB and stops. An
    // implementation that read the 82 MB in before filtering could not be an order of
    // magnitude faster here, because it would still have read the 82 MB.
    const quickStart = Date.now();
    const quick = await ingestClaudeTranscript(db, {
      file: largest.path,
      scope: SCOPE,
      humanActor: HUMAN,
      limit: 1,
    });
    const quickMs = Date.now() - quickStart;
    expect(quick.episodes).toBe(1);
    expect(quick.duplicates).toBe(1);
    expect(quickMs * 10).toBeLessThan(fullMs);

    console.log(
      `[corpus] largest ${largest.bytes} B -> ${report.episodes} human episodes, ${report.skipped} skipped, full pass ${fullMs} ms, limit-1 pass ${quickMs} ms, rss delta ${Math.round(rssDelta / 1024 / 1024)} MB`,
    );
  });

  it("recovers the whole corpus at the count the transcripts actually contain", async () => {
    const started = Date.now();
    const reports = await ingestClaudeDir(db, { dir: CORPUS, scope: SCOPE, humanActor: HUMAN });
    const ms = Date.now() - started;
    const total = reports.reduce((n, r) => n + r.episodes, 0);

    const rows = await db.one<{ n: number }>(
      "app",
      `SELECT count(*)::int AS n FROM datum.episodes
        WHERE source->>'kind' = 'claude-code-transcript' AND source->>'file' LIKE $1`,
      [`${CORPUS}/%`],
    );
    expect(total).toBe(rows?.n);
    console.log(
      `[corpus] whole directory -> ${total} human episodes across ${reports.length} files in ${ms} ms`,
    );
  });
});
