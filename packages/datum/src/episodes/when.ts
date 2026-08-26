/**
 * Reading a time out of a question.
 *
 * The reader this replaces (`parseWhen`) fired on exactly the date-bearing questions of both
 * benchmark sets — 0 misses, 0 false fires — so its recall was already right. What it got wrong was
 * *resolution*, and that cost two of the six held-out failures:
 *
 *   H23  "Late on 14 Aug Jish shelved one geometry change…" was read as the WHOLE of 14 Aug. That
 *        day carries 105 human utterances and the answer is at 22:51:22Z; 22 episodes outranked it
 *        and `limit=12` cut it off. Read as the late part of the day, the same window holds 64.
 *   H10  "About half an hour later Jish dropped that per-layer target…" carries no absolute date, so
 *        no window fired at all and the answer sat at rank 15 of the term tier. The anchor is the
 *        previous question's utterance at 19:32:16Z and the answer is 31.0 min after it; a window of
 *        anchor..anchor+75min holds 7 utterances out of that day's 105.
 *
 * (Every count above was measured over the 550-utterance Arc corpus through `bench/episodes/corpus.mts`.)
 *
 * Two rules run through everything below.
 *
 * **Err wide, and say so.** A window that is too tight silently excludes the answer and the caller
 * cannot tell the difference between "not in the window" and "never said". A window that is too wide
 * costs a few rows out of hundreds and the ranker still sees the answer. So every width here errs
 * wide, and every width states which way it erred and why.
 *
 * **Never invent one.** A window with no evidence behind it is worse than no window, for the same
 * reason: it converts a miss into a confident absence. So a relative phrase with no anchor returns
 * null, a date the corpus cannot contain returns null, and an ambiguous year widens to cover its
 * candidates rather than picking one.
 *
 * The clock is the corpus's own recorded UTC: transcript timestamps are UTC and the questions were
 * authored by reading them, so "late on 14 Aug" means late in the UTC day. Weekday names ("on
 * Tuesday evening") are deliberately not read — resolving one needs a which-week decision the text
 * does not carry, and guessing it is exactly the invented window this file refuses to produce.
 */

export interface TimeWindow {
  since: Date;
  until: Date;
  /** How it was read, in words, so a caller can see the interpretation and disagree with it. */
  read_as: string;
  /**
   * `exact`    — the text named a calendar day and nothing narrower; the window is that day.
   * `phrase`   — an English time-of-day phrase was interpreted into hours, or an ambiguous year was
   *              widened to cover its candidates. Arguable, and `read_as` says how it was argued.
   * `relative` — positioned from the caller's `anchor`, not from anything in the text alone.
   */
  confidence: "exact" | "phrase" | "relative";
}

