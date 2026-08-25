import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import type { Db } from "../src/db/pool.js";
import { assertFact } from "../src/domain/store.js";
import { recordEpisode } from "../src/episodes/types.js";
import { whyPath, whySymbol, type WhyMention } from "../src/episodes/why.js";
import { ingestGraph } from "../src/graph/store.js";
import type { GraphArtifact } from "../src/graph/types.js";

/**
 * "Why is this code like this?" against a real Postgres.
 *
 * Nothing here is stubbed. The tiering, the word boundaries and the scope chain are all decided in
 * SQL, so a fake database would test the shape of this file and none of the behaviour that matters.
 *
 * The fixture is deliberately shaped like the real corpus rather than like a happy path. The
 * episode that carries the actual reason names the file by basename only — `gemv_wide.rs`, never
 * `mistralrs-quant/src/blockwise_fp8/gemv_wide.rs` — because that is what a human types in chat,
 * and a query that only matched full paths would find nothing while looking successful. One symbol
 * name appears in two files, because on real code it does. And one episode says `gemv_wide_v2`,
 * which must NOT come back as a mention of `gemv_wide`.
 */

const DB = "datum_episodes_why";
const SCOPE = "test/arc";
const REPO = "aeonmind/arc";
const WIDE = "mistralrs-quant/src/blockwise_fp8/gemv_wide.rs";

let pg: TestPostgres;
let db: Db;

/** Recorded so the report can quote what the implementation actually said, not a paraphrase. */
const notes: Record<string, string | null> = {};

const artifact: GraphArtifact = {
  version: 1,
  repo: REPO,
  commit_sha: "beef1234cafe",
  indexer: "test/1",
  languages: ["rust"],
  file_count: 3,
  symbols: [
    {
      key: `${WIDE}#118:function:gemv_wide`,
      kind: "function",
      name: "gemv_wide",
      fqn: "mistralrs_quant::blockwise_fp8::gemv_wide",
      language: "rust",
      path: WIDE,
      line_start: 118,
      line_end: 190,
    },
    // The same name in two files. This is the ambiguity, and it is not contrived: `dequant` is a
    // per-quantisation-scheme routine, so every scheme has one.
    {
      key: "mistralrs-quant/src/blockwise_fp8/dequant.rs#42:function:dequant",
      kind: "function",
      name: "dequant",
      fqn: "mistralrs_quant::blockwise_fp8::dequant",
      language: "rust",
      path: "mistralrs-quant/src/blockwise_fp8/dequant.rs",
      line_start: 42,
      line_end: 77,
    },
    {
      key: "mistralrs-quant/src/hqq/dequant.rs#90:function:dequant",
      kind: "function",
      name: "dequant",
      fqn: "mistralrs_quant::hqq::dequant",
      language: "rust",
      path: "mistralrs-quant/src/hqq/dequant.rs",
      line_start: 90,
      line_end: 131,
    },
  ],
  edges: [
    {
      src: "mistralrs-quant/src/blockwise_fp8/dequant.rs#42:function:dequant",
      dst: `${WIDE}#118:function:gemv_wide`,
      dst_name: "gemv_wide",
      kind: "calls",
      resolution: "compiler",
      path: "mistralrs-quant/src/blockwise_fp8/dequant.rs",
      line: 55,
    },
  ],
};

/**
 * Eight utterances. Note what is absent: no episode anywhere says `dequant`, so the symbol that
 * nobody discussed is genuinely undiscussed rather than merely low-ranked.
 */
const transcript: Array<{ role: "human" | "agent"; text: string }> = [
  { role: "human", text: "Kick-off: we are chasing the blockwise fp8 regression on Arc." },
  {
    role: "human",
    text: "The workaround in gemv_wide.rs is deliberate. The wide kernel writes past the tile edge when K is not a multiple of 128, so we clamp the store and eat one extra load per tile. Do not simplify it back, it corrupts the last tile silently and the tests do not catch it.",
  },
  {
    role: "agent",
    text: `Confirmed by reading ${WIDE} — the clamp is on the store, not the load, exactly as described.`,
  },
  {
    role: "human",
    text: "gemv_wide is only reached from the fp8 path; the f16 path still uses the narrow kernel.",
  },
  { role: "agent", text: "src/lib.rs picked up the re-export, nothing else changed." },
  { role: "human", text: "Park the bake test until the kernel lands." },
  // The word-boundary decoy. A substring search would report this as a mention of `gemv_wide`.
  { role: "agent", text: "gemv_wide_v2 is the branch experiment; ignore it for now." },
  {
    role: "human",
    text: "Careful, gemv_wide.rs in the old tree was a completely different file — it did not have the clamp.",
  },
];

const why = (mentions: WhyMention[]): string[] => mentions.map((m) => m.why);
const texts = (mentions: WhyMention[]): string[] => mentions.map((m) => m.episode.text);

