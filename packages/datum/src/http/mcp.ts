import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { asRejection, Rejection } from "../domain/errors.js";
import { newId } from "../domain/identity.js";
import { resolveChain } from "../domain/scope.js";
import {
  assertFact,
  byId,
  contradictions,
  currentSequence,
  lineage,
  logRejection,
  missions,
  search,
  take,
} from "../domain/store.js";
import { CONFIDENCE_CLASSES, KINDS } from "../domain/types.js";
import { authenticateKey, requirePermission, requireScope } from "./auth.js";
import { activePreferences, recordFeedback } from "../preferences/index.js";
import { impact } from "../graph/index.js";
import { compactAssertion, compactState, pack, short, DEFAULT_BUDGET_BYTES } from "./compact.js";
import { searchEpisodes } from "../episodes/read.js";
import { recallEpisodes } from "../episodes/recall.js";
import { whyPath, whySymbol } from "../episodes/why.js";
import { fleet as fleetView } from "../fleet/index.js";
import { resumeState } from "../episodes/resume.js";

/**
 * `/mcp` — the facade. Six tools, not thirty.
 *
 * Every tool definition is injected into every agent session that connects, so the tool list is
 * itself a permanent context cost. Thirty tools is a tax on every turn of every agent forever.
 *
 * Statelessness is normative in MCP 2026-07-28 — sessions, the initialize handshake, ping, the
 * GET endpoint and Last-Event-ID resumability were all removed — so this endpoint holds no state
 * between requests. The `initialize` method is still answered, because clients in the field
 * still send it and refusing would break them for no gain.
 */