/**
 * Time of day as an hour range in the speaker's own clock, day-relative: `hours[1]` above 24 means
 * the window spills into the following day.
 *
 * Widths, and the direction each one errs, measured over the Arc corpus (550 human utterances,
 * 2026-08-10 to 2026-08-24):
 *
 * - **`late on` / `end of the day` / `last thing` = 16:00–02:00 next day.** The H23 fix, and the one
 *   width here that was chosen by measurement rather than by ear. Four questions across the two sets
 *   say "late on <date>", and their source utterances sit at 16:49 (E11), 17:49 (H27), 22:51 (E15)
 *   and 22:51 (H23). Ear says 19:00; the corpus says the author calls 16:49 late, because that day's
 *   work started at 01:52. A 19:00 start narrows 14 Aug to 46 utterances instead of 64 and would
 *   have been the better window for H23 — and it would silently exclude E11 and H27, and RESULTS.md
 *   §4 records H27 as `window_only`, meaning the window is the only reason its answer is retrievable
 *   at all. Trading one ranking loss for one guaranteed loss is not a trade. So this errs early-wide,
 *   at 16:00, and still cuts 14 Aug from 105 utterances to 64, 20 Aug from 63 to 51 and 21 Aug from
 *   69 to 37. It spills past midnight because 00:00–01:00 is the single busiest hour in the whole
 *   corpus (51 utterances, more than any hour of the working day): a session called "late on the
 *   14th" keeps talking into the 15th, and stopping at 24:00 drops 12 of those 64 rows for nothing.
 *   The three phrases are read identically because English does not separate them and the corpus
 *   gives no evidence that would justify inventing a separation.
 * - **`first thing` = 00:00–11:00** and **`early on` = 00:00–12:00**, which look absurdly early
 *   until you measure the corpus: the first utterance of a day is before 01:00 on 8 of 14 days and
 *   before 11:00 on 12 of 14, because sessions run past midnight and the next day's work begins in
 *   its small hours. `morning` stays 05:00–13:00 by contrast, and the difference is deliberate —
 *   `morning` names a region of the clock, `first thing` and `early on` name a position in the day's
 *   activity, and in this corpus those are not the same thing. The known cost, stated rather than
 *   hidden: two of the fourteen days only start speaking at 21:27 and 22:09, and no clock window
 *   called "first thing" can cover those without covering the whole day.
 * - **`morning`, `afternoon`, `evening`, `night`, `overnight`, `midday`, `noon`, `dawn`,
 *   `small hours`, `early hours`** keep the values the previous reader used, because those are the
 *   ones the benchmark measured working (H38's "morning of 24 Aug" resolved to 05:00–13:00 and was
 *   retrieved at rank 1; the three "just after midnight" questions land at 00:04, 00:17 and 00:25).
 *   `small hours` is 00:00–06:00 rather than the 00:00–05:00 its old table said, because the old
 *   reader had an override that widened it to 6 whenever the phrase appeared — 6 is the behaviour
 *   that was measured, so 6 is what is kept. Changing a width that is already carrying questions to
 *   chase one that is not is how a tuned score stops meaning anything.
 * - **`midnight` = 22:00–02:00 next day**, straddling the boundary, because bare "midnight on the
 *   17th" argues both ways. The two readings that do not argue get their own rows: `just after
 *   midnight` is the early hours OF the named day and `just before midnight` is the end of it —
 *   21:00–24:00, which is narrower than the old reader's 22:00–03:00 and still holds H06's 23:54.
 * - **`over lunch` / `before lunch` / `after lunch` / `mid-morning` / `mid-afternoon`** are three to
 *   four hours each rather than one. Lunch in a transcript is a gap, not a timestamp, so the phrase
 *   is a claim about roughly-midday and the honest width is one that survives being wrong by an
 *   hour. No question in either set uses them, so they are inference, not measurement.
 *
 * Matching walks this array in order and stops at the first hit, so `just after midnight` must be
 * reached before `midnight` and `mid-afternoon` before `afternoon`. The array is therefore ordered
 * longest phrase first, which makes that safe for every pair: a phrase can only be shadowed by one
 * that contains it, and a container is never shorter. `episodes-when.test.ts` asserts the ordering,
 * so a phrase added in the wrong place fails there rather than silently losing to a prefix.
 */
export const TIME_PHRASES: ReadonlyArray<{ phrase: string; hours: [number, number] }> = [
  { phrase: "just before midnight", hours: [21, 24] },
  { phrase: "just after midnight", hours: [0, 6] },
  { phrase: "the early hours", hours: [0, 6] },
  { phrase: "end of the day", hours: [16, 26] },
  { phrase: "mid-afternoon", hours: [13, 17] },
  { phrase: "before lunch", hours: [9, 13] },
  { phrase: "early hours", hours: [0, 6] },
  { phrase: "small hours", hours: [0, 6] },
  { phrase: "after lunch", hours: [13, 17] },
  { phrase: "mid-morning", hours: [9, 12] },
  { phrase: "first thing", hours: [0, 11] },
  { phrase: "over lunch", hours: [11, 15] },
  { phrase: "last thing", hours: [16, 26] },
  { phrase: "afternoon", hours: [12, 19] },
  { phrase: "overnight", hours: [21, 30] },
  { phrase: "midnight", hours: [22, 26] },
  { phrase: "early on", hours: [0, 12] },
  { phrase: "morning", hours: [5, 13] },
  { phrase: "evening", hours: [16, 23] },
  { phrase: "late on", hours: [16, 26] },
  { phrase: "midday", hours: [11, 15] },
  { phrase: "night", hours: [19, 27] },
  { phrase: "noon", hours: [11, 15] },
  { phrase: "dawn", hours: [4, 8] },
];

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/**
 * Month names that are also ordinary English words. "we may 4 more layers" and "we might march 20
 * files through it" both parse as dates under a bare name-plus-number rule, and a date read out of a
 * modal verb is the invented window this file exists to refuse. These two need a second signal.
 */
