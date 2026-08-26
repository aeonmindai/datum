#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { ConfigError, loadConfig, type Config } from "../config.js";
import { Db } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { ingestClaudeDir, ingestClaudeTranscript } from "../episodes/ingest.js";
import { searchEpisodes } from "../episodes/read.js";
import { resumeState } from "../episodes/resume.js";
import { whyPath, whySymbol } from "../episodes/why.js";
import { fleet as fleetView } from "../fleet/index.js";
import { initInstance } from "../ops/init.js";
import { loadSeed, SEEDS_DIR } from "../ops/seed.js";
import { hashPassword } from "../http/auth.js";
import { serve } from "../http/server.js";
import { runVerificationPass } from "../worker/verify.js";
import { impact, ingestGraph } from "../graph/index.js";
import { indexRepo } from "../index/index.js";
import type { GraphArtifact } from "../graph/types.js";
import { gitIdentity, readProjectFile, writeProjectFile } from "./project.js";

/**
 * One binary. `serve`, `migrate`, `init`, `seed`, `hash-password` and `verify` are operator
 * commands and need DATABASE_URL. `link`, `mode` and `status` are the developer-facing side and
 * talk to a running instance over HTTP.
 */

const USAGE = `datum — the datum of record

  Operator commands (need DATABASE_URL):
    datum serve                      run the API, /mcp, /admin and the verification worker
    datum migrate                    apply migrations (idempotent; also runs on boot)
    datum init                       create the org scope and the first key (idempotent)
    datum seed --example             load the synthetic example fixture
    datum seed --file <path.json>    load a seed file
    datum verify [--once]            run one verification pass and print the outcomes
    datum hash-password [pw]         print an argon2id hash for DATUM_ADMIN_PASSWORD_HASH

  Code graph (index where the code is, load where the database is):
    datum index [--emit f.json]      parse this repo into a graph artifact (needs tree-sitter)
    datum ingest-graph <f.json>      load an artifact into the store (needs nothing)
    datum impact <symbol>            what else must I care about if I change this?

  Memory of what was said (index where the sessions are, load where the database is):
    datum ingest-sessions --dir D              parse Claude Code transcripts into episodes
    datum recall <words>                       what was said about this, dated and attributed
    datum recall --symbol S | --path P         why is this code the way it is
    datum resume                               where were we, and what was left unanswered
    datum fleet                                who else is working here, and on which files

  Project commands (need a running server):
    datum link [--server URL] [--scope PATH]   link this repo to its project scope
    datum mode global|isolated                 flip inheritance; writes a superseding assertion
    datum status                               who am I, which scope, which mode, what is the mission

  Environment:
    DATABASE_URL     postgres connection string
    DATUM_ORG        scope root label; org/<DATUM_ORG>   (default: local)
    DATUM_URL        server URL for project commands     (default: .datum.toml, else localhost)
    DATUM_KEY        API key for project commands
`;

function bail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function withDb<T>(fn: (db: Db, config: Config) => Promise<T>): Promise<T> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) bail(`\n${err.message}\n`);
    throw err;
  }
  const db = new Db(config.databaseUrl);
  try {
    return await fn(db, config);
  } finally {
    await db.close();
  }
}

/**
 * Operator commands need DATABASE_URL and nothing else. Whoever holds it already has every row,
 * so demanding an admin credential to run a migration is friction with no security behind it.
 *
 * This used to fake the credential by injecting placeholder strings, which broke on the one input
 * that matters: `export DATUM_ADMIN_PASSWORD=` sets an EMPTY string, and `??` does not substitute
 * for empty - only for null. So a half-configured shell, or a deploy with a blank secret, made
 * `datum migrate` refuse to run with a message about serving. Found by writing the onboarding
 * script and watching step 1 of 4 fail on a fresh database.
 */
