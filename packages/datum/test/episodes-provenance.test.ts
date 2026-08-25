import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import type { Db } from "../src/db/pool.js";
import { ingestClaudeTranscript } from "../src/episodes/ingest.js";

/**
 * Who typed it is not the same question as who wrote it.
 *
 * Measured on the real Arc corpus: 23 of 550 human utterances carry 83.4% of its entire volume,
 * and every one of them is machine-authored prose arriving in the user's slot. Eight are compaction
 * summaries. The rest are the human pasting the agent's own output back in to argue with it - and
 * one of those pastes carries an invented "9,000 GPU instructions issued per token" which the store
 * would otherwise return as testimony from a named human.
 *
 * That is the 808-duplicate failure with a person standing in the loop instead of a re-extractor,
 * and attribution alone cannot see it: `actor` is correct, and the provenance is still wrong. So
 * the ingest path records the signal and read paths label it. This file is the proof, because the
 * detector is a heuristic and a heuristic with no test is a rumour.
 */

let pg: TestPostgres;
let db: Db;
let dir: string;

beforeAll(async () => {
  pg = await startPostgres();
  db = await pg.fork("episodes_provenance");
  dir = await mkdtemp(join(tmpdir(), "prov-"));
}, 300_000);

afterAll(async () => {
  await db?.close().catch(() => {});
  await pg?.stop();
});

interface Turn {
  role: "user" | "assistant";
  text: string;
}

async function transcript(name: string, turns: Turn[]): Promise<string> {
  const file = join(dir, `${name}.jsonl`);
  const lines = turns.map((t, i) =>
    JSON.stringify({
      type: t.role === "user" ? "user" : "assistant",
      timestamp: new Date(Date.UTC(2026, 7, 20, 12, i)).toISOString(),
      sessionId: name,
      uuid: `${name}-${i}`,
      parentUuid: i === 0 ? null : `${name}-${i - 1}`,
      cwd: "/repo",
      gitBranch: "main",
      message: { role: t.role, content: t.text },
    }),
  );
  await writeFile(file, `${lines.join("\n")}\n`);
  return file;
}

async function ingest(name: string, turns: Turn[]): Promise<void> {
  await ingestClaudeTranscript(db, {
    file: await transcript(name, turns),
    scope: "org/acme",
    humanActor: "human:jish",
  });
}

async function sourceOf(session: string, seq: number): Promise<Record<string, unknown>> {
  const row = await db.one<{ source: Record<string, unknown> }>(
    "app",
    `SELECT source FROM datum.episodes WHERE session_id = $1 AND seq = $2`,
    [session, seq],
  );
  return row?.source ?? {};
}

// A real invented figure, quoted back verbatim the way it happens in the corpus.
const INVENTED =
  "The kernel issues 9,000 GPU instructions per token where the competition issues 10-30, " +
  "which is the single-user story and the reason the bake budget holds at 83.7 seconds a layer.";

