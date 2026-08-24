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
import { compactAssertion, compactState, pack, DEFAULT_BUDGET_BYTES } from "./compact.js";

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
      "Who is out there: agents, worktrees, branches, repos and humans registered in a scope, " +
      "with last_seen. This is what makes a hundred worktrees legible instead of frightening.",
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string" }, kind: { type: "string" }, max_bytes: { type: "number" } },
    },
  },
] as const;

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
        const [{ chain, mode }, sequence, missionRows, open] = await Promise.all([
          resolveChain(db, parsed.scope),
          currentSequence(db),
          missions(db, parsed.scope),
          contradictions(db, { status: "open", limit: 500 }),
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
            max_bytes: z.number().optional(),
          })
          .parse(args);
        requirePermission(key, "read");
        const scope = parsed.scope ?? key.scope;
        requireScope(key, scope);
        const { rows } = await db.query<{
          kind: string;
          label: string;
          scope: string;
          role: string | null;
          last_seen: string | null;
        }>(
          "app",
          `SELECT kind, label, scope, role, last_seen FROM datum.nodes
            WHERE retired_at IS NULL AND (scope = $1 OR scope LIKE $1 || '/%')
              AND ($2::text IS NULL OR kind = $2)
            ORDER BY last_seen DESC NULLS LAST LIMIT 100`,
          [scope, parsed.kind ?? null],
        );
        return pack(
          rows.map(
            (n) =>
              `${n.kind}:${n.label}${n.role ? `(${n.role})` : ""} ${n.scope} ` +
              `last_seen=${n.last_seen ? new Date(n.last_seen).toISOString().slice(0, 16) : "never"}`,
          ),
          budget,
          `no nodes registered under ${scope}`,
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
