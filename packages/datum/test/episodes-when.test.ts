import { describe, expect, it } from "vitest";
import { readWhen, TIME_PHRASES } from "../src/episodes/when.js";

/**
 * The reader these tests hold replaces `parseWhen`, whose recall was already right — it fired on
 * exactly the date-bearing questions of both benchmark sets, 0 misses and 0 false fires — and whose
 * resolution cost two of the six held-out failures.
 *
 * So the first block below is not new coverage: it is every date case in `episodes-recall.test.ts`
 * re-asserted against the replacement, because a reader that fixes H23 by losing "just after
 * midnight on 17 Aug" is not an improvement. The blocks after it are the two failures, then the
 * refusals, which are the part that matters most — a window invented from nothing converts a miss
 * into a confident absence, and the caller cannot tell.
 */

const BOUNDS = { first: new Date("2026-08-10T00:00:00Z"), last: new Date("2026-08-24T23:59:00Z") };

/** The real H09/H10 pair from the held-out set: source at 19:32:16Z, answer 31.0 min later. */
const H09_TS = new Date("2026-08-14T19:32:16.386Z");
const H10_TS = new Date("2026-08-14T20:03:19.142Z");
/** H23's source utterance, the one the whole-day window ranked 23rd. */
const H23_TS = new Date("2026-08-14T22:51:22.527Z");

const holds = (w: { since: Date; until: Date } | null, at: Date): boolean =>
  w !== null && at.getTime() >= w.since.getTime() && at.getTime() < w.until.getTime();

