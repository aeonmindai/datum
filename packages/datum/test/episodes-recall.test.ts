import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import type { Db } from "../src/db/pool.js";
import { recordEpisode } from "../src/episodes/types.js";
import { recallEpisodes } from "../src/episodes/recall.js";
import { contentTerms, parseWhen, weighTerms } from "../src/episodes/query.js";

/**
 * Turning a question into a query.
 *
 * Measured before this existed: 95% when handed good topic words, 62.5% when the words came from
 * the question text. Reading the 14 that flipped showed why, and it was not paraphrase or ranking.
 * A question is phrased in reporting vocabulary and an utterance in content vocabulary:
 *
 *   asked:  "Jish rejected a GEMV kernel efficiency figure as nonsense"
 *   said:   "GEMV kernel at 15% peak is pure bs. Other projects do it at 50%"
 *
 * The terms that reached the index were rejected / nonsense / efficiency / percentages. None of
 * them occurs in the utterance, so no ranking could have found it. What every one of those 14
 * questions did carry was a time, and the search ignored it.
 *
 * Everything below was written after seeing those failures, which is exactly the tuning-on-the-test
 * that §16 warns about. It is why a held-out question set exists, and why these tests assert
 * mechanisms rather than benchmark outcomes.
 */

let pg: TestPostgres;
let db: Db;

const SCOPE = "org/acme/proj/arc";
const BOUNDS = { first: new Date("2026-08-10T00:00:00Z"), last: new Date("2026-08-24T23:59:00Z") };

beforeAll(async () => {
  pg = await startPostgres();
  db = await pg.fork("episodes_recall");
  await db.query("app", `INSERT INTO datum.scopes (path, kind, label) VALUES ($1,'proj','Arc')`, [
    SCOPE,
  ]);

  let seq = 0;
  const say = async (iso: string, text: string, actor = "human:jish"): Promise<void> => {
    await recordEpisode(db, {
      scope: SCOPE,
      session_id: "s1",
      seq: seq++,
      occurred_at: iso,
      actor,
      role: actor.startsWith("human") ? "human" : "agent",
      text,
      source: { kind: "test" },
    });
  };

  // The real shape: the answer sits inside a named evening, and shares no distinctive word with
  // the question that asks about it.
  await say("2026-08-15T20:01:00Z", "GEMV kernel at 15% peak is pure bs. Other projects do it at 50%");
  await say("2026-08-15T20:05:00Z", "and the megakernel is the last bit that matters");
  await say("2026-08-15T20:09:00Z", "how far now?");
  await say("2026-08-15T21:00:00Z", "brother I said exactly that, tear down and fix on cpu");
  // A high-idf identifier, so a single rare term still counts as evidence on its own.
  await say("2026-08-12T11:00:00Z", "why is qtip2b_grouped_gemm eating the whole batch?");
  // A long paste, to prove length normalisation stops it winning on term count alone.
  await say(
    "2026-08-15T20:30:00Z",
    `${"the ordering of publish and test and experiments and efficiency and throughput matters. ".repeat(24)}`,
    "agent:claude",
  );
  // Somewhere else entirely, sharing one common word with the question.
  await say("2026-08-22T09:00:00Z", "I said we would actually look at it later");
}, 300_000);

afterAll(async () => {
  await db?.close().catch(() => {});
  await pg?.stop();
});