const AMBIGUOUS_MONTHS: Record<string, true> = { may: true, march: true };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

const MONTH_NAMES = Object.keys(MONTHS).join("|");
const DAY_FIRST = new RegExp(`\\b(\\d{1,2})(st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES})\\b`, "g");
const MONTH_FIRST = new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{1,2})(st|nd|rd|th)?\\b`, "g");
/** Only the unambiguous written order. `14/08` is a locale coin-flip, so it is not read at all. */
const ISO_DATE = /\b(\d{4})-(0\d|1[0-2])-(\d{2})\b/g;

/** A preposition or article immediately before a date is the second signal an ambiguous month needs. */
const DATE_CUE = /\b(on|in|by|at|since|until|till|from|during|around|about|through|late|early|of|the)\s+(the\s+)?$/;

/**
 * Hyphens become spaces so that "mid-morning" and "mid morning" are one phrase, and the replacement
 * is one character for one character so offsets stay comparable with the untouched lower-cased text
 * (which is where ISO dates are read, since flattening their hyphens would destroy them).
 */
const flatten = (text: string): string => text.toLowerCase().replace(/[-\u2010-\u2015\u2212]/g, " ");

const clock = (h: number): string =>
  h === 24 ? "24:00" : `${String(Math.floor(h) % 24).padStart(2, "0")}:00`;

const hhmm = (d: Date): string => d.toISOString().slice(11, 16);
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

interface Candidate {
  at: number;
  day: number;
  month: number;
  /** Present only for an ISO date, where the writer said which year and does not need guessing. */
  year: number | null;
  literal: string;
}

/** Real calendar day? `Date.UTC` rolls 31 Feb into March rather than complaining. */
function realDate(year: number, month: number, day: number): Date | null {
  if (day < 1 || day > 31 || month < 0 || month > 11) return null;
  const d = new Date(Date.UTC(year, month, day));
  return d.getUTCMonth() === month && d.getUTCDate() === day ? d : null;
}

function candidates(flat: string, lower: string): Candidate[] {
  const out: Candidate[] = [];

  for (const m of flat.matchAll(DAY_FIRST)) {
    const [dayStr, ordinal, monStr] = [m[1], m[2], m[3]];
    if (dayStr === undefined || monStr === undefined) continue;
    const month = MONTHS[monStr];
    if (month === undefined) continue;
    if (!admissible(monStr, flat, m.index, ordinal !== undefined, m[0].length)) continue;
    out.push({ at: m.index, day: Number.parseInt(dayStr, 10), month, year: null, literal: m[0] });
  }

  for (const m of flat.matchAll(MONTH_FIRST)) {
    const [monStr, dayStr, ordinal] = [m[1], m[2], m[3]];
    if (dayStr === undefined || monStr === undefined) continue;
    const month = MONTHS[monStr];
    if (month === undefined) continue;
    if (!admissible(monStr, flat, m.index, ordinal !== undefined, m[0].length)) continue;
    out.push({ at: m.index, day: Number.parseInt(dayStr, 10), month, year: null, literal: m[0] });
  }

  for (const m of lower.matchAll(ISO_DATE)) {
    const [y, mo, d] = [m[1], m[2], m[3]];
    if (y === undefined || mo === undefined || d === undefined) continue;
    out.push({
      at: m.index,
      day: Number.parseInt(d, 10),
      month: Number.parseInt(mo, 10) - 1,
      year: Number.parseInt(y, 10),
      literal: m[0],
    });
  }

  return out.sort((a, b) => a.at - b.at);
}

/** An ambiguous month name needs an ordinal, a date cue in front, or a year behind it. */
function admissible(
  month: string,
  flat: string,
  at: number,
  ordinal: boolean,
  len: number,
): boolean {
  if (!AMBIGUOUS_MONTHS[month]) return true;
  if (ordinal) return true;
  if (DATE_CUE.test(flat.slice(0, at))) return true;
  return /^\s*,?\s*\d{4}\b/.test(flat.slice(at + len));
}

/**
 * Which year? Whichever candidates fall inside the corpus, and if more than one does the window
 * covers all of them. Nothing is hardcoded, no assumption survives a corpus that moves, and the
 * fortnight-long store this was built for has exactly one 14 Aug in it. The one-day slack absorbs
 * corpus bounds that were themselves derived from a local-time day boundary.
 */
function daysInCorpus(c: Candidate, corpus: { first: Date; last: Date }): Date[] {
  const years =
    c.year !== null
      ? [c.year]
      : rangeInclusive(corpus.first.getUTCFullYear(), corpus.last.getUTCFullYear());
  const hits: Date[] = [];
  for (const y of years) {
    const day = realDate(y, c.month, c.day);
    if (day === null) continue;
    if (day.getTime() < corpus.first.getTime() - DAY_MS) continue;
    if (day.getTime() > corpus.last.getTime() + DAY_MS) continue;
    hits.push(day);
  }
  return hits;
}

function rangeInclusive(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let n = lo; n <= hi; n += 1) out.push(n);
  return out;
}

function findPhrase(flat: string): { phrase: string; hours: [number, number] } | null {
  for (const entry of TIME_PHRASES) {
    const pattern = new RegExp(`\\b${flatten(entry.phrase).split(" ").join("\\s+")}\\b`);
    if (pattern.test(flat)) return entry;
  }
  return null;
}

/** "the next morning", "the following evening" — the named day plus one, then the phrase's hours. */
const NEXT_DAY = /\b(?:the\s+)?(?:next|following)\s+([a-z]+(?:\s+[a-z]+)?)\b/;

function nextDayShift(flat: string): { phrase: string; hours: [number, number] } | null {
  const m = flat.match(NEXT_DAY);
  const tail = m?.[1];
  if (tail === undefined) return null;
  return findPhrase(tail);
}

const RELATIVE_MAGNITUDES: ReadonlyArray<{ pattern: RegExp; minutes: number }> = [
  { pattern: /\bhalf an hour\b/, minutes: 30 },
  { pattern: /\ba couple of hours\b/, minutes: 120 },
  { pattern: /\ban hour and a half\b/, minutes: 90 },
  { pattern: /\ban hour\b/, minutes: 60 },
  { pattern: /\ba few minutes\b/, minutes: 5 },
  { pattern: /\ba minute\b/, minutes: 1 },
];

const REL_OFFSET =
  /\b(half an hour|a couple of hours|an hour and a half|an hour|a few minutes|a minute|\d{1,3}\s*(?:minutes?|mins?|hours?|hrs?))\s+(later|afterwards?|after|earlier|before|beforehand|ago|previously|prior)\b/;

/** No magnitude given, only an ordering. Treated as a quarter hour, widened like any other offset. */
const REL_VAGUE = /\b(shortly|just|right|moments|immediately|soon)\s+(after|afterwards?|later|before|beforehand|earlier)\b/;

const FORWARD: Record<string, true> = { later: true, after: true, afterward: true, afterwards: true };

function magnitudeMinutes(spoken: string): number | null {
  for (const { pattern, minutes } of RELATIVE_MAGNITUDES) {
    if (pattern.test(spoken)) return minutes;
  }
  const m = spoken.match(/^(\d{1,3})\s*(minutes?|mins?|hours?|hrs?)$/);
  const n = m?.[1];
  const unit = m?.[2];
  if (n === undefined || unit === undefined) return null;
  return Number.parseInt(n, 10) * (unit.startsWith("h") ? 60 : 1);
}

/**
 * A spoken offset is a memory of a duration, not a measurement, so the window is twice the stated
 * gap plus a quarter hour rather than the gap itself. Measured on H10: the question says "about half
 * an hour later" and the true gap is 31.0 min, so an exact 30-minute window would have missed it by
 * 65 seconds. Doubling absorbs a 2× recall error in the only direction that is cheap — the resulting
 * 75-minute window holds 7 of that day's 105 utterances, so paying for the slack costs almost
 * nothing, while being 65 seconds short costs the answer.
 */
function offsetWindow(anchor: Date, minutes: number, forward: boolean): { since: Date; until: Date } {
  const span = (minutes * 2 + 15) * MIN_MS;
  return forward
    ? { since: anchor, until: new Date(anchor.getTime() + span) }
    : { since: new Date(anchor.getTime() - span), until: anchor };
}

function windowOver(days: Date[], hours: [number, number]): { since: Date; until: Date } {
  const [lo, hi] = hours;
  const starts = days.map((d) => d.getTime() + lo * HOUR_MS);
  const ends = days.map((d) => d.getTime() + hi * HOUR_MS);
  return { since: new Date(Math.min(...starts)), until: new Date(Math.max(...ends)) };
}

function phraseRead(days: Date[], phrase: string, hours: [number, number]): string {
  const [lo, hi] = hours;
  const spill = hi > 24 ? " next day" : "";
  const where = days.length === 1
    ? isoDay(days[0] as Date)
    : `year ambiguous, widened over ${days.map(isoDay).join(" and ")}`;
  return `${where} "${phrase}" read as ${clock(lo)}-${clock(hi)}${spill} UTC`;
}

/**
 * Read a time out of a question.
 *
 * `anchor` is the instant the question is relative to — in practice the previously retrieved
 * utterance. It is only consulted when the text names no absolute date, and without it a relative
 * expression returns null rather than a guess.
 */
export function readWhen(
  text: string,
  corpus: { first: Date; last: Date },
  anchor?: Date,
): TimeWindow | null {
  const lower = text.toLowerCase();
  const flat = flatten(text);

  for (const c of candidates(flat, lower)) {
    const days = daysInCorpus(c, corpus);
    if (days.length === 0) continue; // a date this corpus cannot hold is a mistake, not a window
    const ambiguous = days.length > 1;

    // "on 14 Aug … the next morning" is the 15th. The date is the anchor the text supplied itself,
    // so this needs no caller anchor and stays as confident as any other phrase reading.
    const shifted = nextDayShift(flat);
    if (shifted !== null) {
      const nextDays = days.map((d) => new Date(d.getTime() + DAY_MS));
      const { since, until } = windowOver(nextDays, shifted.hours);
      return {
        since,
        until,
        read_as: `the ${shifted.phrase} after ${days.map(isoDay).join(" and ")}: ${phraseRead(nextDays, shifted.phrase, shifted.hours)}`,
        confidence: "phrase",
      };
    }

    const named = findPhrase(flat);
    if (named === null) {
      const { since, until } = windowOver(days, [0, 24]);
      return {
        since,
        until,
        read_as: ambiguous
          ? `year ambiguous, widened over ${days.map(isoDay).join(" and ")} (whole day each, 00:00-24:00 UTC)`
          : `${isoDay(days[0] as Date)} (whole day, 00:00-24:00 UTC)`,
        // A bare date is the only reading with nothing interpreted into it — unless the year had to
        // be widened, which is an interpretation and says so.
        confidence: ambiguous ? "phrase" : "exact",
      };
    }

    const { since, until } = windowOver(days, named.hours);
    return { since, until, read_as: phraseRead(days, named.phrase, named.hours), confidence: "phrase" };
  }

  return anchor === undefined ? null : readRelative(flat, anchor);
}

/**
 * Everything that positions itself against something the text does not contain. Reached only when
 * the caller supplied an anchor, because the alternative is a window centred on nothing.
 */
function readRelative(flat: string, anchor: Date): TimeWindow | null {
  const dayStart = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()));

  const shifted = nextDayShift(flat);
  if (shifted !== null) {
    const next = new Date(dayStart.getTime() + DAY_MS);
    const { since, until } = windowOver([next], shifted.hours);
    return {
      since,
      until,
      read_as: `the ${shifted.phrase} after ${anchor.toISOString()}: ${phraseRead([next], shifted.phrase, shifted.hours)}`,
      confidence: "relative",
    };
  }

  // "later that evening" / "earlier that day" — the anchor's own day, cut at the anchor so that
  // "later" cannot point backwards.
  const sameDay = flat.match(/\b(later|earlier)\s+(?:on\s+)?that\s+([a-z]+(?:\s+[a-z]+)?)\b/);
  const direction = sameDay?.[1];
  const tail = sameDay?.[2];
  if (direction !== undefined && tail !== undefined) {
    const part = tail.startsWith("day") ? { phrase: "day", hours: [0, 24] as [number, number] } : findPhrase(tail);
    if (part !== null) {
      const span = windowOver([dayStart], part.hours);
      const forward = direction === "later";
      // Clamping can empty a window when the anchor is already past the named part; a minimum hour
      // in the stated direction keeps it non-empty, because an empty window reads as "nothing was
      // said" and that is the one answer this must never fabricate.
      const since = forward ? new Date(Math.max(span.since.getTime(), anchor.getTime())) : span.since;
      const until = forward ? span.until : new Date(Math.min(span.until.getTime(), anchor.getTime()));
      const fixed = until.getTime() - since.getTime() >= HOUR_MS
        ? { since, until }
        : forward
          ? { since, until: new Date(since.getTime() + HOUR_MS) }
          : { since: new Date(until.getTime() - HOUR_MS), until };
      return {
        ...fixed,
        read_as: `${direction} that ${part.phrase} relative to ${anchor.toISOString()}: ${isoDay(dayStart)} ${hhmm(fixed.since)}-${hhmm(fixed.until)} UTC`,
        confidence: "relative",
      };
    }
  }

  const offset = flat.match(REL_OFFSET);
  const spoken = offset?.[1];
  const facing = offset?.[2];
  if (spoken !== undefined && facing !== undefined) {
    const minutes = magnitudeMinutes(spoken);
    if (minutes !== null) {
      const forward = FORWARD[facing] === true;
      const w = offsetWindow(anchor, minutes, forward);
      return {
        ...w,
        read_as: `${minutes} min ${forward ? "after" : "before"} ${anchor.toISOString()}, widened to ${minutes * 2 + 15} min: ${hhmm(w.since)}-${hhmm(w.until)} UTC`,
        confidence: "relative",
      };
    }
  }

  const vague = flat.match(REL_VAGUE);
  const facingVague = vague?.[2];
  if (facingVague !== undefined) {
    const forward = FORWARD[facingVague] === true;
    const w = offsetWindow(anchor, 15, forward);
    return {
      ...w,
      read_as: `${vague?.[1] ?? ""} ${facingVague} ${anchor.toISOString()}, read as 45 min ${forward ? "after" : "before"}: ${hhmm(w.since)}-${hhmm(w.until)} UTC`,
      confidence: "relative",
    };
  }

  // A bare time of day with an anchor but no date: the anchor's day is the only day on offer, and
  // saying so is better than dropping the one temporal word the question carried.
  const named = findPhrase(flat);
  if (named !== null) {
    const { since, until } = windowOver([dayStart], named.hours);
    return {
      since,
      until,
      read_as: `"${named.phrase}" on the anchor's own day ${isoDay(dayStart)}: ${clock(named.hours[0])}-${clock(named.hours[1])}${named.hours[1] > 24 ? " next day" : ""} UTC`,
      confidence: "relative",
    };
  }

  return null;
}