async function withDbOnly<T>(fn: (db: Db, config: Config) => Promise<T>): Promise<T> {
  let config: Config;
  try {
    config = loadConfig(process.env, { serving: false });
  } catch (err) {
    if (err instanceof ConfigError) bail(`\n${err.message}\n`);
    throw err;
  }
  const db = new Db(config.databaseUrl);
  try {
    return await fn(db, config);
  } finally {
    await db.close();
  }
}

// ---------------------------------------------------------------------------------------
// HTTP client for the project commands.

interface Client {
  server: string;
  key: string;
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

async function client(explicitServer?: string): Promise<Client> {
  const project = await readProjectFile();
  const server = (explicitServer ?? process.env.DATUM_URL ?? project?.server ?? "http://localhost:8080").replace(
    /\/+$/,
    "",
  );
  const keyEnv = project?.key_env ?? "DATUM_KEY";
  const key = process.env.DATUM_KEY ?? process.env[keyEnv] ?? "";
  if (!key) {
    bail(
      `No API key. Set ${keyEnv} (or DATUM_KEY) to a key minted in ${server}/admin.\n` +
        `On a fresh instance the first key is printed once in the server logs.`,
    );
  }
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${server}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const detail =
        json && typeof json === "object" && "reason" in json
          ? `${String(json.reason)}: ${"message" in json ? String(json.message) : ""}`
          : `HTTP ${res.status}`;
      bail(`${method} ${path} refused — ${detail}`);
    }
    return json;
  };
  return {
    server,
    key,
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
  };
}

function readField(value: unknown, key: string): unknown {
  if (value && typeof value === "object" && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------

async function cmdLink(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { server: { type: "string" }, scope: { type: "string" }, name: { type: "string" } },
    allowPositionals: false,
  });

  const git = await gitIdentity();
  if (!git.remote && !values.scope) {
    bail(
      "This directory has no git remote named origin, so the project identity cannot be derived.\n" +
        "Pass --scope org/<org>/proj/<name> explicitly, or add a remote.",
    );
  }

  const server = (values.server ?? process.env.DATUM_URL ?? "http://localhost:8080").replace(/\/+$/, "");
  const health: unknown = await fetch(`${server}/healthz`)
    .then((r) => r.json())
    .catch(() => null);
  const scopeRoot = readField(health, "scope_root");
  if (typeof scopeRoot !== "string") {
    bail(`Could not reach a Datum server at ${server} (checked /healthz). Is it running?`);
  }

  const name = values.name ?? git.project;
  const scope = values.scope ?? `${scopeRoot}/proj/${name}`;
  const api = await client(server);

  // Many worktrees of one repo are one project with many nodes.
  const repoNode = await api.post("/v1/nodes", {
    kind: "repo",
    scope,
    label: git.repo ?? name ?? scope,
    role: "source",
    meta: { remote: git.remote },
  });
  const worktreeNode = await api.post("/v1/nodes", {
    kind: "worktree",
    scope,
    label: git.worktree,
    role: git.branch,
    meta: { branch: git.branch, head: git.head, dirty: git.dirty },
  });

  // Linking is itself a fact, so "when did this repo join?" is a query.
  await api.post("/v1/assert", {
    scope,
    subject: "project",
    predicate: "linked_repo",
    object: { value: git.repo ?? name, unit: "repo" },
    claim: `${git.repo ?? name} linked to ${scope}`,
    kind: "state",
    evidence: {
      source: `datum link in ${git.worktree}`,
      repo: git.repo ?? undefined,
      commit: git.head ?? undefined,
      instrument: "datum cli",
    },
  });

  const nodeId = readField(readField(worktreeNode, "node"), "id");
  const path = await writeProjectFile({
    scope,
    server,
    key_env: "DATUM_KEY",
    ...(git.repo ? { repo: git.repo } : {}),
    ...(typeof nodeId === "string" ? { node_id: nodeId } : {}),
  });

  const state: unknown = await api.get(`/v1/state?scope=${encodeURIComponent(scope)}`);
  process.stdout.write(
    [
      `linked  ${git.repo ?? name}`,
      `scope   ${scope}`,
      `mode    ${String(readField(state, "mode"))}  (default is global: org facts are inherited)`,
      `nodes   repo=${String(readField(readField(repoNode, "node"), "id"))} worktree=${String(nodeId)}`,
      `wrote   ${path}`,
      "",
      "Flip inheritance with: datum mode isolated",
      "",
    ].join("\n"),
  );
}