const PROTOCOL_VERSION = "2026-07-28";
const DATE_SHAPED = /^\d{4}-\d{2}-\d{2}$/;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "state",
    description:
      "Take the current state of a scope: mode, sequence, live fact counts by confidence class, " +
      "binding rules, contested pairs, and every active mission with its gates. Start here.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "e.g. org/acme/proj/checkout" },
        max_bytes: { type: "number", description: "response budget; default 240" },
      },
      required: ["scope"],
    },
  },
  {
    name: "ask",
    description:
      "Take a datum. Exact-first: filter by subject/predicate/kind, or pass q for full text. " +
      "Superseded facts are never returned. Every line carries its confidence class and evidence.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        subject: { type: "string" },
        predicate: { type: "string" },
        kind: { type: "string", enum: KINDS },
        q: { type: "string", description: "full-text query; used only if subject/predicate absent" },
        as_of: { type: "number", description: "assert-time sequence: what did we believe at N" },
        max_bytes: { type: "number" },
      },
      required: ["scope"],
    },
  },
  {
    name: "why",
    description:
      "Why is this on datum? Returns the evidence, the verification outcome if any, the full " +
      "supersession chain, and any contradiction it is part of.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, max_bytes: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "assert",
    description:
      "Record a fact with evidence. evidence.source is required. You CANNOT assert measured: " +
      "every write lands unverified and is promoted only after its commit is checked. " +
      "kind=failed requires reopen_if — the falsifier that would justify retrying.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        subject: { type: "string" },
        predicate: { type: "string" },
        value: { description: "the value; wrapped into object.value" },
        unit: { type: "string" },
        claim: { type: "string", description: "one human sentence; used for full-text search" },
        kind: { type: "string", enum: KINDS },
        binding: { type: "boolean", description: "true = a rule whose violation is a regression" },
        confidence: { type: "string", enum: ["unverified", "confirmed-by-human"] },
        evidence: {
          type: "object",
          properties: {
            source: { type: "string" },
            repo: { type: "string" },
            commit: { type: "string" },
            contained_in: { type: "array", items: { type: "string" } },
            instrument: { type: "string" },
            protocol: { type: "string" },
            human: { type: "string", description: "required when confidence=confirmed-by-human" },
          },
          required: ["source"],
        },
        why: { type: "string" },
        reopen_if: { type: "string" },
        valid_from: { type: "string" },
      },
      required: ["scope", "subject", "predicate", "kind", "evidence"],
    },
  },
  {
    name: "supersede",
    description:
      "Correct a fact. This never edits: it writes a new assertion that replaces the named one. " +
      "You must supersede the live head of a chain, not an already-superseded row.",
    inputSchema: {
      type: "object",
      properties: {
        supersedes: { type: "string" },
        scope: { type: "string" },
        subject: { type: "string" },
        predicate: { type: "string" },
        value: {},
        unit: { type: "string" },
        claim: { type: "string" },
        kind: { type: "string", enum: KINDS },
        confidence: { type: "string", enum: ["unverified", "confirmed-by-human"] },
        evidence: { type: "object", properties: { source: { type: "string" } }, required: ["source"] },
        why: { type: "string" },
        reopen_if: { type: "string" },
      },
      required: ["supersedes", "scope", "subject", "predicate", "kind", "evidence"],
    },
  },
  {
    name: "nodes",
    description:
      "Who is out there and what are they doing: agents, worktrees, branches, repos and humans " +
      "registered in a scope, each with whether it is still alive, its last reported activity, " +
      "and which paths it has claimed. Call it before you start editing — if another worktree " +
      "has claimed the file, you find out now instead of in a merge. This is what makes a " +
      "hundred worktrees legible instead of frightening.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        kind: { type: "string" },
        stale_seconds: { type: "number", description: "older heartbeat than this counts as not live; default 300" },
        max_bytes: { type: "number" },
      },
    },
  },
  {
    name: "recall",
    description:
      "What was SAID, as opposed to what is true. Returns dated, attributed quotes from past " +
      "sessions — the decision nobody wrote down, the correction you were given, the approach " +
      "that was abandoned and why. Pass `symbol` or `path` instead of `q` to ask why a piece of " +
      "code is the way it is, which git blame cannot tell you because the reason was in a " +
      "conversation. Every hit says how it matched, so an exact quote is never confused with a " +
      "fuzzy one. A quote is NOT a fact: it can support what a person said and can never satisfy " +
      "a target. Use `ask` for numbers, this for reasons.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        q: { type: "string", description: "words to look for in what was said" },
        symbol: { type: "string", description: "ask why this symbol is the way it is" },
        path: { type: "string", description: "ask why this file is the way it is" },
        actor: { type: "string", description: "only what this person or agent said" },
        branch: { type: "string", description: "only what was said while on this branch" },
        since: { type: "string", description: "ISO timestamp lower bound" },
        limit: { type: "number" },
        max_bytes: { type: "number" },
      },
      required: ["scope"],
    },
  },
  {
    name: "impact",
    description:
      "If I change this symbol, what else must I care about? Returns everything that reaches it, " +
      "which tests cover it, and — separately, never mixed in — anything reached only through an " +
      "edge the indexer could not pin down. An empty answer means nothing calls it, which is the " +
      "answer you want before deleting something and the one a text search cannot give you.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "name, qualified name, or id:<n> for an exact symbol" },
        repo: { type: "string", description: "owner/name; omit to use the only indexed repo" },
        depth: { type: "number", description: "how many hops out; default 1" },
        max_bytes: { type: "number" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "feedback",
    description:
      "Record that a human corrected you. Nothing is learned from one report — repetition on a " +
      "DIFFERENT occasion earns a preference, and corroboration by other people turns it into a " +
      "team then an org rule that every agent is told before it starts work. Call this when you " +
      "are corrected, and the correction stops recurring.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        subject: { type: "string", description: "what the feedback is about, e.g. commit_messages" },
        predicate: { type: "string", description: "which aspect, e.g. style" },
        correction: { type: "object", description: "what they wanted instead" },
        occasion: { type: "string", description: "this session or PR id. Repeats within one occasion count once." },
        actor: { type: "string", description: "the human who said it" },
        raw: { type: "string", description: "their words, verbatim" },
      },
      required: ["scope", "subject", "predicate", "correction", "occasion", "actor"],
    },
  },
] as const;

