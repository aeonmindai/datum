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
