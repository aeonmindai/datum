import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { Db, DbRole } from "../db/pool.js";
import { Rejection } from "../domain/errors.js";
import { recordEpisode, type EpisodeInput } from "./types.js";

/**
 * Claude Code transcripts in, episodes out. No facts are produced here and none ever should be.
 *
 * A transcript is a stream of records, most of which are not speech: mode switches, attachments,
 * tool calls, tool results, queue operations, injected command wrappers. Measured on the Arc
 * corpus — six files, 668 MB, fourteen days — 599 records out of 37,075 are somebody actually
 * saying something. Everything else is machinery, and machinery recorded as testimony is how a
 * memory store fills with junk it will later cite back at you.
 *
 * Assistant prose is off by default for the same reason. A human sentence is testimony: somebody
 * is accountable for it. Agent prose is a plausible-sounding artefact of the same model that will
 * later read it back, which is precisely the recall-to-re-extraction loop that produced 808 copies
 * of one invented preference in an audited deployment. `includeAgent` exists because a transcript
 * with only one side of the conversation is sometimes unreadable, not because agent text is
 * evidence.
 */

/** The database enforces this too; checking here means an 82 MB stream is not read to fail. */
const ACTOR_SHAPE = /^(human|agent|service|worker):[A-Za-z0-9_.@:-]+$/;

export interface IngestReport {
  file: string;
  sessions: number;
  episodes: number;
  /** Candidate records rejected by a filter: meta, tool result, no text block, empty, wrapper. */
  skipped: number;
  duplicates: number;
  byRole: Record<string, number>;
}

export interface IngestOptions {
  file: string;
  scope: string;
  humanActor: string;
  agentActor?: string;
  includeAgent?: boolean;
  limit?: number;
  role?: DbRole;
}

export interface IngestDirOptions {
  dir: string;
  scope: string;
  humanActor: string;
  agentActor?: string;
  includeAgent?: boolean;
  limit?: number;
  role?: DbRole;
}