/**
 * `repo` is optional on the impact tool because most instances index one repository and making an
 * agent name it is friction for nothing. If several are indexed, the caller must say which — a
 * silent pick would answer confidently about the wrong codebase.
 */
async function onlyIndexedRepo(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ repo: string }>(
    "app",
    `SELECT DISTINCT repo FROM datum.code_index WHERE completed_at IS NOT NULL LIMIT 2`,
  );
  return rows.length === 1 ? (rows[0]?.repo ?? null) : null;
}

/** The scope a repo's newest completed index sits in, so the key's reach is checked against the
 *  same scope the answer came from. */
async function resolveIndexScope(db: Db, repo: string): Promise<string | null> {
  const row = await db.one<{ scope: string }>(
    "app",
    `SELECT scope FROM datum.code_index
      WHERE repo = $1 AND completed_at IS NOT NULL
      ORDER BY indexed_at DESC LIMIT 1`,
    [repo],
  );
  return row?.scope ?? null;
}

const ToolCall = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const AskArgs = z.object({
  scope: z.string(),
  subject: z.string().optional(),
  predicate: z.string().optional(),
  kind: z.enum(KINDS).optional(),
  q: z.string().optional(),
  as_of: z.number().int().positive().optional(),
  max_bytes: z.number().int().min(80).max(20_000).optional(),
});

const AssertArgs = z.object({
  scope: z.string(),
  subject: z.string(),
  predicate: z.string(),
  value: z.unknown().optional(),
  unit: z.string().optional(),
  object: z.record(z.string(), z.unknown()).optional(),
  claim: z.string().optional(),
  kind: z.enum(KINDS),
  binding: z.boolean().optional(),
  // Advertised as unverified|confirmed-by-human in the tool schema, but parsed permissively so a
  // model that ignores the schema still gets the database's real reason rather than a parse error.
  confidence: z.enum(CONFIDENCE_CLASSES).optional(),
  evidence: z.object({ source: z.string().min(1) }).loose(),
  why: z.string().optional(),
  reopen_if: z.string().optional(),
  valid_from: z.string().optional(),
  supersedes: z.string().optional(),
});

