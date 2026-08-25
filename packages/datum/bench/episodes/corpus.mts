/**
 * The corpus under test: real Claude Code transcripts for the Arc project.
 *
 * Every arm of the benchmark and every verification pass reads the corpus through this file, so
 * there is exactly one definition of "a thing the human said" and no arm can be handed a different
 * one. The transcripts are 668 MB across six files; the largest single file is 82 MB. Nothing here
 * loads a file whole — `readHumanUtterances` streams line by line and keeps only the records that
 * survive the filter, which is 253,912 bytes of text. `grepLines` shells out and never buffers a
 * file at all.
 *
 * Line numbers are 1-based and are the *file* line, not an index into the filtered set. That is the
 * number a question's `source.line` carries and the number `sed -n '<line>p'` will print, which is
 * the property that makes a question checkable by hand.
 */
import { createReadStream, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const CORPUS_DIR = process.env.BENCH_TRANSCRIPT_DIR
  ?? "/Users/jish/.claude/projects/-Users-jish-Documents-GitHub-arc";

export interface Utterance {
  file: string;
  line: number;
  uuid: string;
  session: string;
  ts: string;
  branch: string | null;
  cwd: string | null;
  text: string;
  /** True when the text is machine-written prose the human merely pasted or a /compact injected. */
  pasted: boolean;
}

export function transcriptFiles(): string[] {
  return readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".jsonl")).sort();
}

/**
 * A record is a human utterance when it is a `user`-role `user` record carrying text the human
 * typed. Four exclusions, each measured against the whole corpus:
 *
 * - `isMeta` (290 records) — system-injected context, never typed.
 * - `tool_result` blocks (3,479) — the harness answering itself.
 * - `<command-name>` / `<local-command…>` wrappers (56) and `<task-notification>` blocks (741) —
 *   slash-command echoes and subagent completions. Not speech; the 741 notifications alone are
 *   2.4 MB, ten times the size of everything the human actually said.
 * - `[Request interrupted…]` markers (49) — the human pressing escape. A human act with no content,
 *   so it is excluded from the text corpus while still being counted: 550 utterances with text plus
 *   these 49 is the 599 figure the corpus is described by.
 *
 * `pasted` flags the 8 `/compact` continuation summaries. They are user-role records by transcript
 * mechanics but the prose in them is the model's, and 151,752 of the corpus's 253,912 bytes are in
 * those 8 records. They stay in the corpus — a retrieval system will meet them in production — but
 * `questions.json` never sources a claim from one, and a question asking what *the human* said is
 * verified absent over the whole set including them.
 */
export async function readHumanUtterances(): Promise<{ utterances: Utterance[]; interrupts: number }> {
  const utterances: Utterance[] = [];
  let interrupts = 0;
  for (const file of transcriptFiles()) {
    const rl = createInterface({ input: createReadStream(`${CORPUS_DIR}/${file}`), crlfDelay: Infinity });
    let line = 0;
    for await (const raw of rl) {
      line += 1;
      if (!raw.trim()) continue;
      let rec: Record<string, unknown>;
      try { rec = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
      if (rec["type"] !== "user" || rec["isMeta"]) continue;
      const msg = rec["message"] as { role?: string; content?: unknown } | undefined;
      if (!msg || msg.role !== "user") continue;

      let text: string | null = null;
      if (typeof msg.content === "string") text = msg.content;
      else if (Array.isArray(msg.content)) {
        const blocks = msg.content as { type?: string; text?: string }[];
        if (blocks.some((b) => b.type === "tool_result")) continue;
        const parts = blocks.filter((b) => b.type === "text" && typeof b.text === "string");
        if (parts.length) text = parts.map((b) => b.text).join("\n");
      }
      if (!text) continue;
      const t = text.trim();
      if (!t) continue;
      if (t.startsWith("[Request interrupted")) { interrupts += 1; continue; }
      if (t.startsWith("<")) continue;

      utterances.push({
        file, line,
        uuid: String(rec["uuid"] ?? ""),
        session: String(rec["sessionId"] ?? "").slice(0, 8),
        ts: String(rec["timestamp"] ?? ""),
        branch: (rec["gitBranch"] as string | undefined) ?? null,
        cwd: (rec["cwd"] as string | undefined) ?? null,
        text: t,
        pasted: t.startsWith("This session is being continued from a previous conversation"),
      });
    }
  }
  return { utterances, interrupts };
}

/** The exact bytes the full-context arm pays for, in transcript order. */
export function fullContext(utterances: Utterance[]): string {
  return utterances
    .map((u) => `[${u.file.slice(0, 8)}:${u.line} ${u.ts}${u.branch ? ` branch=${u.branch}` : ""}]\n${u.text}`)
    .join("\n\n");
}

export interface GrepHit { file: string; line: number; text: string }

/**
 * The grep arm's reader. `grep -F -i -n` over the raw `.jsonl`, one pattern, first `limit` hits in
 * file order. Fixed-string and case-insensitive because that is what an engineer types; `-a` because
 * the transcripts contain bytes grep will otherwise call binary and skip silently, which would hand
 * the baseline a loss it did not earn.
 *
 * A raw JSONL line is one record, so a hit is the whole record — assistant text included. The
 * baseline therefore searches a strict superset of what the other two arms see. That is deliberate:
 * a benchmark that starves its baseline proves nothing.
 */
export async function grepLines(pattern: string, limit: number): Promise<GrepHit[]> {
  const hits: GrepHit[] = [];
  for (const file of transcriptFiles()) {
    if (hits.length >= limit) break;
    let out = "";
    try {
      const r = await exec("grep", ["-F", "-i", "-n", "-a", "-m", String(limit), pattern, `${CORPUS_DIR}/${file}`],
        { maxBuffer: 1 << 28 });
      out = r.stdout;
    } catch { continue; } // exit 1 = no match
    for (const row of out.split("\n")) {
      if (!row || hits.length >= limit) continue;
      const cut = row.indexOf(":");
      if (cut < 0) continue;
      hits.push({ file, line: Number(row.slice(0, cut)), text: row.slice(cut + 1) });
    }
  }
  return hits;
}

/** Read one exact line of one transcript, for verifying a question's quote against its source. */
export async function readLine(file: string, target: number): Promise<string | null> {
  const rl = createInterface({ input: createReadStream(`${CORPUS_DIR}/${file}`), crlfDelay: Infinity });
  let n = 0;
  for await (const raw of rl) {
    n += 1;
    if (n === target) { rl.close(); return raw; }
  }
  return null;
}