const mentioning = (mentions: WhyMention[], fragment: string): WhyMention => {
  const found = mentions.find((m) => m.episode.text.includes(fragment));
  if (!found) {
    throw new Error(
      `no mention containing ${JSON.stringify(fragment)}; got ${JSON.stringify(texts(mentions))}`,
    );
  }
  return found;
};

beforeAll(async () => {
  pg = await startPostgres();
  db = await pg.fork(DB);

  // The index lives at a descendant of the asking scope, the way the indexer actually files it.
  await ingestGraph(db, artifact, { scope: `${SCOPE}/code` });

  const base = Date.parse("2026-08-11T09:00:00.000Z");
  for (const [seq, turn] of transcript.entries()) {
    await recordEpisode(db, {
      scope: SCOPE,
      session_id: "sess-why-1",
      seq,
      occurred_at: new Date(base + seq * 600_000),
      actor: turn.role === "human" ? "human:jish" : "agent:claude",
      role: turn.role,
      text: turn.text,
      git_branch: "feat/blockwise-fp8",
      source: { kind: "claude-code", file: "why.test" },
    });
  }

  // A rule whose SUBJECT is the path.
  await assertFact(db, {
    scope: SCOPE,
    subject: WIDE,
    predicate: "tile_clamp_required",
    object: { value: true },
    kind: "rule",
    binding: true,
    claim: "The wide gemv kernel must clamp its store when K % 128 != 0.",
    evidence: { source: "session sess-why-1" },
    asserted_by: "human:jish",
  });
  // A measurement whose subject says nothing about the file, and whose EVIDENCE does. This is the
  // half `datum.search` cannot reach, which is why `findFacts` has its own query.
  await assertFact(db, {
    scope: SCOPE,
    subject: "arc/fp8-gemv",
    predicate: "bench_tok_s",
    object: { value: 757.5, unit: "tok/s" },
    kind: "state",
    claim: "757.5 tok/s on the fp8 gemv path.",
    evidence: { source: `cargo bench --bench gemv -- ${WIDE}` },
    asserted_by: "agent:claude",
  });

  console.log(`\n  real postgres ${pg.version} in container ${pg.container}\n`);
}, 240_000);

afterAll(async () => {
  await db?.close();
  await pg?.stop();
});

describe("whySymbol", () => {
  it("resolves an unambiguous symbol to its real path and line, and returns the reason", async () => {
    const result = await whySymbol(db, { scope: SCOPE, symbol: "gemv_wide", repo: REPO });
    notes["unambiguous symbol"] = result.note;

    expect(result.target).toBe("gemv_wide");
    expect(result.resolved).toEqual({
      kind: "symbol",
      path: WIDE,
      fqn: "mistralrs_quant::blockwise_fp8::gemv_wide",
      line_start: 118,
    });

    const explains = mentioning(result.mentions, "Do not simplify it back");
    expect(explains.episode.actor).toBe("human:jish");
    expect(explains.episode.git_branch).toBe("feat/blockwise-fp8");
    expect(explains.excerpt).toContain("writes past the tile edge");
    // The whole turn is 260 characters; the excerpt is a window on it, not the turn.
    expect(explains.excerpt.length).toBeLessThanOrEqual(244);
    expect(explains.excerpt.length).toBeLessThan(explains.episode.text.length);

    // The full-path turn and the bare-name turn both come back, and both are `symbol`-tier
    // because each contains the token `gemv_wide`.
    expect(texts(result.mentions)).toContain(
      "gemv_wide is only reached from the fp8 path; the f16 path still uses the narrow kernel.",
    );
    expect(why(result.mentions).every((w) => w === "symbol")).toBe(true);
  });

  it("does not count gemv_wide_v2 as a mention of gemv_wide", async () => {
    const result = await whySymbol(db, { scope: SCOPE, symbol: "gemv_wide", repo: REPO });
    expect(texts(result.mentions).some((t) => t.includes("gemv_wide_v2"))).toBe(false);
    // Four of the eight turns name it; the decoy and the three unrelated turns do not.
    expect(result.mentions).toHaveLength(4);
  });

  it("refuses to pick a file when one name lives in two, and says so in note", async () => {
    const result = await whySymbol(db, { scope: SCOPE, symbol: "dequant", repo: REPO });
    notes["ambiguous symbol"] = result.note;

    expect(result.resolved).toBeNull();
    expect(result.note).toContain("names 2 symbols");
    expect(result.note).toContain("mistralrs-quant/src/blockwise_fp8/dequant.rs:42");
    expect(result.note).toContain("mistralrs-quant/src/hqq/dequant.rs:90");
    // Both candidates are named, so nothing was silently preferred.
    expect(result.note).not.toContain("kind: \"symbol\"");
  });

  it("resolves the ambiguity when the caller qualifies the name", async () => {
    const result = await whySymbol(db, {
      scope: SCOPE,
      symbol: "mistralrs_quant::hqq::dequant",
      repo: REPO,
    });
    expect(result.resolved).toEqual({
      kind: "symbol",
      path: "mistralrs-quant/src/hqq/dequant.rs",
      fqn: "mistralrs_quant::hqq::dequant",
      line_start: 90,
    });
  });

  it("says nobody discussed it, rather than returning a quiet empty success", async () => {
    const result = await whySymbol(db, {
      scope: SCOPE,
      symbol: "mistralrs_quant::hqq::dequant",
      repo: REPO,
    });
    notes["undiscussed symbol"] = result.note;

    expect(result.mentions).toEqual([]);
    expect(result.note).not.toBeNull();
    expect(result.note).toContain("Nothing in the ingested transcripts");
    expect(result.note).toContain("not the same as there being no reason");
  });

  it("still answers from the conversation when the code was never indexed", async () => {
    const result = await whySymbol(db, {
      scope: SCOPE,
      symbol: "gemv_wide",
      repo: "aeonmind/never-indexed",
    });
    notes["unindexed repo"] = result.note;

    expect(result.resolved).toBeNull();
    expect(result.note).toContain("No completed code index for repo");
    // The point of the downgrade: the reason is still returned.
    expect(texts(result.mentions)).toContain(transcript[3]!.text);
  });

  it("finds the index without a repo, through the scope", async () => {
    const result = await whySymbol(db, { scope: SCOPE, symbol: "gemv_wide" });
    expect(result.resolved?.path).toBe(WIDE);
  });

  it("names the index it looked in when the symbol is not there", async () => {
    const result = await whySymbol(db, { scope: SCOPE, symbol: "no_such_kernel", repo: REPO });
    notes["symbol absent from index"] = result.note;
    expect(result.resolved).toBeNull();
    expect(result.note).toContain("No symbol named \"no_such_kernel\"");
    expect(result.note).toContain(`${REPO}@beef123`);
  });
});