describe("a quote-back is labelled, not laundered", () => {
  it("marks a short human turn that repeats the agent's words verbatim", async () => {
    // 203 characters in the real case: far too short to judge statistically, and exactly the
    // record that matters. An exact twelve-word run is not a coincidence.
    await ingest("short-quote", [
      { role: "user", text: "why is single-user throughput so bad?" },
      { role: "assistant", text: INVENTED },
      { role: "user", text: `${INVENTED} -> I think you're chasing the wrong thing.` },
    ]);
    const src = await sourceOf("short-quote", 2);
    expect(src["echoes_agent_verbatim"]).toBe(true);
  });

  it("leaves a human's own sentence unmarked, however emphatic", async () => {
    // The control. A detector that flags everything is not a detector, and the whole value of
    // the label is that its absence means something.
    await ingest("own-words", [
      { role: "assistant", text: INVENTED },
      { role: "user", text: "you said 600 tok/s how is now that 40?" },
      { role: "user", text: "84% and essentially settled??? you promised me 90+" },
    ]);
    for (const seq of [1, 2]) {
      const src = await sourceOf("own-words", seq);
      expect(src["echoes_agent_verbatim"]).toBeUndefined();
      expect(src["quoted_from_agent"]).toBeUndefined();
      expect(src["machine_prose"]).toBeUndefined();
    }
  });

  it("marks a long prose paste, which structure alone cannot see", async () => {
    // The largest human utterance in the real corpus is 24,726 characters of the agent's own
    // paragraphs, with no table, no arrow and no heading anywhere in it. Structural tests miss
    // it completely; verbatim overlap does not.
    const prose = Array.from(
      { length: 40 },
      (_, i) =>
        `Paragraph ${i}: the dequantisation path re-materialises the pair on every access, which ` +
        `costs a measured 53% of batch GPU time and is issue-bound rather than bandwidth-bound.`,
    ).join("\n\n");
    await ingest("long-paste", [
      { role: "assistant", text: prose },
      { role: "user", text: `this is what you said before the compaction: ${prose}` },
    ]);
    const src = await sourceOf("long-paste", 1);
    expect(Number(src["quoted_from_agent"])).toBeGreaterThan(0.2);
  });

  it("marks a pasted table even when the agent never said it", async () => {
    // Structure earns its keep here: a table pasted from a file has no counterpart in the
    // conversation, so verbatim overlap finds nothing and the shape is the only signal.
    const table = Array.from(
      { length: 24 },
      (_, i) => `| metric_${i} | ${i * 7} tok/s | release/openrouter-ready |`,
    ).join("\n");
    await ingest("pasted-table", [
      { role: "user", text: `here are the numbers\n\n${table}\n\n## Summary\n- **all of them**` },
    ]);
    const src = await sourceOf("pasted-table", 0);
    const machine = src["machine_prose"] as { ratio: number; markers: string[] } | undefined;
    expect(machine).toBeDefined();
    expect(machine?.markers).toContain("table");
  });

  it("does not flag a long human turn that is genuinely a person writing", async () => {
    // The false-positive control, and the one that decides whether the label is trustworthy.
    // Long-winded is not the same as pasted, and a person who writes an arrow is still a person.
    const rant =
      "I want you to stop guessing and make a flowchart of every checkpoint a token passes " +
      "through, because right now nobody can tell me where the time goes and I am tired of " +
      "asking. Do not trade capacity for latency -> that rule does not bend. If you cannot " +
      "measure it then say so plainly instead of inventing a number, and if the bake takes two " +
      "hours then it takes two hours and we plan around it rather than pretending otherwise. " +
      "I would rather have five real numbers than fifty confident ones, and I have said this " +
      "enough times now that it should not need repeating again in this session or the next.";
    await ingest("human-rant", [
      { role: "assistant", text: INVENTED },
      { role: "user", text: rant },
    ]);
    const src = await sourceOf("human-rant", 1);
    expect(src["echoes_agent_verbatim"]).toBeUndefined();
    expect(src["quoted_from_agent"]).toBeUndefined();
    expect(src["machine_prose"]).toBeUndefined();
  });

  it("excludes a compaction summary outright, rather than labelling it", async () => {
    // Different treatment on purpose. A quote-back is something a person chose to say; a
    // compaction summary is a document that has already lost its qualifiers, arriving in the
    // user's slot without anybody uttering it. Storing it labelled would still let 21k characters
    // of provenance-free prose outrank real sentences on every search.
    const file = join(dir, "compacted.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({
        type: "user",
        isCompactSummary: true,
        timestamp: "2026-08-20T12:00:00.000Z",
        sessionId: "compacted",
        uuid: "c-0",
        cwd: "/repo",
        gitBranch: "main",
        message: { role: "user", content: `Summary: ${INVENTED}` },
      })}\n${JSON.stringify({
        type: "user",
        timestamp: "2026-08-20T12:01:00.000Z",
        sessionId: "compacted",
        uuid: "c-1",
        cwd: "/repo",
        gitBranch: "main",
        message: { role: "user", content: "carry on then" },
      })}\n`,
    );
    const report = await ingestClaudeTranscript(db, {
      file,
      scope: "org/acme",
      humanActor: "human:jish",
    });
    expect(report.episodes).toBe(1);
    expect(report.skipped).toBe(1);
    const rows = await db.query<{ text: string }>(
      "app",
      `SELECT text FROM datum.episodes WHERE session_id = 'compacted'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.text).toBe("carry on then");
  });
});
