#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { ConfigError, loadConfig, type Config } from "../config.js";
import { Db } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { initInstance } from "../ops/init.js";
import { loadSeed, SEEDS_DIR } from "../ops/seed.js";
import { hashPassword } from "../http/auth.js";
import { serve } from "../http/server.js";
import { runVerificationPass } from "../worker/verify.js";
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

/** Operator commands need DATABASE_URL but not the admin credential, so they load a relaxed
 *  config rather than refusing to run before secrets are set. */
async function withDbOnly<T>(fn: (db: Db, config: Config) => Promise<T>): Promise<T> {
  const env = {
    ...process.env,
    DATUM_ADMIN_PASSWORD: process.env.DATUM_ADMIN_PASSWORD ?? "unused-by-this-command",
    DATUM_SESSION_SECRET:
      process.env.DATUM_SESSION_SECRET ?? "unused-by-this-command-0000000000000000",
  };
  let config: Config;
  try {
    config = loadConfig(env);
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