describe("reading a date out of a question", () => {
  it("resolves a day and month against the corpus rather than the wall clock", () => {
    const w = parseWhen("what did he say on 15 Aug?", BOUNDS);
    expect(w?.since.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(w?.until.toISOString()).toBe("2026-08-16T00:00:00.000Z");
    expect(w?.read_as).toContain("whole day");
  });

  it("narrows to a time of day when the question names one", () => {
    const w = parseWhen("on the evening of 15 Aug he rejected it", BOUNDS);
    expect(w?.since.getUTCHours()).toBe(16);
    expect(w?.until.getUTCHours()).toBe(23);
  });

  it("reads 'just after midnight on 17 Aug' as the early hours OF the 17th", () => {
    // The trap: midnight belongs to the day it starts, and the naive reading puts the window on
    // the night before, which silently excludes the answer.
    const w = parseWhen("just after midnight on 17 Aug he told the agent", BOUNDS);
    expect(w?.since.toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(w?.until.toISOString()).toBe("2026-08-17T06:00:00.000Z");
  });

  it("accepts both orders and ordinals", () => {
    for (const q of ["Aug 13 evening", "13 Aug evening", "the 13th of August, evening"]) {
      expect(parseWhen(q, BOUNDS)?.since.toISOString(), q).toBe("2026-08-13T16:00:00.000Z");
    }
  });

  it("refuses a date the corpus cannot contain, rather than inventing a year", () => {
    // A store holding one fortnight has exactly one 15 Aug in it. A question about 3 March is
    // not a window, it is a mistake, and a mistake must not silently become a window.
    expect(parseWhen("what happened on 3 March?", BOUNDS)).toBeNull();
    expect(parseWhen("no date here at all", BOUNDS)).toBeNull();
  });
});

describe("choosing which words to send", () => {
  it("drops the date and the time of day, since they are already the window", () => {
    const t = contentTerms("On the evening of 13 Aug Jish rejected the GEMV figure");
    expect(t).not.toContain("evening");
    expect(t).not.toContain("aug");
    expect(t).not.toContain("13");
    expect(t).toContain("gemv");
  });

  it("splits a compound so its parts can match", () => {
    // "three-stage" as one token matches nothing in any corpus. "stage" might.
    const t = contentTerms("what three-stage ordering did he impose");
    expect(t).toContain("three-stage");
    expect(t).toContain("stage");
  });

  it("keeps identifiers intact", () => {
    expect(contentTerms("why is qtip2b_grouped_gemm slow")).toContain("qtip2b_grouped_gemm");
  });
});

describe("weighting terms by how rare they actually are", () => {
  it("reports a term absent from the corpus instead of silently dropping it", async () => {
    const { terms, useless } = await weighTerms(db, [SCOPE], ["gemv", "nonsense", "percentages"]);
    expect(useless).toContain("nonsense");
    expect(useless).toContain("percentages");
    expect(terms.map((t) => t.term)).toContain("gemv");
  });

  it("ranks a rare identifier above a common word", async () => {
    const { terms } = await weighTerms(db, [SCOPE], ["said", "qtip2b_grouped_gemm"]);
    expect(terms[0]?.term).toBe("qtip2b_grouped_gemm");
    const rare = terms.find((t) => t.term === "qtip2b_grouped_gemm");
    const common = terms.find((t) => t.term === "said");
    expect(rare!.idf).toBeGreaterThan(common!.idf);
  });
});

describe("recall", () => {
  it("finds the answer inside a named window even when no question word appears in it", async () => {
    const r = await recallEpisodes(db, {
      scope: SCOPE,
      question:
        "On the evening of 15 Aug Jish rejected a GEMV kernel efficiency figure as nonsense. " +
        "What were the two percentages?",
      limit: 12,
    });
    const blob = r.hits.map((h) => h.episode.text).join(" ");
    expect(blob).toContain("15% peak");
    expect(blob).toContain("50%");
    // And it says what it did, including that two of the caller's words exist nowhere here.
    expect(r.note).toContain("window 2026-08-15 evening");
    expect(r.note).toMatch(/absent from corpus:.*(nonsense|percentages)/);
  });

  it("returns the whole window when nothing discriminating matched, and says so", async () => {
    // One common word in common is not evidence. Before this, twelve rows sharing `said` or
    // `actually` with the question displaced the answer that was sitting in the same window.
    const r = await recallEpisodes(db, {
      scope: SCOPE,
      question: "what did he actually say on the evening of 15 Aug",
      limit: 3,
    });
    expect(r.hits.every((h) => h.tier === "window")).toBe(true);
    expect(r.note).toMatch(/no term matched — (showing \d+ of \d+|this is all \d+) said in that window/);
    // Ordered by when it was said, because a score nobody should trust is not an ordering.
    const times = r.hits.map((h) => new Date(h.episode.occurred_at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("does not let a long paste outrank the short sentence that answers the question", async () => {
    // Summed idf rewards length for matching more terms by chance. The 2,000-character agent
    // paste here contains `ordering`, `publish`, `test`, `experiments`, `efficiency` and
    // `throughput`; the answer contains two words. Length normalisation is what keeps the answer.
    const r = await recallEpisodes(db, {
      scope: SCOPE,
      question: "what did he say about the GEMV kernel peak on 15 Aug",
      limit: 4,
    });
    expect(r.hits[0]?.episode.text).toContain("15% peak");
  });

  it("treats a single rare identifier as evidence on its own", async () => {
    const r = await recallEpisodes(db, {
      scope: SCOPE,
      question: "what was said about qtip2b_grouped_gemm",
      limit: 4,
    });
    expect(r.hits[0]?.tier).toBe("term");
    expect(r.hits[0]?.matched_terms).toContain("qtip2b_grouped_gemm");
  });

  it("degrades a misread date to an ordinary search rather than to silence", async () => {
    // 14 Aug is inside the corpus bounds and holds nothing. The question is still answerable
    // and must not return empty just because the date was wrong. (A date OUTSIDE the bounds is a
    // different case: parseWhen refuses it rather than opening an empty window.)
    const r = await recallEpisodes(db, {
      scope: SCOPE,
      question: "what was said about qtip2b_grouped_gemm on 14 Aug",
      limit: 4,
    });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.note).toContain("that window was empty");
  });

  it("says plainly when a question carries neither a usable word nor a date", async () => {
    const r = await recallEpisodes(db, { scope: SCOPE, question: "the of and it", limit: 4 });
    expect(r.hits).toHaveLength(0);
    expect(r.note).toContain("no usable terms and no date");
  });
});
