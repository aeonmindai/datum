import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import {
  episodeStats,
  getSession,
  searchEpisodes,
  type EpisodeHit,
} from "../src/episodes/read.js";
import { recordEpisode } from "../src/episodes/types.js";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";

/**
 * Reading back what was said, against a real Postgres.
 *
 * Nothing here is stubbed: the tiering under test is a claim about a GIN full-text index, a trigram
 * index and a `word_similarity` cutoff, so a fake would test nothing at all. The sentence in the
 * fixture — "we reached the 60-minute bake once, then model confusion happened" — is the real one
 * from the Arc corpus that existed in no file, no commit and no note.
 *
 * Every search case asserts the tier as well as the row, because a caller that cannot tell an exact
 * hit from a fuzzy one has been handed a guess dressed as a quote.
 */

const ORG = "acme";
const ROOT = `org/${ORG}`;
const PROJ = `${ROOT}/proj/arc`;

const S1 = "sess-arc-1";
const S2 = "sess-arc-2";
const S_ORG = "sess-org-1";

const MAIN = "main";
const RELEASE = "release/openrouter-ready";

const HUMAN = "human:jish";
const AGENT = "agent:claude";

const BAKE = "we reached the 60-minute bake once, then model confusion happened";
const GEMM = "we tried qtip2b_grouped_gemm on the M5 and it was slow";

interface Turn {
  scope?: string;
  session: string;
  seq: number;
  actor: string;
  role: "human" | "agent" | "system";
  text: string;
  branch?: string | null;
}

const TURNS: Turn[] = [
  { session: S1, seq: 0, actor: HUMAN, role: "human", text: "where did we land on the tokenizer rewrite" },
  { session: S1, seq: 1, actor: AGENT, role: "agent", text: GEMM },
  { session: S1, seq: 2, actor: HUMAN, role: "human", text: BAKE },
  { session: S1, seq: 3, actor: AGENT, role: "agent", text: "noted, I will write that into the mission record" },
  { session: S1, seq: 4, actor: HUMAN, role: "human", text: "keep the grouped matmul kernel out of the hot path" },
  { session: S1, seq: 5, actor: AGENT, role: "agent", text: "bake times are irrelevant to the tokenizer work" },
  { session: S1, seq: 6, actor: HUMAN, role: "human", text: "ship it" },

  { session: S2, seq: 0, actor: HUMAN, role: "human", text: "switched the runner to release/openrouter-ready", branch: RELEASE },
  { session: S2, seq: 1, actor: AGENT, role: "agent", text: "757.5 tokens per second on that branch", branch: RELEASE },
  { session: S2, seq: 2, actor: HUMAN, role: "human", text: "confirm the number before it goes in the deck", branch: RELEASE },
  { session: S2, seq: 3, actor: AGENT, role: "agent", text: "confirmed against the log", branch: RELEASE },

  {
    scope: ROOT,
    session: S_ORG,
    seq: 0,
    actor: HUMAN,
    role: "human",
    text: "org policy: every number in a deck needs a receipt",
    branch: null,
  },
];

const EPOCH = Date.UTC(2026, 7, 11, 9, 0, 0);

let pg: TestPostgres;
let db: Db;

/** Reported verbatim in the yield, so the numbers in the report are the numbers that ran. */
const observed: Record<string, string> = {};

const record = (h: EpisodeHit): string =>
  `matched=${h.matched} rank=${h.rank.toFixed(6)} seq=${h.episode.seq} session=${h.episode.session_id}`;

beforeAll(async () => {
  pg = await startPostgres();
  db = await pg.fork("datum_episodes_read");
  observed["postgres"] = `${pg.version} in container ${pg.container}`;

  let n = 0;
  for (const t of TURNS) {
    await recordEpisode(db, {
      scope: t.scope ?? PROJ,
      session_id: t.session,
      seq: t.seq,
      occurred_at: new Date(EPOCH + n++ * 60_000).toISOString(),
      actor: t.actor,
      role: t.role,
      text: t.text,
      git_branch: t.branch === undefined ? MAIN : t.branch,
      git_commit: null,
      cwd: "/Users/jish/Documents/GitHub/arc",
      source: { kind: "claude-code-transcript", file: `${t.session}.jsonl` },
    });
  }
}, 180_000);

afterAll(async () => {
  await db?.close();
  await pg?.stop();
  if (Object.keys(observed).length > 0) {
    console.log(`\nobserved tiers:\n${Object.entries(observed).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`);
  }
});