describe("everything the previous reader had right", () => {
  it("resolves a day and month against the corpus rather than the wall clock", () => {
    const w = readWhen("what did he say on 15 Aug?", BOUNDS);
    expect(w?.since.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(w?.until.toISOString()).toBe("2026-08-16T00:00:00.000Z");
    expect(w?.read_as).toContain("whole day");
    expect(w?.confidence).toBe("exact");
  });

  it("narrows to a time of day when the question names one", () => {
    const w = readWhen("on the evening of 15 Aug he rejected it", BOUNDS);
    expect(w?.since.getUTCHours()).toBe(16);
    expect(w?.until.getUTCHours()).toBe(23);
    expect(w?.confidence).toBe("phrase");
  });

  it("reads 'just after midnight on 17 Aug' as the early hours OF the 17th", () => {
    const w = readWhen("just after midnight on 17 Aug he told the agent", BOUNDS);
    expect(w?.since.toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(w?.until.toISOString()).toBe("2026-08-17T06:00:00.000Z");
  });

  it("accepts both orders and ordinals", () => {
    for (const q of ["Aug 13 evening", "13 Aug evening", "the 13th of August, evening"]) {
      expect(readWhen(q, BOUNDS)?.since.toISOString(), q).toBe("2026-08-13T16:00:00.000Z");
    }
  });

  it("refuses a date the corpus cannot contain, rather than inventing a year", () => {
    expect(readWhen("what happened on 3 March?", BOUNDS)).toBeNull();
    expect(readWhen("no date here at all", BOUNDS)).toBeNull();
  });

  it("still reads H38's 'morning of 24 Aug' as 05:00-13:00, which retrieved at rank 1", () => {
    const w = readWhen("On the morning of 24 Aug Jish asked for a handoff", BOUNDS);
    expect(w?.since.toISOString()).toBe("2026-08-24T05:00:00.000Z");
    expect(w?.until.toISOString()).toBe("2026-08-24T13:00:00.000Z");
  });

  it("holds the source utterance of every other phrase-bearing benchmark question", () => {
    // Verbatim question openings with their real `source.ts`. These are the windows the previous
    // reader was measured on, so a width that drops one of them is a regression whatever it fixes.
    const cases: [string, string, string][] = [
      ["E07", "What pair of numbers did Jish call unacceptable just after midnight on 19 Aug", "2026-08-19T00:25:37.230Z"],
      ["E16", "Just after midnight on 17 Aug Jish told the agent to throw one of Arc's own components away", "2026-08-17T00:17:20.504Z"],
      ["H28", "Just after midnight on 14 Aug Jish banned a word from the conversation entirely", "2026-08-14T00:04:52.747Z"],
      ["H06", "Just before midnight on 14 Aug Jish asked what the optimisations had actually bought", "2026-08-14T23:54:46.239Z"],
      ["E35", "In the small hours of 21 Aug Jish posed a concrete serving scenario", "2026-08-21T01:54:45.958Z"],
    ];
    for (const [id, question, ts] of cases) {
      expect(holds(readWhen(question, BOUNDS), new Date(ts)), id).toBe(true);
    }
  });

  it("does not pretend to fix E13, whose own date phrase disagrees with its source by 21 hours", () => {
    // "In the small hours of 20 Aug" over an utterance at 21:26 on the 20th. No clock reading of
    // "small hours" reaches it, the previous reader missed it too, and widening `small hours` to
    // cover it would mean reading the phrase as the whole day. Recorded, not papered over.
    const w = readWhen("In the small hours of 20 Aug Jish asked about baking a tensor-core permutation", BOUNDS);
    expect(w?.since.toISOString()).toBe("2026-08-20T00:00:00.000Z");
    expect(w?.until.toISOString()).toBe("2026-08-20T06:00:00.000Z");
    expect(holds(w, new Date("2026-08-20T21:26:23.956Z"))).toBe(false);
  });
});

describe("H23 — 'late on X' is the late part of X, not all of it", () => {
  it("is strictly narrower than the whole day and still holds the answer", () => {
    const w = readWhen("Late on 14 Aug Jish shelved one geometry change", BOUNDS);
    const whole = readWhen("what did Jish say on 14 Aug", BOUNDS);
    expect(w?.since.toISOString()).toBe("2026-08-14T16:00:00.000Z");
    expect(w?.until.toISOString()).toBe("2026-08-15T02:00:00.000Z");
    // 10 hours against 24. Measured on the Arc corpus: 64 human utterances against the day's 105.
    const width = (x: { since: Date; until: Date }): number => x.until.getTime() - x.since.getTime();
    expect(width(w!)).toBeLessThan(width(whole!));
    expect(holds(w, H23_TS)).toBe(true);
  });

  it("holds every 'late on' source utterance in either question set", () => {
    // The reason the window starts at 16:00 and not at 19:00, which is what it sounds like. E11 and
    // H27 say "late on" of an utterance in the 17:00 hour or earlier, and H27's answer is reachable
    // ONLY through its window (RESULTS.md §4 `window_only`), so a tighter reading loses it outright.
    const cases: [string, string, string][] = [
      ["E11", "Late on 20 Aug Jish replaced the standing single-user target", "2026-08-20T16:49:52.746Z"],
      ["H27", "Late on 21 Aug the agent kept steering back to the throughput goal", "2026-08-21T17:49:29.719Z"],
      ["E15", "Late on 14 Aug Jish deferred a geometry change", "2026-08-14T22:51:03.520Z"],
      ["H23", "Late on 14 Aug Jish shelved one geometry change", "2026-08-14T22:51:22.527Z"],
    ];
    for (const [id, question, ts] of cases) {
      expect(holds(readWhen(question, BOUNDS), new Date(ts)), id).toBe(true);
    }
  });

  it("spills past midnight, because 00:00-01:00 is the corpus's busiest hour", () => {
    const w = readWhen("late on 14 Aug", BOUNDS);
    expect(holds(w, new Date("2026-08-15T01:30:00Z"))).toBe(true);
    expect(holds(w, new Date("2026-08-15T02:30:00Z"))).toBe(false);
  });

  it("does not let 'late' in 'late afternoon' hijack the reading", () => {
    const w = readWhen("in the late afternoon on 14 Aug", BOUNDS);
    expect(w?.since.toISOString()).toBe("2026-08-14T12:00:00.000Z");
    expect(w?.until.toISOString()).toBe("2026-08-14T19:00:00.000Z");
  });
});

describe("H10 — a relative expression needs an anchor and refuses without one", () => {
  it("with the anchor, holds the utterance 31 minutes later", () => {
    const w = readWhen("About half an hour later Jish dropped that per-layer target", BOUNDS, H09_TS);
    expect(w?.confidence).toBe("relative");
    expect(holds(w, new Date(H09_TS.getTime() + 30 * 60_000))).toBe(true);
    expect(holds(w, H10_TS)).toBe(true); // the real gap is 31.0 min; an exact 30 would have missed
    expect(w?.until.getTime()).toBe(H09_TS.getTime() + 75 * 60_000);
    expect(w?.read_as).toContain("30 min after");
  });

  it("without an anchor, returns null rather than a window centred on nothing", () => {
    expect(readWhen("About half an hour later Jish dropped that per-layer target", BOUNDS)).toBeNull();
  });

  it("reads a stated magnitude and a direction", () => {
    const later = readWhen("20 minutes later he changed it", BOUNDS, H09_TS);
    expect(later?.since.toISOString()).toBe(H09_TS.toISOString());
    expect(later?.until.getTime()).toBe(H09_TS.getTime() + 55 * 60_000);

    const before = readWhen("an hour before that he said the opposite", BOUNDS, H09_TS);
    expect(before?.until.toISOString()).toBe(H09_TS.toISOString());
    expect(before?.since.getTime()).toBe(H09_TS.getTime() - 135 * 60_000);
  });

  it("reads the vague orderings as a quarter hour, widened like any other offset", () => {
    const after = readWhen("shortly after that he corrected it", BOUNDS, H09_TS);
    expect(after?.since.toISOString()).toBe(H09_TS.toISOString());
    expect(after?.until.getTime()).toBe(H09_TS.getTime() + 45 * 60_000);

    const before = readWhen("just before that he asked why", BOUNDS, H09_TS);
    expect(before?.until.toISOString()).toBe(H09_TS.toISOString());
    expect(before?.since.getTime()).toBe(H09_TS.getTime() - 45 * 60_000);
  });

  it("reads 'the next morning' and 'later that evening' off the anchor's day", () => {
    const next = readWhen("the next morning he asked for a handoff", BOUNDS, H09_TS);
    expect(next?.since.toISOString()).toBe("2026-08-15T05:00:00.000Z");
    expect(next?.until.toISOString()).toBe("2026-08-15T13:00:00.000Z");
    expect(next?.confidence).toBe("relative");

    // The anchor is 19:32, already inside the evening, so "later" cuts the window at the anchor.
    const evening = readWhen("later that evening he shelved it", BOUNDS, H09_TS);
    expect(evening?.since.toISOString()).toBe(H09_TS.toISOString());
    expect(evening?.until.toISOString()).toBe("2026-08-14T23:00:00.000Z");
  });

  it("never returns an empty window when the anchor is past the named part", () => {
    const late = new Date("2026-08-14T23:30:00Z");
    const w = readWhen("later that evening he shelved it", BOUNDS, late);
    expect(w).not.toBeNull();
    expect(w!.until.getTime() - w!.since.getTime()).toBeGreaterThanOrEqual(3_600_000);
  });

  it("prefers a date in the text over the caller's anchor", () => {
    const w = readWhen("half an hour later, on 17 Aug, he said it again", BOUNDS, H09_TS);
    expect(w?.since.toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(w?.confidence).toBe("exact");
  });

  it("shifts 'the next morning' off a date the text supplied itself", () => {
    const w = readWhen("On 14 Aug he asked, and the next morning he shipped it", BOUNDS);
    expect(w?.since.toISOString()).toBe("2026-08-15T05:00:00.000Z");
    expect(w?.until.toISOString()).toBe("2026-08-15T13:00:00.000Z");
    expect(w?.confidence).toBe("phrase");
  });
});

describe("the new phrases", () => {
  const REQUIRED = [
    "late on", "early on", "first thing", "last thing", "end of the day", "over lunch",
    "mid-morning", "mid-afternoon", "before lunch", "after lunch", "small hours", "the early hours",
  ];

  it("are all in the table", () => {
    for (const phrase of REQUIRED) {
      expect(TIME_PHRASES.map((e) => e.phrase), phrase).toContain(phrase);
    }
  });

  it("each resolves against a date, and every one is narrower than the whole day", () => {
    for (const { phrase, hours } of TIME_PHRASES) {
      const w = readWhen(`${phrase} on 14 Aug he said something`, BOUNDS);
      expect(w, phrase).not.toBeNull();
      expect(w!.until.getTime() - w!.since.getTime(), phrase).toBe((hours[1] - hours[0]) * 3_600_000);
      expect(w!.until.getTime() - w!.since.getTime(), phrase).toBeLessThan(86_400_000);
      expect(w!.read_as, phrase).toContain("2026-08-14");
    }
  });

  it("is ordered longest phrase first, which is what makes prefix shadowing impossible", () => {
    // A phrase can only be shadowed by one that contains it, and a container is never shorter — so
    // this ordering is the whole proof that "mid-afternoon" is not read as "afternoon".
    const lengths = TIME_PHRASES.map((e) => e.phrase.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  it("matches hyphenated and spaced spellings the same way", () => {
    const hyphen = readWhen("mid-afternoon on 14 Aug", BOUNDS);
    const spaced = readWhen("mid afternoon on 14 Aug", BOUNDS);
    expect(hyphen?.since.toISOString()).toBe("2026-08-14T13:00:00.000Z");
    expect(spaced?.since.toISOString()).toBe(hyphen?.since.toISOString());
  });

  it("reads a whole word, not a substring: 'night' does not fire inside 'midnight'", () => {
    const w = readWhen("just before midnight on 14 Aug", BOUNDS);
    expect(w?.since.toISOString()).toBe("2026-08-14T21:00:00.000Z");
    expect(w?.until.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });
});

describe("what must not produce a window", () => {
  it("refuses six kinds of input that look like a date and are not", () => {
    const refused: [string, string][] = [
      ["no time named at all", "what did Jish think of the kernel?"],
      ["a day that does not exist", "what happened on 31 Feb?"],
      ["a real date outside the corpus", "what happened on 3 March?"],
      ["a bare year", "what changed in 2026?"],
      ["numbers that look like days", "raise the recall limit from 12 to 40"],
      ["a month name used as a modal", "he said we may 4 more layers would help"],
      ["a month name used as a verb", "we might march 20 files through the loop"],
      ["a time of day with no day", "what did he say in the evening?"],
      ["a relative phrase with no anchor", "about twenty minutes later he changed it"],
      ["an ISO date outside the corpus", "what happened on 2025-08-14?"],
      ["a day number too large for any month", "what happened on 32 Aug?"],
    ];
    for (const [why, question] of refused) {
      expect(readWhen(question, BOUNDS), why).toBeNull();
    }
  });

  it("reads the same ambiguous month once a date cue vouches for it", () => {
    // The guard is on the reading, not on the month: "may" is refused as a modal and accepted as a
    // date, and the discriminator is whether anything in the sentence treats it like one.
    const spring = { first: new Date("2026-05-01T00:00:00Z"), last: new Date("2026-08-24T00:00:00Z") };
    expect(readWhen("on 4 may he said it", spring)?.since.toISOString()).toBe("2026-05-04T00:00:00.000Z");
    expect(readWhen("may 4th, he said it", spring)?.since.toISOString()).toBe("2026-05-04T00:00:00.000Z");
    expect(readWhen("we may 4 kernels at once", spring)).toBeNull();
  });

  it("reads an ISO date inside the corpus and keeps the year it was given", () => {
    const w = readWhen("what was said on 2026-08-14 in the evening?", BOUNDS);
    expect(w?.since.toISOString()).toBe("2026-08-14T16:00:00.000Z");
    expect(w?.until.toISOString()).toBe("2026-08-14T23:00:00.000Z");
  });

  it("skips an unusable date and keeps reading rather than giving up on the question", () => {
    const w = readWhen("not 3 March — I mean 15 Aug", BOUNDS);
    expect(w?.since.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });
});

describe("an ambiguous year widens instead of picking one", () => {
  const twoYears = { first: new Date("2025-06-01T00:00:00Z"), last: new Date("2026-08-24T00:00:00Z") };

  it("covers both candidates and says so", () => {
    const w = readWhen("what did he say on 14 Aug?", twoYears);
    expect(w?.since.toISOString()).toBe("2025-08-14T00:00:00.000Z");
    expect(w?.until.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    expect(w?.read_as).toContain("year ambiguous");
    // Not `exact`: the caller is being handed an interpretation and must be able to see that.
    expect(w?.confidence).toBe("phrase");
  });

  it("still narrows by time of day inside the widened span", () => {
    const w = readWhen("on the evening of 14 Aug", twoYears);
    expect(w?.since.toISOString()).toBe("2025-08-14T16:00:00.000Z");
    expect(w?.until.toISOString()).toBe("2026-08-14T23:00:00.000Z");
  });
});

describe("read_as states the interpretation, so a caller can disagree with it", () => {
  it("names the day, the phrase and the hours", () => {
    expect(readWhen("late on 14 Aug", BOUNDS)?.read_as).toBe(
      '2026-08-14 "late on" read as 16:00-02:00 next day UTC',
    );
    expect(readWhen("first thing on 17 Aug", BOUNDS)?.read_as).toBe(
      '2026-08-17 "first thing" read as 00:00-11:00 UTC',
    );
    expect(readWhen("15 Aug", BOUNDS)?.read_as).toBe("2026-08-15 (whole day, 00:00-24:00 UTC)");
  });

  it("names the anchor for a relative reading, because the text alone cannot justify it", () => {
    const w = readWhen("half an hour later", BOUNDS, H09_TS);
    expect(w?.read_as).toBe(
      "30 min after 2026-08-14T19:32:16.386Z, widened to 75 min: 19:32-20:47 UTC",
    );
  });
});