export function registerMcp(app: FastifyInstance, deps: { db: Db; config: Config }): void {
  const { db, config } = deps;

  const runTool = async (
    name: string,
    args: Record<string, unknown>,
    authorization: string | undefined,
  ): Promise<string> => {
    const key = await authenticateKey(db, authorization);
    const budget = typeof args.max_bytes === "number" ? args.max_bytes : DEFAULT_BUDGET_BYTES;

    switch (name) {
      case "state": {
        const parsed = AskArgs.pick({ scope: true, max_bytes: true }).parse(args);
        requirePermission(key, "read");
        requireScope(key, parsed.scope);
        const [{ chain, mode }, sequence, missionRows, open, prefs, resume] = await Promise.all([
          resolveChain(db, parsed.scope),
          currentSequence(db),
          missions(db, parsed.scope),
          contradictions(db, { status: "open", limit: 500 }),
          activePreferences(db, parsed.scope),
          resumeState(db, { scope: parsed.scope, limit: 1 }),
        ]);
        const counts = await db.query<{ confidence: string; n: string }>(
          "app",
          `SELECT confidence, count(*)::text AS n FROM datum.assertions
            WHERE superseded_by IS NULL AND scope = ANY($1::text[]) GROUP BY confidence`,
          [chain],
        );
        const binding = await db.one<{ n: string }>(
          "app",
          `SELECT count(*)::text AS n FROM datum.assertions
            WHERE superseded_by IS NULL AND binding AND scope = ANY($1::text[])`,
          [chain],
        );
        const byConfidence: Record<string, number> = {};
        for (const c of counts.rows) byConfidence[c.confidence] = Number(c.n);
        return compactState(
          {
            scope: parsed.scope,
            mode,
            sequence,
            live: Object.values(byConfidence).reduce((a, b) => a + b, 0),
            byConfidence,
            contested: open.length,
            bindingRules: Number(binding?.n ?? 0),
            missions: missionRows,
            preferences: prefs.map((p) => ({
              tier: p.tier,
              statement: p.statement,
              occasions: p.occasions,
              distinct_humans: p.distinct_humans,
              binding: p.tier === "org",
            })),
            resume:
              resume.last_session === null || resume.age_hours === null
                ? null
                : {
                    session: resume.last_session.id,
                    age_hours: resume.age_hours,
                    turns: resume.last_session.episodes,
                    branch: resume.last_session.branches[0] ?? null,
                    open_question: resume.open_questions[0]?.text ?? null,
                    stale_note: resume.drift?.note ?? null,
                  },
          },
          budget,
        );
      }

      case "ask": {
        const parsed = AskArgs.parse(args);
        requirePermission(key, "read");
        requireScope(key, parsed.scope);
        if (parsed.q && !parsed.subject && !parsed.predicate) {
          const rows = await search(db, parsed.scope, parsed.q, 25);
          return pack(rows.map(compactAssertion), budget, `nothing on datum matching "${parsed.q}"`);
        }
        const result = await take(db, {
          scope: parsed.scope,
          subject: parsed.subject ?? null,
          predicate: parsed.predicate ?? null,
          kind: parsed.kind ?? null,
          asOf: parsed.as_of ?? null,
          limit: 50,
        });
        const header =
          parsed.as_of !== undefined
            ? `as of s${parsed.as_of} (mode=${result.mode})`
            : `now (mode=${result.mode})`;
        // Contested rows are mandatory: an agent receiving one side of a disagreement and not
        // the other would treat a disputed number as settled.
        const contested = result.assertions.filter((a) => a.contested).map(compactAssertion);
        const rest = result.assertions.filter((a) => !a.contested).map(compactAssertion);
        return pack(rest, budget, "no facts on datum for this query", [header, ...contested]);
      }

      case "why": {
        const parsed = z.object({ id: z.string(), max_bytes: z.number().optional() }).parse(args);
        const row = await byId(db, parsed.id);
        if (!row) throw new Rejection({ reason: "not_found", message: `no assertion ${parsed.id}` });
        requirePermission(key, "read");
        requireScope(key, row.scope);
        const chain = await lineage(db, parsed.id);
        const verification = row.verification_id
          ? await db.one<{ outcome: string; checker: string; detail: Record<string, unknown> }>(
              "app",
              `SELECT outcome, checker, detail FROM datum.verifications WHERE id = $1`,
              [row.verification_id],
            )
          : null;
        const conflicts = await db.query<{ id: string; status: string }>(
          "app",
          `SELECT id, status FROM datum.contradictions WHERE a_id=$1 OR b_id=$1`,
          [parsed.id],
        );
        const lines = [compactAssertion(row)];
        const e = row.evidence ?? { source: "?" };
        lines.push(
          `evidence: ${[
            e.repo ? `repo=${String(e.repo)}` : null,
            e.commit ? `commit=${String(e.commit).slice(0, 12)}` : null,
            Array.isArray(e.contained_in) && e.contained_in.length
              ? `in=${e.contained_in.join(",")}`
              : null,
            e.instrument ? `instrument=${String(e.instrument)}` : null,
            e.human ? `human=${String(e.human)}` : null,
            `source=${String(e.source)}`,
          ]
            .filter(Boolean)
            .join(" ")}`,
        );
        if (e.protocol) lines.push(`protocol: ${String(e.protocol)}`);
        if (verification) {
          lines.push(`verification: ${verification.outcome} by ${verification.checker}`);
        } else if (row.confidence === "unverified") {
          lines.push("verification: not yet promoted — this is not a measurement");
        }
        if (row.why) lines.push(`why: ${row.why}`);
        if (row.reopen_if) lines.push(`reopen_if: ${row.reopen_if}`);
        if (chain.length > 1) {
          lines.push(
            `chain (${chain.length}): ${chain
              .map((c) => `${c.id.slice(0, 10)}=${String(c.object?.value)}[${c.confidence}]`)
              .join(" -> ")}`,
          );
        }
        for (const c of conflicts.rows) lines.push(`contradiction ${c.id} ${c.status}`);
        // `why` is the one tool worth spending bytes on: it is asked precisely when an agent is
        // about to rely on something, so its budget floor is higher.
        return pack(lines, Math.max(budget, 600), "");
      }

      case "assert":
      case "supersede": {
        const parsed = AssertArgs.parse(args);
        requirePermission(key, name === "supersede" ? "supersede" : "assert");
        requireScope(key, parsed.scope);
        if (name === "supersede" && !parsed.supersedes) {
          throw new Rejection({
            reason: "malformed_request",
            message: "supersede requires `supersedes`: the id of the live row being replaced.",
          });
        }
        const object =
          parsed.object ??
          ({ value: parsed.value, ...(parsed.unit ? { unit: parsed.unit } : {}) } as Record<
            string,
            unknown
          >);
        const result = await assertFact(
          db,
          {
            scope: parsed.scope,
            subject: parsed.subject,
            predicate: parsed.predicate,
            object,
            claim: parsed.claim ?? null,
            kind: parsed.kind,
            binding: parsed.binding ?? false,
            confidence: parsed.confidence ?? "unverified",
            evidence: parsed.evidence,
            why: parsed.why ?? null,
            reopen_if: parsed.reopen_if ?? null,
            valid_from: parsed.valid_from,
            supersedes: parsed.supersedes ?? null,
            asserted_by: `key:${key.label}`,
            causality: newId("evt"),
          },
          { role: "app" },
        );
        const a = result.assertion;
        return (
          `${result.created ? "recorded" : "already on datum"} ${a.id} | ${compactAssertion(a)}` +
          (a.confidence === "unverified"
            ? "\nlanded unverified. it becomes measured only when the worker confirms evidence.commit."
            : "")
        );
      }

      case "nodes": {
        const parsed = z
          .object({
            scope: z.string().optional(),
            kind: z.string().optional(),
            stale_seconds: z.number().int().positive().optional(),
            max_bytes: z.number().optional(),
          })
          .parse(args);
        requirePermission(key, "read");
        const scope = parsed.scope ?? key.scope;
        requireScope(key, scope);
        const members = await fleetView(db, {
          scope,
          ...(parsed.stale_seconds === undefined ? {} : { staleSeconds: parsed.stale_seconds }),
        });
        const shown = parsed.kind ? members.filter((m) => m.kind === parsed.kind) : members;
        // A claimed path is mandatory, for the same reason a contested pair is: it is the one line
        // that stops two agents editing one file, and a line dropped to save bytes stops nothing.
        const mandatory: string[] = [];
        const optional: string[] = [];
        for (const m of shown) {
          const age = Number.isFinite(m.seconds_ago) ? `${Math.round(m.seconds_ago)}s` : "never";
          const line =
            `${m.live ? "" : "STALE "}${m.kind}:${m.label}${m.role ? `(${m.role})` : ""} ` +
            `${m.scope} beat=${age}` +
            (m.activity ? ` doing="${short(m.activity, 60)}"` : "") +
            (m.claims.length > 0 ? ` holds=${m.claims.slice(0, 4).join(",")}` : "");
          if (m.claims.length > 0 && m.live) mandatory.push(line);
          else optional.push(line);
        }
        return pack(optional, budget, `no nodes registered under ${scope}`, mandatory);
      }

      case "recall": {
        const parsed = z
          .object({
            scope: z.string(),
            q: z.string().optional(),
            symbol: z.string().optional(),
            path: z.string().optional(),
            actor: z.string().optional(),
            branch: z.string().optional(),
            since: z.string().optional(),
            limit: z.number().int().positive().max(100).optional(),
            max_bytes: z.number().optional(),
          })
          .parse(args);
        requirePermission(key, "read");
        requireScope(key, parsed.scope);

        // A code target is a recall with a different needle, not a different product. Routing it
        // here keeps one tool where an agent would otherwise have to know which of two to reach
        // for, and choosing between two data sources is the thing agents get wrong.
        if (parsed.symbol || parsed.path) {
          const why = parsed.symbol
            ? await whySymbol(db, {
                scope: parsed.scope,
                symbol: parsed.symbol,
                ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
              })
            : await whyPath(db, {
                scope: parsed.scope,
                path: parsed.path as string,
                ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
              });
          const header =
            `${why.target}` +
            (why.resolved?.path ? ` -> ${why.resolved.path}:${why.resolved.line_start ?? "?"}` : "") +
            ` mentions=${why.mentions.length} facts=${why.facts.length}`;
          // The note is mandatory. It is where ambiguity and basename-only matches are admitted,
          // and an answer that drops its own caveat to fit a budget is worse than no answer.
          const head = why.note ? [header, `note: ${short(why.note, 200)}`] : [header];
          return pack(
            why.mentions.map(
              (m) =>
                `${m.episode.occurred_at instanceof Date ? m.episode.occurred_at.toISOString().slice(0, 16) : String(m.episode.occurred_at).slice(0, 16)} ` +
                `${m.episode.actor}${m.episode.git_branch ? `@${m.episode.git_branch}` : ""} ` +
                `[${m.why}] "${short(m.excerpt, 180)}"`,
            ),
            budget,
            `nothing was ever said about ${why.target}`,
            head,
          );
        }

        // Two paths, split on what the caller actually gave us. An explicit filter - this actor,
        // this branch, this time - is an instruction to honour exactly. A bare question is a
        // question, and interpreting it (reading the date out of it, weighting terms by how rare
        // they really are here) is the difference between 62.5% and finding the answer.
        const filtered =
          parsed.actor !== undefined || parsed.branch !== undefined || parsed.since !== undefined;
        if (!filtered && parsed.q !== undefined) {
          const r = await recallEpisodes(db, {
            scope: parsed.scope,
            question: parsed.q,
            ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
          });
          const lines = r.hits.map((h) => {
            const e = h.episode;
            const when =
              e.occurred_at instanceof Date
                ? e.occurred_at.toISOString().slice(0, 16)
                : String(e.occurred_at).slice(0, 16);
            const src = e.source as Record<string, unknown> | null;
            const relayed =
              src &&
              (src["quoted_from_agent"] !== undefined ||
                src["echoes_agent_verbatim"] === true ||
                src["machine_prose"] !== undefined)
                ? " RELAYED-AGENT-PROSE"
                : "";
            return `${when} ${e.actor}${e.git_branch ? `@${e.git_branch}` : ""} [${h.tier}]${relayed} "${short(e.text, 170)}"`;
          });
          // The note is mandatory: it is where "no term matched, this is the whole window" and
          // "these words appear nowhere in this corpus" get said, and a caller that loses it
          // cannot tell a targeted hit from a time-sliced guess.
          //
          // But on real data the note measured 145 bytes against a 240-byte budget, so it
          // consumed the whole response and all twelve quotes were dropped — a recall returning
          // its own metadata and no evidence. So the first quote is mandatory too: an answer with
          // no evidence in it is not an answer, and the note is a caveat ABOUT evidence that is
          // not there. Same failure as dropping one side of a contested pair, one layer up.
          const first = lines.length > 0 ? [lines[0] as string] : [];
          return pack(
            lines.slice(1),
            budget,
            `nothing on record was said about that in ${parsed.scope}`,
            [short(r.note, 170), ...first],
          );
        }
        const hits = await searchEpisodes(db, {
          scope: parsed.scope,
          ...(parsed.q === undefined ? {} : { text: parsed.q }),
          ...(parsed.actor === undefined ? {} : { actor: parsed.actor }),
          ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
          ...(parsed.since === undefined ? {} : { since: parsed.since }),
          ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        });
        return pack(
          hits.map((h) => {
            const e = h.episode;
            const when =
              e.occurred_at instanceof Date
                ? e.occurred_at.toISOString().slice(0, 16)
                : String(e.occurred_at).slice(0, 16);
            // `matched` travels with every quote. A rescued typo and an exact hit look identical
            // otherwise, and the caller has no way to weigh what it was handed.
            // A quote-back is still something the human typed, and its words are still the
            // machine's. Both facts have to survive to the caller or the store hands back an
            // invented number as a named human's testimony - which is the failure it exists for.
            const src = e.source as Record<string, unknown> | null;
            const relayed =
              src && (src["quoted_from_agent"] !== undefined || src["echoes_agent_verbatim"] === true || src["machine_prose"] !== undefined)
                ? " RELAYED-AGENT-PROSE"
                : "";
            return `${when} ${e.actor}${e.git_branch ? `@${e.git_branch}` : ""} [${h.matched}]${relayed} "${short(e.text, 170)}"`;
          }),
          budget,
          `nothing on record was said about that in ${parsed.scope}`,
        );
      }

      case "impact": {
        const parsed = z
          .object({
            symbol: z.string(),
            repo: z.string().optional(),
            depth: z.number().int().min(1).max(8).optional(),
            max_bytes: z.number().optional(),
          })
          .parse(args);
        requirePermission(key, "read");
        const repo = parsed.repo ?? (await onlyIndexedRepo(db));
        if (!repo) {
          throw new Rejection({
            reason: "not_found",
            message: "no code graph has been ingested. Run `datum index` then `datum ingest-graph`.",
          });
        }
        const r = await impact(db, {
          repo,
          symbol: parsed.symbol,
          ...(parsed.depth ? { depth: parsed.depth } : {}),
        });
        requireScope(key, (await resolveIndexScope(db, repo)) ?? key.scope);
        const lines = [
          `${r.target.name} ${r.target.path}:${r.target.line_start} @${r.commit_sha.slice(0, 8)}`,
        ];
        if (r.reached_by.length === 0 && r.ambiguous.length === 0) {
          // A real answer, and the one no text search can give.
          lines.push("nothing reaches this symbol — changing it breaks nothing here");
        }
        for (const h of r.reached_by) {
          lines.push(`d${h.depth} ${h.name} ${h.path}:${h.line_start} via ${h.via_kind} [${h.path_confidence}]`);
        }
        // Kept apart for the same reason the API keeps it apart: "might break" and "will break"
        // must not read alike.
        for (const h of r.ambiguous) {
          lines.push(`AMBIGUOUS ${h.name} ${h.path}:${h.line_start} — verify before trusting`);
        }
        if (r.covered_by_tests.length > 0) {
          lines.push(`tests: ${r.covered_by_tests.map((t) => t.name).join(", ")}`);
        }
        return pack(lines.slice(1), budget, "", [lines[0]!]);
      }

      case "feedback": {
        const parsed = z
          .object({
            scope: z.string(),
            subject: z.string(),
            predicate: z.string(),
            correction: z.record(z.string(), z.unknown()),
            occasion: z.string(),
            actor: z.string(),
            raw: z.string().optional(),
          })
          .parse(args);
        requirePermission(key, "assert");
        requireScope(key, parsed.scope);
        const r = await recordFeedback(db, parsed);
        return (
          `${r.created ? "recorded" : "already recorded for this occasion"} — ` +
          `${r.occasions} occasion(s), ${r.distinctHumans} human(s)\n` +
          (r.occasions < 2
            ? "one occasion is an event, not a pattern. nothing is learned until it recurs elsewhere."
            : r.distinctHumans >= 3
              ? "this is now an org rule and every agent is told before it starts work."
              : "a preference is now on record and will be delivered in `state`.")
        );
      }

      default:
        throw new Rejection({ reason: "not_found", message: `no such tool: ${name}` });
    }
  };

  app.post("/mcp", async (request, reply) => {
    const rpc = (request.body ?? {}) as JsonRpcRequest;
    const id = rpc.id ?? null;
    const respond = (result: unknown) => reply.send({ jsonrpc: "2.0", id, result });

    // A notification has no id and expects no body.
    if (rpc.method?.startsWith("notifications/")) return reply.code(202).send();

    switch (rpc.method) {
      case "initialize": {
        const requested = rpc.params?.protocolVersion;
        const version =
          typeof requested === "string" && DATE_SHAPED.test(requested) ? requested : PROTOCOL_VERSION;
        return respond({
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: "datum", version: "0.1.0" },
          instructions:
            "Datum is the datum of record. Every fact carries a confidence class and evidence; " +
            "superseded facts are never returned. You cannot assert `measured` — write it " +
            "unverified with evidence.commit and the verification worker promotes it. A fact " +
            "marked CONTESTED is disputed: report the conflict, do not treat it as settled. " +
            "/v1 is the full interface; these six tools are a convenience facade over it.",
        });
      }
      case "ping":
        return respond({});
      case "tools/list":
        return respond({ tools: TOOLS });
      case "tools/call": {
        const parsed = ToolCall.safeParse(rpc.params);
        if (!parsed.success) {
          return reply.send({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "tools/call requires { name, arguments }" },
          });
        }
        try {
          const text = await runTool(parsed.data.name, parsed.data.arguments ?? {}, request.headers.authorization);
          return respond({ content: [{ type: "text", text }], isError: false });
        } catch (err) {
          const rejection = asRejection(err);
          if (!rejection) {
            request.log.error({ err }, "mcp tool failed");
            return respond({
              content: [{ type: "text", text: "internal error" }],
              isError: true,
            });
          }
          if (parsed.data.name === "assert" || parsed.data.name === "supersede") {
            await logRejection(db, {
              actor: "mcp",
              route: `MCP ${parsed.data.name}`,
              rejection,
              scope: typeof parsed.data.arguments?.scope === "string" ? parsed.data.arguments.scope : null,
            });
          }
          // A refusal is returned as tool content, not as a transport error: the agent needs to
          // read the reason and fix the write, and an -32603 would hide it.
          return respond({
            content: [
              {
                type: "text",
                text: `REFUSED ${rejection.reason}${
                  rejection.hint ? `\n${rejection.hint}` : ""
                }\n${rejection.message}`,
              },
            ],
            isError: true,
          });
        }
      }
      default:
        return reply.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `unknown method: ${String(rpc.method)}` },
        });
    }
  });

  // RFC 9728. MCP 2026-07-28 expects an OAuth 2.1 resource server; bearer API keys are a
  // deliberate v0 shortcut, recorded as a `kind: state` assertion in the store so it cannot be
  // quietly forgotten. This stub exists so a spec-following client gets a coherent answer
  // rather than a 404.
  app.get("/.well-known/oauth-protected-resource", async (_request, reply) =>
    reply.send({
      resource: `${config.publicUrl}/mcp`,
      authorization_servers: [],
      bearer_methods_supported: ["header"],
      resource_documentation: `${config.publicUrl}/admin`,
      // Stated rather than implied: this instance does not speak OAuth yet.
      datum_auth_note:
        "v0 authenticates with opaque bearer API keys minted in /admin, not OAuth 2.1. " +
        "No authorization server is advertised because none exists.",
    }),
  );
}