interface TranscriptRecord {
  type?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  isVisibleInTranscriptOnly?: unknown;
  message?: { role?: unknown; content?: unknown } | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function requireActor(label: string, actor: string): string {
  if (ACTOR_SHAPE.test(actor)) return actor;
  throw new Rejection({
    reason: "malformed_request",
    message: `${label} ${JSON.stringify(actor)} is not a valid actor`,
    detail: { field: label, value: actor, constraint: "episode_actor_shape" },
    hint: "An actor is <human|agent|service|worker>:<name>, e.g. human:jish.",
  });
}

/**
 * The speech inside a record, or null when the record is not speech.
 *
 * A tool result arrives shaped like a user message and is not one — the user did not type it,
 * the tool did. A record whose blocks are all `tool_use` is the agent operating, not talking.
 * Both return null and are counted as skipped rather than silently vanishing.
 */

/**
 * Does this utterance look like something a machine wrote?
 *
 * Purely structural, and deliberately so: no model, nothing to drift, and it reports a ratio
 * rather than a verdict so a reader can disagree with the threshold. A person typing a sentence
 * produces none of these shapes - the median human turn in the measured corpus is 60 characters.
 * A pasted agent answer produces several at once.
 */
function machineProse(text: string): { ratio: number; markers: string[] } | null {
  // Short turns are speech. Applying structure tests to "yes, do that" only produces noise.
  if (text.length < 900) return null;
  const lines = text.split("\n");
  const markers = new Set<string>();
  let machineLines = 0;
  for (const raw of lines) {
    const l = raw.trim();
    if (l.length === 0) continue;
    if (/^\|.*\|$/.test(l) || /^[+|][-+|\s]{6,}$/.test(l) || /^[┌├└│]/.test(l)) {
      markers.add("table");
      machineLines += 1;
    } else if (/(->|→|=>)/.test(l) && l.length < 200) {
      markers.add("arrows");
      machineLines += 1;
    } else if (/^\s*(?:[-*]|\d+\.)\s+\*\*/.test(l)) {
      markers.add("bulleted-bold");
      machineLines += 1;
    } else if (/^```/.test(l)) {
      markers.add("fence");
      machineLines += 1;
    } else if (/^#{1,4}\s/.test(l)) {
      markers.add("headings");
      machineLines += 1;
    }
  }
  const counted = lines.filter((l) => l.trim().length > 0).length || 1;
  const ratio = machineLines / counted;
  // Two independent shapes, or a third of the lines: one stray arrow in a long message is a
  // person writing an arrow, not a paste.
  if (markers.size < 2 && ratio < 0.34) return null;
  return { ratio: Number(ratio.toFixed(3)), markers: [...markers].sort() };
}

/**
 * Verbatim overlap with what the machine said earlier in this same conversation.
 *
 * Structure catches pasted tables. It cannot catch the dangerous case, which is flowing prose:
 * the largest human utterance in the measured corpus is 24,726 characters of the agent's own
 * paragraphs pasted back in, with no table, no arrow and no heading in it. One such paste carries
 * an invented "9,000 GPU instructions issued per token", and stored naively it comes back as
 * testimony from a named human.
 *
 * So the real test is the exact one: has the machine already written these words? Assistant text
 * is streamed past anyway, so its shingles are free to collect. Sampling one in sixteen keeps the
 * set to a few hundred thousand entries on an 82 MB transcript while still lighting up on any
 * paste longer than a sentence - a verbatim run of a hundred words contributes roughly six
 * sampled shingles, and a person does not reproduce six of those by coincidence.
 */
const SHINGLE = 10;
const SAMPLE_MASK = 0xf;
const SHINGLE_CAP = 2_000_000;

function shingles(text: string): number[] {
  const words = text.toLowerCase().replace(/\s+/g, " ").trim().split(" ");
  if (words.length < SHINGLE) return [];
  const out: number[] = [];
  for (let i = 0; i + SHINGLE <= words.length; i += 1) {
    // FNV-1a over the window. Cheap, and collisions only ever cost a false positive on a
    // ratio that is reported rather than acted on.
    let h = 0x811c9dc5;
    for (let j = i; j < i + SHINGLE; j += 1) {
      const w = words[j] as string;
      for (let k = 0; k < w.length; k += 1) {
        h ^= w.charCodeAt(k);
        h = Math.imul(h, 0x01000193);
      }
      h ^= 32;
      h = Math.imul(h, 0x01000193);
    }
    h >>>= 0;
    if ((h & SAMPLE_MASK) === 0) out.push(h);
  }
  return out;
}

function quotedRatio(text: string, seen: Set<number>): number | null {
  if (text.length < 900 || seen.size === 0) return null;
  const s = shingles(text);
  if (s.length < 4) return null;
  let hits = 0;
  for (const h of s) if (seen.has(h)) hits += 1;
  const ratio = hits / s.length;
  return ratio >= 0.2 ? Number(ratio.toFixed(3)) : null;
}

/**
 * Exact containment against recent machine output, for utterances too short to winnow.
 *
 * The record that proves this is needed is 203 characters long: "9,000 GPU instructions issued per
 * token where the competition issues 10-30" - the human quoting a figure the agent invented, which
 * the store would otherwise hand back as a named human's testimony. Thirty-five words sample to one
 * or two shingles, so the statistical test has no power there. Exact containment does, because a
 * twelve-word run reproduced verbatim is not a coincidence, and a person paraphrasing does not
 * reproduce one.
 *
 * Bounded to the last `RECENT_TURNS` assistant turns and a fixed prefix of each, so this stays a
 * constant-memory check on an 82 MB file rather than a growing one.
 */
const RECENT_TURNS = 40;
const RECENT_CHARS = 4_000;
const RUN_WORDS = 12;

const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, " ").trim();

function quotesRecent(text: string, recent: string[]): boolean {
  const words = norm(text).split(" ");
  if (words.length < RUN_WORDS) return false;
  for (let i = 0; i + RUN_WORDS <= words.length; i += 1) {
    const run = words.slice(i, i + RUN_WORDS).join(" ");
    for (const r of recent) if (r.includes(run)) return true;
  }
  return false;
}

function utterance(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const blocks = content as Array<{ type?: unknown; text?: unknown }>;
  if (blocks.some((b) => b?.type === "tool_result")) return null;
  const text = blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
  return text.length > 0 ? text : null;
}

export async function ingestClaudeTranscript(db: Db, opts: IngestOptions): Promise<IngestReport> {
  const role: DbRole = opts.role ?? "app";
  const includeAgent = opts.includeAgent ?? false;
  const humanActor = requireActor("humanActor", opts.humanActor);
  const agentActor = requireActor("agentActor", opts.agentActor ?? "agent:claude-code");

  const report: IngestReport = {
    file: opts.file,
    sessions: 0,
    episodes: 0,
    skipped: 0,
    duplicates: 0,
    byRole: {},
  };

  // uuid -> episode id, so a reply threads onto the thing it replied to. Only records this run
  // actually recorded are in here: a parent that was filtered out (a tool result, an injected
  // wrapper) leaves the child unthreaded rather than pointing at the wrong ancestor.
  const threads = new Map<string, string>();
  // Bounded: an 82 MB transcript samples to a few hundred thousand entries.
  const agentSeen = new Set<number>();
  const recentAgent: string[] = [];
  // sessionId -> how many of its records have gone past, recorded or not. `seq` is the record's
  // ordinal in its session, not a counter of episodes, so flipping `includeAgent` or re-running
  // with a different `limit` does not renumber — and therefore does not re-hash — anything.
  const ordinals = new Map<string, number>();
  const sessions = new Set<string>();

  const stream = createReadStream(opts.file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let lineNo = 0;
  try {
    for await (const line of lines) {
      lineNo += 1;
      if (line.trim().length === 0) continue;

      let record: TranscriptRecord;
      try {
        record = JSON.parse(line) as TranscriptRecord;
      } catch {
        // A truncated final line is normal in a transcript being written to live.
        continue;
      }

      const sessionId = str(record.sessionId);
      if (!sessionId) continue;
      const ordinal = ordinals.get(sessionId) ?? 0;
      ordinals.set(sessionId, ordinal + 1);

      const type = record.type;
      const isHuman = type === "user";
      const isAgent = type === "assistant";

      // Every assistant turn contributes to the quote-back index whether or not it is stored.
      // Skipping agent prose is about what belongs in the record; knowing what the machine said
      // is about being able to tell later whether a human turn is really the human's words.
      if (isAgent && agentSeen.size < SHINGLE_CAP) {
        const said = utterance(record.message?.content);
        // Floor is low on purpose. A short agent claim - "throughput is 757.5 tok/s" - is the
        // most dangerous thing to have quoted back, because it is exactly the shape that reads as
        // a fact. A 200-character floor made those invisible, which a test caught.
        if (said !== null && said.length >= 80) {
          for (const h of shingles(said)) agentSeen.add(h);
          recentAgent.push(norm(said).slice(0, RECENT_CHARS));
          if (recentAgent.length > RECENT_TURNS) recentAgent.shift();
        }
      }

      if (!isHuman && !(isAgent && includeAgent)) continue;

      // `isCompactSummary` is the single most important exclusion in this file, and it is not
      // about noise. A compaction summary arrives in the user's slot as ordinary text, 15-21k
      // characters of it, and the whole reason this store exists is that summarising a session
      // keeps the conclusions and drops the qualifiers - "757.5" survives, "on
      // release/openrouter-ready" does not. Ingesting one would file a document that has already
      // lost its provenance as testimony from a named human, and it would then outrank real
      // sentences on every search by sheer length. The eight in the Arc corpus are exactly the
      // eight compaction boundaries that caused the confident-wrong behaviour in the first place.
      //
      // `isVisibleInTranscriptOnly` marks UI-local text that was never sent to anybody.
      if (
        record.isMeta === true ||
        record.isCompactSummary === true ||
        record.isVisibleInTranscriptOnly === true
      ) {
        report.skipped += 1;
        continue;
      }

      const raw = utterance(record.message?.content);
      if (raw === null) {
        report.skipped += 1;
        continue;
      }
      const text = raw.trim();
      // `<command-name>`, `<local-command-stdout>`, `<system-reminder>`: the harness talking to
      // itself through the user's slot. Nobody said these.
      //
      // `[Request interrupted by user]` and friends are the client narrating an event in the
      // first person. It happened, but nobody uttered it, and 45 copies of it would be the most
      // frequent "quote" in the corpus.
      if (text.length === 0 || text.startsWith("<") || /^\[[^\]]{3,60}\]$/.test(text)) {
        report.skipped += 1;
        continue;
      }

      // Who typed it is not the same question as who wrote it.
      //
      // Measured on this corpus: 23 of 550 human utterances carry 83.4% of its entire volume,
      // and all 23 are machine-authored prose arriving in the user's slot. Eight are compaction
      // summaries, excluded above by flag. The other fifteen are pasted tables and quote-backs -
      // the human copying the agent's own output back into the conversation to argue with it.
      //
      // Those must NOT be dropped: the human really did type them, and the act of quoting is
      // itself part of the record. But the WORDS are the machine's, and one of them is a verbatim
      // paste of an invented "9,000 GPU instructions issued per token" that the store would
      // otherwise return as testimony from a named human. That is the 808-duplicate mechanism
      // with a human in the middle of the loop instead of a re-extractor, and attribution alone
      // cannot see it: `actor` is correct and the provenance is still wrong.
      //
      // So the signal is recorded rather than the row discarded, and read paths label it. A
      // caller can then tell "Jish decided X" from "Jish pasted the agent saying X", which is
      // the whole distinction. Structural rather than semantic on purpose: it needs no model and
      // cannot drift.
      const machine = machineProse(text);
      const quoted = isHuman ? quotedRatio(text, agentSeen) : null;
      // Only when winnowing declined to judge, so the two mechanisms never disagree on one row.
      const echoes = isHuman && quoted === null ? quotesRecent(text, recentAgent) : false;

      const occurredAt = str(record.timestamp);
      if (!occurredAt) {
        report.skipped += 1;
        continue;
      }

      const parentUuid = str(record.parentUuid);
      const input: EpisodeInput = {
        scope: opts.scope,
        session_id: sessionId,
        seq: ordinal,
        occurred_at: occurredAt,
        actor: isHuman ? humanActor : agentActor,
        role: isHuman ? "human" : "agent",
        text,
        parent_id: parentUuid ? (threads.get(parentUuid) ?? null) : null,
        git_branch: str(record.gitBranch),
        git_commit: null,
        cwd: str(record.cwd),
        source: {
          kind: "claude-code-transcript",
          file: opts.file,
          line: lineNo,
          uuid: str(record.uuid),
          // Present only when it fired, so its absence is not a claim either way.
          ...(machine ? { machine_prose: machine } : {}),
          ...(quoted === null ? {} : { quoted_from_agent: quoted }),
          ...(echoes ? { echoes_agent_verbatim: true } : {}),
        },
      };

      const { episode, created } = await recordEpisode(db, input, role);
      report.episodes += 1;
      if (!created) report.duplicates += 1;
      report.byRole[input.role] = (report.byRole[input.role] ?? 0) + 1;
      sessions.add(sessionId);

      const uuid = str(record.uuid);
      if (uuid) threads.set(uuid, episode.id);

      if (opts.limit !== undefined && report.episodes >= opts.limit) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  report.sessions = sessions.size;
  return report;
}

/** Every `.jsonl` in a directory, in name order so two runs report in the same sequence. */
export async function ingestClaudeDir(db: Db, opts: IngestDirOptions): Promise<IngestReport[]> {
  const entries = await readdir(opts.dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && basename(e.name).endsWith(".jsonl"))
    .map((e) => join(opts.dir, e.name))
    .sort();

  const reports: IngestReport[] = [];
  for (const file of files) {
    reports.push(
      await ingestClaudeTranscript(db, {
        file,
        scope: opts.scope,
        humanActor: opts.humanActor,
        ...(opts.agentActor === undefined ? {} : { agentActor: opts.agentActor }),
        ...(opts.includeAgent === undefined ? {} : { includeAgent: opts.includeAgent }),
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        ...(opts.role === undefined ? {} : { role: opts.role }),
      }),
    );
  }
  return reports;
}