describe("episode fixture", () => {
  it("loaded twelve episodes across three sessions, and re-ingest is a no-op", async () => {
    const stats = await episodeStats(db, PROJ);
    expect(stats.episodes).toBe(12);
    expect(stats.sessions).toBe(3);

    const again = await recordEpisode(db, {
      scope: PROJ,
      session_id: S1,
      seq: 2,
      occurred_at: new Date(EPOCH + 2 * 60_000).toISOString(),
      actor: HUMAN,
      role: "human",
      text: BAKE,
      git_branch: MAIN,
      git_commit: null,
      cwd: "/Users/jish/Documents/GitHub/arc",
      source: { kind: "claude-code-transcript", file: "re-run.jsonl" },
    });
    expect(again.created).toBe(false);
    expect((await episodeStats(db, PROJ)).episodes).toBe(12);
  });
});

describe("searchEpisodes tiering", () => {
  it("an exact phrase is an exact hit, and says so", async () => {
    const hits = await searchEpisodes(db, { scope: PROJ, text: "60-minute bake" });
    const phrase = hits.filter((h) => h.matched === "phrase");

    expect(phrase).toHaveLength(1);
    expect(phrase[0]?.episode.text).toBe(BAKE);
    expect(phrase[0]?.rank).toBe(1);
    expect(hits[0]?.matched).toBe("phrase");
    observed["60-minute bake"] = record(hits[0]!);

    // The other direction: the sentence that shares only the word "bake" is not an exact hit.
    const other = hits.find((h) => h.episode.text.startsWith("bake times"));
    expect(other?.matched ?? "absent").not.toBe("phrase");
  });

  it("a code identifier is findable despite English tokenisation", async () => {
    const hits = await searchEpisodes(db, { scope: PROJ, text: "qtip2b_grouped_gemm" });
    const hit = hits.find((h) => h.episode.text === GEMM);

    expect(hit).toBeDefined();
    observed["qtip2b_grouped_gemm"] = record(hit!);
    expect(hit?.matched).toBe("phrase");
    expect(hits[0]?.episode.text).toBe(GEMM);
  });

  it("a misspelled identifier is rescued by trigram, and the caller is told it was fuzzy", async () => {
    const hits = await searchEpisodes(db, { scope: PROJ, text: "qtip2b_gruoped" });

    expect(hits).not.toHaveLength(0);
    observed["qtip2b_gruoped (misspelling)"] = record(hits[0]!);
    expect(hits[0]?.episode.text).toBe(GEMM);
    expect(hits[0]?.matched).toBe("trigram");
    // Fuzzy, therefore ranked below 1: nothing here may masquerade as an exact hit.
    expect(hits[0]!.rank).toBeGreaterThan(0);
    expect(hits[0]!.rank).toBeLessThan(1);
    // The rescue tier is a rescue, not a dragnet: the sentence sharing only "grouped" stays out.
    expect(hits.some((h) => h.episode.text.includes("grouped matmul"))).toBe(false);
  });

  it("full text still earns its tier when no exact substring exists", async () => {
    // "confusion happened" is present verbatim; "confusing happens" is not, and only survives
    // English stemming.
    const hits = await searchEpisodes(db, { scope: PROJ, text: "confusing happens" });
    const hit = hits.find((h) => h.episode.text === BAKE);

    expect(hit).toBeDefined();
    expect(hit?.matched).toBe("fts");
    expect(hit!.rank).toBeGreaterThan(0);
    observed["confusing happens (stemmed)"] = record(hit!);
  });

  it("no text at all is a filter, not a ranked search", async () => {
    const hits = await searchEpisodes(db, { scope: PROJ, session: S2 });
    expect(hits).toHaveLength(4);
    expect(hits.every((h) => h.matched === "filter")).toBe(true);
    expect(hits.every((h) => h.rank === 0)).toBe(true);
    // Newest first when there is no relevance to order by.
    expect(hits[0]?.episode.seq).toBe(3);
  });
});