async function cmdMode(argv: string[]): Promise<void> {
  const mode = argv[0];
  if (mode !== "global" && mode !== "isolated") {
    bail("usage: datum mode global|isolated");
  }
  const project = await readProjectFile();
  if (!project?.scope) bail(`No ${"" }.datum.toml here. Run \`datum link\` first.`);
  const api = await client();
  const result = await api.post("/v1/mode", { scope: project.scope, mode });
  const chain = readField(result, "chain");
  process.stdout.write(
    [
      `mode    ${mode}`,
      `scope   ${project.scope}`,
      `chain   ${Array.isArray(chain) ? chain.join(" <- ") : "?"}`,
      "",
      mode === "isolated"
        ? "This project no longer sees org-scope facts. The flip is an assertion, so an as-of read\nstill reconstructs what it could see before."
        : "This project inherits org-scope facts again. Nothing was rewritten.",
      "",
    ].join("\n"),
  );
}

async function cmdStatus(): Promise<void> {
  const project = await readProjectFile();
  const api = await client();
  const scope = project?.scope;
  if (!scope) {
    bail(`No .datum.toml here. Run \`datum link\` first, or set the scope explicitly.`);
  }
  const state: unknown = await api.get(`/v1/state?scope=${encodeURIComponent(scope)}`);
  const missions = readField(state, "missions");
  const byConfidence = readField(state, "live_by_confidence");

  const lines = [
    `org       ${String(readField(state, "org"))}`,
    `scope     ${scope}`,
    `mode      ${String(readField(state, "mode"))}`,
    `chain     ${(readField(state, "chain") as string[] | undefined)?.join(" <- ") ?? "?"}`,
    `sequence  ${String(readField(state, "sequence"))}`,
    `live      ${String(readField(state, "live_total"))} ${
      byConfidence ? JSON.stringify(byConfidence) : ""
    }`,
    `binding   ${String(readField(state, "binding_rules"))} rules`,
    `contested ${String(readField(state, "open_contradictions"))} open contradictions`,
    "",
  ];

  if (Array.isArray(missions) && missions.length > 0) {
    for (const m of missions) {
      const gates = (readField(m, "gates") as unknown[] | undefined) ?? [];
      lines.push(`mission   [${String(readField(m, "state"))}] ${String(readField(m, "statement"))}`);
      for (const g of gates) {
        const reached = readField(g, "reached");
        const mark = reached === true ? "reached" : reached === null ? "no-evidence" : "open";
        lines.push(
          `          ${String(readField(g, "subject"))}.${String(readField(g, "predicate"))} ` +
            `${String(readField(g, "op"))}${String(readField(g, "target"))} ` +
            `actual=${String(readField(g, "actual") ?? "—")} ${mark}` +
            (reached === null ? ` (needs ${String(readField(g, "requires_confidence"))})` : ""),
        );
      }
    }
  } else {
    lines.push("mission   none active in this scope");
  }
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;

    case "serve": {
      let config: Config;
      try {
        config = loadConfig();
      } catch (err) {
        if (err instanceof ConfigError) bail(`\n${err.message}\n`);
        throw err;
      }
      const server = await serve(config);
      const shutdown = async (): Promise<void> => {
        await server.close();
        process.exit(0);
      };
      process.on("SIGTERM", () => void shutdown());
      process.on("SIGINT", () => void shutdown());
      return;
    }

    case "migrate":
      await withDbOnly(async (db) => {
        const { applied, alreadyApplied } = await migrate(db);
        process.stdout.write(
          `applied ${applied.length}, already applied ${alreadyApplied.length}\n`,
        );
      });
      return;

    case "init":
      await withDbOnly(async (db, config) => {
        await migrate(db, { log: () => {} });
        const result = await initInstance(db, config);
        process.stdout.write(`org scope ${result.orgScope}\n`);
        if (result.firstKeySecret) {
          process.stdout.write(
            `\nCOPY THIS NOW — shown once, not recoverable:\n  ${result.firstKeySecret}\n\n`,
          );
        } else {
          process.stdout.write("keys already exist; none minted\n");
        }
      });
      return;

    case "seed": {
      const { values } = parseArgs({
        args: rest,
        options: { example: { type: "boolean" }, file: { type: "string" } },
      });
      const file = values.example
        ? resolve(SEEDS_DIR, "example.json")
        : values.file
          ? resolve(process.cwd(), values.file)
          : bail("usage: datum seed --example | datum seed --file <path.json>");
      await withDbOnly(async (db) => {
        const report = await loadSeed(db, file);
        process.stdout.write(
          [
            `seeded ${report.assertions} assertions from ${report.file}`,
            `  by kind:       ${JSON.stringify(report.byKind)}`,
            `  by confidence: ${JSON.stringify(report.byConfidence)}`,
            `  missions: ${report.missions}  nodes: ${report.nodes}  scopes: ${report.scopes}`,
            ...(report.skipped.length > 0
              ? [`  refused ${report.skipped.length}:`, ...report.skipped.map(
                  (s) => `    ${s.subject}.${s.predicate} — ${s.reason}`,
                )]
              : []),
            "",
          ].join("\n"),
        );
      });
      return;
    }

    case "verify":
      await withDbOnly(async (db, config) => {
        const results = await runVerificationPass(db, config, { recheckMs: 0 });
        if (results.length === 0) {
          process.stdout.write("nothing to verify\n");
          return;
        }
        for (const r of results) {
          process.stdout.write(
            `${r.assertion_id} ${r.outcome} via ${r.method}` +
              (r.promoted_to ? ` -> promoted ${r.promoted_to}` : "") +
              `\n    ${String(r.detail.why ?? "")}\n`,
          );
        }
        const promoted = results.filter((r) => r.promoted_to).length;
        process.stdout.write(
          `\nchecked ${results.length}, promoted ${promoted} to measured\n`,
        );
      });
      return;

    case "index": {
      const { values } = parseArgs({
        args: rest,
        options: {
          dir: { type: "string" }, repo: { type: "string" }, commit: { type: "string" },
          emit: { type: "string" }, quiet: { type: "boolean" },
        },
      });
      const dir = resolve(process.cwd(), values.dir ?? ".");
      // Repo slug and commit come from git unless overridden, because an index is only meaningful
      // pinned to a commit — an artifact that cannot say which revision it describes is a snapshot
      // of nothing.
      const git = await gitIdentity(dir);
      const repo = values.repo ?? git.repo;
      const commitSha = values.commit ?? git.head;
      if (!repo) bail("could not derive the repo from git. Pass --repo owner/name.");
      if (!commitSha) bail("could not derive HEAD from git. Pass --commit <sha>.");
      if (git.dirty && !values.commit) {
        process.stderr.write(
          "warning: the working tree is dirty, so the artifact will claim a commit whose contents\n" +
            "         differ from what was parsed. Commit first, or pass --commit explicitly.\n",
        );
      }
      const out = values.emit ?? `datum-graph-${commitSha.slice(0, 9)}.json`;
      const artifact = await indexRepo({
        dir,
        repo,
        commitSha,
        ...(values.quiet ? {} : { onProgress: (m: string) => process.stderr.write(`${m}\n`) }),
      });
      await writeFile(resolve(process.cwd(), out), `${JSON.stringify(artifact)}\n`, "utf8");
      const res = artifact.stats?.["resolution"] as Record<string, number> | undefined;
      process.stdout.write(
        [
          `indexed ${repo} @ ${commitSha.slice(0, 9)}`,
          `  files    ${artifact.file_count}  (${artifact.languages.join(", ")})`,
          `  symbols  ${artifact.symbols.length}`,
          `  edges    ${artifact.edges.length}`,
          ...(res ? [`  resolved ${JSON.stringify(res)}`] : []),
          `  wrote    ${out}`,
          "",
          "Load it with: datum ingest-graph " + out,
          "",
        ].join("\n"),
      );
      return;
    }

    case "ingest-sessions": {
      const { values } = parseArgs({
        args: rest,
        options: {
          dir: { type: "string" },
          file: { type: "string" },
          scope: { type: "string" },
          human: { type: "string" },
          "include-agent": { type: "boolean" },
        },
      });
      if (!values.dir && !values.file) {
        bail("usage: datum ingest-sessions --dir <transcripts/> | --file <one.jsonl> [--scope S] [--human human:name]");
      }
      await withDbOnly(async (db, config) => {
        const scope = values.scope ?? config.orgScope;
        const humanActor = values.human ?? "human:operator";
        // Agent prose is excluded unless asked for. A human sentence is testimony; an agent
        // restating its own conclusion is the raw material of the 808-duplicate failure.
        const includeAgent = values["include-agent"] === true;
        const reports = values.dir
          ? await ingestClaudeDir(db, { dir: values.dir, scope, humanActor, includeAgent })
          : [await ingestClaudeTranscript(db, { file: values.file as string, scope, humanActor, includeAgent })];
        let episodes = 0;
        let duplicates = 0;
        for (const r of reports) {
          episodes += r.episodes;
          duplicates += r.duplicates;
          process.stdout.write(
            `${r.file.split("/").pop()}  sessions=${r.sessions} episodes=${r.episodes} ` +
              `dupes=${r.duplicates} skipped=${r.skipped}\n`,
          );
        }
        process.stdout.write(`\n${episodes} episode(s) into ${scope}; ${duplicates} already on record\n`);
      });
      return;
    }

    case "recall": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          scope: { type: "string" },
          symbol: { type: "string" },
          path: { type: "string" },
          actor: { type: "string" },
          branch: { type: "string" },
          limit: { type: "string" },
        },
        allowPositionals: true,
      });
      const words = positionals.join(" ").trim();
      if (!words && !values.symbol && !values.path) {
        bail("usage: datum recall <words> | --symbol S | --path P  [--actor A] [--branch B] [--limit N]");
      }
      await withDbOnly(async (db, config) => {
        const scope = values.scope ?? config.orgScope;
        const limit = values.limit ? Number.parseInt(values.limit, 10) : undefined;
        if (values.symbol || values.path) {
          const r = values.symbol
            ? await whySymbol(db, { scope, symbol: values.symbol, ...(limit ? { limit } : {}) })
            : await whyPath(db, { scope, path: values.path as string, ...(limit ? { limit } : {}) });
          const where = r.resolved?.path ? `  ${r.resolved.path}:${r.resolved.line_start ?? "?"}` : "";
          process.stdout.write(`${r.target}${where}\n`);
          if (r.note) process.stdout.write(`note: ${r.note}\n`);
          if (r.mentions.length === 0) process.stdout.write("\nnobody ever said anything about this.\n");
          for (const m of r.mentions) {
            process.stdout.write(
              `\n  ${new Date(m.episode.occurred_at).toISOString().slice(0, 16)} ` +
                `${m.episode.actor}${m.episode.git_branch ? `@${m.episode.git_branch}` : ""} [${m.why}]\n` +
                `    ${m.excerpt}\n`,
            );
          }
          for (const f of r.facts) {
            process.stdout.write(`\n  fact[${f.confidence}] ${f.subject}.${f.predicate}: ${f.claim ?? ""}\n`);
          }
          return;
        }
        const hits = await searchEpisodes(db, {
          scope,
          text: words,
          ...(values.actor ? { actor: values.actor } : {}),
          ...(values.branch ? { branch: values.branch } : {}),
          ...(limit ? { limit } : {}),
        });
        if (hits.length === 0) process.stdout.write(`nothing on record was said about "${words}".\n`);
        for (const h of hits) {
          const e = h.episode;
          // The tier is printed, always. An exact quote and a rescued typo are different evidence
          // and a reader who cannot tell them apart has been handed a guess.
          const src = e.source as Record<string, unknown> | null;
          const relayed =
            src &&
            (src["quoted_from_agent"] !== undefined ||
              src["echoes_agent_verbatim"] === true ||
              src["machine_prose"] !== undefined)
              ? "  RELAYED-AGENT-PROSE"
              : "";
          process.stdout.write(
            `\n${new Date(e.occurred_at).toISOString().slice(0, 16)} ${e.actor}` +
              `${e.git_branch ? `@${e.git_branch}` : ""} [${h.matched} ${h.rank.toFixed(2)}]${relayed}\n  ${e.text.replace(/\s+/g, " ").slice(0, 400)}\n`,
          );
        }
      });
      return;
    }

    case "resume": {
      const { values } = parseArgs({
        args: rest,
        options: { scope: { type: "string" }, session: { type: "string" }, limit: { type: "string" } },
      });
      await withDbOnly(async (db, config) => {
        const scope = values.scope ?? config.orgScope;
        const r = await resumeState(db, {
          scope,
          ...(values.session ? { session: values.session } : {}),
          ...(values.limit ? { limit: Number.parseInt(values.limit, 10) } : {}),
        });
        if (r.note) process.stdout.write(`${r.note}\n\n`);
        if (r.last_session) {
          process.stdout.write(
            `session ${r.last_session.id}  ${r.age_hours?.toFixed(1) ?? "?"}h ago  ` +
              `${r.last_session.episodes} turns  ${r.last_session.branches.join(", ")}\n`,
          );
        }
        if (r.drift) process.stdout.write(`DRIFT: ${r.drift.note}\n`);
        for (const t of r.thread) {
          process.stdout.write(`\n  ${t.actor}: ${t.text}`);
        }
        if (r.open_questions.length > 0) process.stdout.write("\n\nunanswered:");
        for (const q of r.open_questions) process.stdout.write(`\n  ? ${q.text}`);
        for (const m of r.missions) {
          process.stdout.write(
            `\n\nmission[${m.state}] ${m.statement}  gates ${m.gates_reached}/${m.gates_total}`,
          );
          if (m.awaiting_human.length > 0) {
            process.stdout.write(`\n  awaiting you: ${m.awaiting_human.join(", ")}`);
          }
        }
        process.stdout.write("\n");
      });
      return;
    }

    case "fleet": {
      const { values } = parseArgs({
        args: rest,
        options: { scope: { type: "string" }, stale: { type: "string" } },
      });
      await withDbOnly(async (db, config) => {
        const scope = values.scope ?? config.orgScope;
        const members = await fleetView(db, {
          scope,
          ...(values.stale ? { staleSeconds: Number.parseInt(values.stale, 10) } : {}),
        });
        if (members.length === 0) process.stdout.write(`nobody registered under ${scope}.\n`);
        for (const m of members) {
          const age = Number.isFinite(m.seconds_ago) ? `${Math.round(m.seconds_ago)}s` : "never";
          process.stdout.write(
            `${m.live ? "  " : "! "}${m.kind}:${m.label}  ${m.scope}  beat=${age}\n` +
              (m.activity ? `    doing: ${m.activity}\n` : "") +
              (m.claims.length > 0 ? `    holds: ${m.claims.join(", ")}\n` : ""),
          );
        }
      });
      return;
    }

    case "ingest-graph": {
      const file = rest[0];
      if (!file) bail("usage: datum ingest-graph <graph.json> [--scope PATH]");
      const { values } = parseArgs({ args: rest.slice(1), options: { scope: { type: "string" } } });
      await withDbOnly(async (db, config) => {
        const raw: unknown = JSON.parse(await readFile(resolve(process.cwd(), file), "utf8"));
        const artifact = raw as GraphArtifact;
        const t0 = Date.now();
        // Default the index into the org's scope tree. ingestGraph alone cannot know the org, so
        // its own fallback is `code/<repo>` — which no project key can reach, making a freshly
        // ingested graph unreadable by exactly the keys that should read it. The CLI does know.
        const scope =
          values.scope ?? `${config.orgScope}/proj/${artifact.repo.split("/").pop()}`;
        const r = await ingestGraph(db, artifact, { scope });
        process.stdout.write(
          `indexed ${artifact.repo} @ ${artifact.commit_sha.slice(0, 9)}\n` +
            `  index    ${r.indexId}\n` +
            `  symbols  ${r.symbols}\n` +
            `  edges    ${r.edges} rows\n` +
            `  in       ${Date.now() - t0} ms\n`,
        );
      });
      return;
    }

    case "impact": {
      const symbol = rest[0];
      if (!symbol) bail("usage: datum impact <symbol> [--repo R] [--depth N] [--commit SHA]");
      const { values } = parseArgs({
        args: rest.slice(1),
        options: { repo: { type: "string" }, depth: { type: "string" }, commit: { type: "string" } },
      });
      const project = await readProjectFile();
      const repo = values.repo ?? project?.repo;
      if (!repo) bail("no repo. Pass --repo owner/name, or run `datum link` first.");
      await withDbOnly(async (db) => {
        const r = await impact(db, {
          repo,
          symbol,
          ...(values.commit ? { commitSha: values.commit } : {}),
          ...(values.depth ? { depth: Number.parseInt(values.depth, 10) } : {}),
        });
        const lines = [
          `${r.target.name}  ${r.target.path}:${r.target.line_start}`,
          `${r.repo} @ ${r.commit_sha.slice(0, 9)}  depth<=${r.max_depth}`,
          "",
        ];
        if (r.reached_by.length === 0 && r.ambiguous.length === 0) {
          // A real and useful answer: nothing reaches it, so changing it breaks nothing here.
          lines.push("nothing reaches this symbol at this depth.");
        }
        for (const h of r.reached_by) {
          lines.push(
            `  d${h.depth} ${h.path_confidence.padEnd(10)} ${h.name}  ` +
              `${h.path}:${h.line_start}  via ${h.via_kind}`,
          );
        }
        if (r.ambiguous.length > 0) {
          // Kept visually separate for the same reason the API keeps it structurally separate:
          // "might break" and "will break" must not read alike.
          lines.push("", "  reached only through an ambiguous edge — verify before trusting:");
          for (const h of r.ambiguous) {
            lines.push(`  d${h.depth} ${"ambiguous".padEnd(10)} ${h.name}  ${h.path}:${h.line_start}`);
          }
        }
        if (r.covered_by_tests.length > 0) {
          lines.push("", "  covered by tests:");
          for (const t of r.covered_by_tests) lines.push(`    ${t.name}  ${t.path}:${t.line_start}`);
        }
        lines.push(
          "",
          `  measured=${r.counts.measured} derived=${r.counts.derived} unverified=${r.counts.unverified}`,
          "",
        );
        process.stdout.write(lines.join("\n"));
      });
      return;
    }

    case "hash-password": {
      const password = rest[0] ?? process.env.DATUM_ADMIN_PASSWORD;
      if (!password) {
        bail("usage: datum hash-password '<password>'   (or set DATUM_ADMIN_PASSWORD)");
      }
      process.stdout.write(`${await hashPassword(password)}\n`);
      return;
    }

    case "link":
      await cmdLink(rest);
      return;
    case "mode":
      await cmdMode(rest);
      return;
    case "status":
      await cmdStatus();
      return;

    default:
      bail(`unknown command: ${command}\n\n${USAGE}`);
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

export { withDb };