describe("whyPath", () => {
  it("finds the basename-only mention and warns that a basename can collide", async () => {
    const result = await whyPath(db, { scope: SCOPE, path: WIDE });
    notes["path with basename-only mentions"] = result.note;

    expect(result.resolved).toEqual({ kind: "path", path: WIDE });

    const explains = mentioning(result.mentions, "Do not simplify it back");
    expect(explains.why).toBe("basename");
    expect(explains.excerpt).toContain("gemv_wide.rs is deliberate");

    // The turn that spelled the path out is the strong tier, and it sorts first.
    expect(why(result.mentions)[0]).toBe("path");
    expect(why(result.mentions)).toEqual(["path", "basename", "basename"]);

    expect(result.note).toContain('matched only the basename "gemv_wide.rs"');
    expect(result.note).toContain("can name a different file in another directory");
  });

  it("returns the recorded rule and the measurement that cites the file", async () => {
    const result = await whyPath(db, { scope: SCOPE, path: WIDE });
    const predicates = result.facts.map((f) => f.predicate).sort();
    expect(predicates).toEqual(["bench_tok_s", "tile_clamp_required"]);
    // Neither is `measured`: an episode-adjacent read path cannot manufacture confidence.
    expect(result.facts.every((f) => f.confidence === "unverified")).toBe(true);
  });

  it("treats ./path and path as the same question", async () => {
    const dotted = await whyPath(db, { scope: SCOPE, path: `./${WIDE}` });
    expect(dotted.target).toBe(WIDE);
    expect(dotted.mentions).toHaveLength(3);
  });

  it("says nothing was said, for a file nobody mentioned", async () => {
    const result = await whyPath(db, {
      scope: SCOPE,
      path: "mistralrs-quant/src/hqq/dequant.rs",
    });
    notes["path nobody mentioned"] = result.note;
    expect(result.mentions).toEqual([]);
    expect(result.facts).toEqual([]);
    expect(result.note).toContain("Nothing in the ingested transcripts");
  });

  it("refuses an empty path and a nonsense limit", async () => {
    await expect(whyPath(db, { scope: SCOPE, path: "  /  " })).rejects.toThrow(
      /path must not be empty/,
    );
    await expect(whyPath(db, { scope: SCOPE, path: WIDE, limit: 0 })).rejects.toThrow(
      /limit must be an integer/,
    );
  });

  it("writes nothing", async () => {
    const before = await db.one<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.assertions`,
    );
    await whyPath(db, { scope: SCOPE, path: WIDE });
    await whySymbol(db, { scope: SCOPE, symbol: "gemv_wide", repo: REPO });
    const after = await db.one<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.assertions`,
    );
    expect(after?.n).toBe(before?.n);
  });

  it("reports the notes it produced", () => {
    // Not an assertion about wording — a record of it, so the report quotes the implementation.
    console.log(`\n${JSON.stringify(notes, null, 2)}\n`);
    expect(Object.keys(notes).length).toBeGreaterThanOrEqual(7);
  });
});