describe("searchEpisodes filters", () => {
  it("branch narrows both ways", async () => {
    const release = await searchEpisodes(db, { scope: PROJ, branch: RELEASE, limit: 50 });
    expect(release).toHaveLength(4);
    expect(release.every((h) => h.episode.git_branch === RELEASE)).toBe(true);

    const main = await searchEpisodes(db, { scope: PROJ, branch: MAIN, limit: 50 });
    expect(main).toHaveLength(7);
    expect(main.every((h) => h.episode.git_branch === MAIN)).toBe(true);

    // The qualifier compaction strips: the same word on two branches is two different statements.
    const bakeOnRelease = await searchEpisodes(db, {
      scope: PROJ,
      text: "60-minute bake",
      branch: RELEASE,
    });
    expect(bakeOnRelease).toHaveLength(0);
  });

  it("actor narrows both ways", async () => {
    const humans = await searchEpisodes(db, { scope: PROJ, actor: HUMAN, limit: 50 });
    const agents = await searchEpisodes(db, { scope: PROJ, actor: AGENT, limit: 50 });

    expect(humans).toHaveLength(7);
    expect(humans.every((h) => h.episode.actor === HUMAN)).toBe(true);
    expect(agents).toHaveLength(5);
    expect(agents.every((h) => h.episode.actor === AGENT)).toBe(true);

    const said = await searchEpisodes(db, { scope: PROJ, text: "qtip2b_grouped_gemm", actor: HUMAN });
    expect(said).toHaveLength(0);
  });

  it("since and until bracket the window", async () => {
    const from = new Date(EPOCH + 7 * 60_000).toISOString();
    const hits = await searchEpisodes(db, { scope: PROJ, since: from, limit: 50 });
    expect(hits).toHaveLength(5);
    expect(hits.every((h) => h.episode.occurred_at.getTime() >= EPOCH + 7 * 60_000)).toBe(true);

    const upTo = await searchEpisodes(db, { scope: PROJ, until: from, limit: 50 });
    expect(upTo).toHaveLength(8);
  });

  it("a query at a project also sees what was said at the org, but not the reverse", async () => {
    const fromProject = await searchEpisodes(db, { scope: PROJ, text: "org policy" });
    expect(fromProject).toHaveLength(1);
    expect(fromProject[0]?.episode.scope).toBe(ROOT);
    expect(fromProject[0]?.matched).toBe("phrase");
    observed["org policy (inherited scope)"] = record(fromProject[0]!);

    const fromOrg = await searchEpisodes(db, { scope: ROOT, text: "60-minute bake" });
    expect(fromOrg).toHaveLength(0);
  });
});

describe("getSession", () => {
  it("returns a conversation in seq order", async () => {
    const rows = await getSession(db, S1);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(rows[2]?.text).toBe(BAKE);
  });

  it("around returns a contiguous window centred on the hit", async () => {
    const rows = await getSession(db, S1, { around: 3, limit: 5 });
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);

    // A hit at either end still comes back with a full window, re-centred rather than truncated.
    expect((await getSession(db, S1, { around: 0, limit: 5 })).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
    expect((await getSession(db, S1, { around: 6, limit: 5 })).map((r) => r.seq)).toEqual([2, 3, 4, 5, 6]);
  });

  it("survives a hole in the transcript", async () => {
    await recordEpisode(db, {
      scope: PROJ,
      session_id: S1,
      seq: 40,
      occurred_at: new Date(EPOCH + 40 * 60_000).toISOString(),
      actor: HUMAN,
      role: "human",
      text: "picking this back up after the weekend",
      git_branch: MAIN,
      git_commit: null,
      cwd: "/Users/jish/Documents/GitHub/arc",
      source: { kind: "claude-code-transcript", file: `${S1}.jsonl` },
    });

    const rows = await getSession(db, S1, { around: 40, limit: 4 });
    expect(rows.map((r) => r.seq)).toEqual([4, 5, 6, 40]);
  });
});

describe("episodeStats", () => {
  it("counts what a reader at this scope can see", async () => {
    const proj = await episodeStats(db, PROJ);
    expect(proj.episodes).toBe(13); // the hole-in-the-transcript turn landed above
    expect(proj.sessions).toBe(3);
    expect(proj.humans).toBe(8);
    expect(proj.agents).toBe(5);
    expect(proj.branches).toEqual([MAIN, RELEASE]);
    expect(proj.first?.toISOString()).toBe(new Date(EPOCH).toISOString());
    expect(proj.last?.toISOString()).toBe(new Date(EPOCH + 40 * 60_000).toISOString());

    // Inheritance points one way only: the org does not absorb its projects' conversations.
    const org = await episodeStats(db, ROOT);
    expect(org.episodes).toBe(1);
    expect(org.sessions).toBe(1);
    expect(org.branches).toEqual([]);
  });

  it("reports a scope with no conversation as empty rather than guessing", async () => {
    // A sibling org, so nothing in the fixture's chain is in scope. `org/acme/proj/anything` would
    // still inherit the org-level turn, which is the feature, not an empty result.
    const empty = await episodeStats(db, "org/other");
    expect(empty).toEqual({
      sessions: 0,
      episodes: 0,
      humans: 0,
      agents: 0,
      first: null,
      last: null,
      branches: [],
    });
  });
});
