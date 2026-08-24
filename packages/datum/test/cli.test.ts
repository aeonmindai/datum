import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { loadConfig, type Config } from "../src/config.js";
import { buildServer, type Server } from "../src/http/server.js";
import { mintKey } from "../src/http/auth.js";
import { parseProjectFile } from "../src/cli/project.js";

/**
 * Deliverable 5 — the CLI, run as a real process against a real listening server inside a real
 * git repository. `datum link` derives project identity from the git remote, so faking the repo
 * would test nothing.
 */

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
// An absolute path to the tsx runner: the CLI subprocess runs with cwd set to a throwaway git
// repo, where `tsx` is not resolvable from node_modules.
const TSX = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const ORG = "acme";

let pg: TestPostgres;
let server: Server;
let config: Config;
let base: string;
let key: string;
let workdir: string;

async function datum(args: string[], env: Record<string, string> = {}) {
  return exec(process.execPath, [TSX, CLI, ...args], {
    cwd: workdir,
    env: { ...process.env, DATUM_KEY: key, DATUM_URL: base, ...env },
    timeout: 60_000,
  });
}

beforeAll(async () => {
  pg = await startPostgres();
  const seed = await pg.fork("datum_cli");
  await seed.close();

  config = loadConfig({
    DATABASE_URL: pg.url("datum_cli"),
    DATUM_ORG: ORG,
    DATUM_ADMIN_PASSWORD: "cli-test-password",
    DATUM_SESSION_SECRET: "1".repeat(64),
    PORT: "0",
  });
  server = await buildServer(config, { startWorker: false, log: false });
  const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
  base = address;

  key = (
    await mintKey(server.db, {
      label: "cli-test",
      scope: `org/${ORG}`,
      permissions: ["read", "assert", "supersede"],
      expiresAt: null,
      createdBy: "test",
    })
  ).secret;

  workdir = await mkdtemp(join(tmpdir(), "datum-cli-"));
  const git = (args: string[]) => exec("git", ["-C", workdir, ...args]);
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "user.name", "Test"]);
  await git(["remote", "add", "origin", "git@github.com:example-org/checkout-service.git"]);
  await writeFile(join(workdir, "README.md"), "# checkout-service\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "initial"]);
}, 240_000);

afterAll(async () => {
  await server?.close();
  await pg?.stop();
});

describe("deliverable 5 — datum link / mode / status", () => {
  it("prints usage with no arguments", async () => {
    const { stdout } = await datum([]);
    expect(stdout).toContain("datum link");
    expect(stdout).toContain("datum mode global|isolated");
    expect(stdout).toContain("datum status");
  });

  it("links a repo to its project scope and registers its nodes", async () => {
    const { stdout } = await datum(["link"]);
    // The project name comes from the git remote, not from the directory name.
    expect(stdout).toContain(`scope   org/${ORG}/proj/checkout-service`);
    expect(stdout).toContain("linked  example-org/checkout-service");
    expect(stdout).toContain("mode    global");

    const written = parseProjectFile(await readFile(join(workdir, ".datum.toml"), "utf8"));
    expect(written.scope).toBe(`org/${ORG}/proj/checkout-service`);
    expect(written.repo).toBe("example-org/checkout-service");
    expect(written.key_env).toBe("DATUM_KEY");
    // The file is safe to commit: it must never contain the key itself.
    expect(await readFile(join(workdir, ".datum.toml"), "utf8")).not.toContain(key);

    const nodes = await server.db.query<{ kind: string; label: string }>(
      "app",
      `SELECT kind, label FROM datum.nodes WHERE scope = $1 ORDER BY kind`,
      [`org/${ORG}/proj/checkout-service`],
    );
    expect(nodes.rows.map((n) => n.kind)).toEqual(["repo", "worktree"]);

    // The scope now exists as a registered scope, so it appears in the tree.
    const scope = await server.db.one<{ kind: string }>(
      "app",
      `SELECT kind FROM datum.scopes WHERE path = $1`,
      [`org/${ORG}/proj/checkout-service`],
    );
    expect(scope?.kind).toBe("proj");

    // Linking is itself a fact.
    const linked = await server.db.one<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.assertions
        WHERE subject = 'project' AND predicate = 'linked_repo' AND scope = $1`,
      [`org/${ORG}/proj/checkout-service`],
    );
    expect(Number(linked?.n)).toBe(1);
  });

  it("is idempotent: linking twice registers one repo node, not two", async () => {
    await datum(["link"]);
    const nodes = await server.db.one<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.nodes WHERE scope = $1 AND kind = 'repo'`,
      [`org/${ORG}/proj/checkout-service`],
    );
    expect(Number(nodes?.n)).toBe(1);
  });

  it("flips the knowledge mode as a superseding assertion, and back", async () => {
    const isolated = await datum(["mode", "isolated"]);
    expect(isolated.stdout).toContain("mode    isolated");
    expect(isolated.stdout).not.toContain(`org/${ORG}\n`);
    expect(isolated.stdout).toContain("no longer sees org-scope facts");

    const back = await datum(["mode", "global"]);
    expect(back.stdout).toContain("mode    global");
    expect(back.stdout).toContain("Nothing was rewritten");

    // Two flips, so there is a supersession chain of two mode assertions and one live head.
    const modes = await server.db.query<{ id: string; superseded_by: string | null }>(
      "app",
      `SELECT id, superseded_by FROM datum.assertions
        WHERE predicate = 'knowledge_mode' AND scope = $1 ORDER BY asserted_at`,
      [`org/${ORG}/proj/checkout-service`],
    );
    expect(modes.rows.length).toBe(2);
    expect(modes.rows.filter((m) => m.superseded_by === null)).toHaveLength(1);
  });

  it("reports who I am, which scope, which mode and what the mission is", async () => {
    await server.db.query(
      "app",
      `INSERT INTO datum.missions (id, scope, statement, state, gates, asserted_by)
       VALUES ('m_clitest', $1, 'Ship checkout v2', 'active',
               '[{"subject":"checkout","predicate":"p99_ms","op":"<=","target":250,
                  "requires_confidence":"measured"}]'::jsonb, 'test')`,
      [`org/${ORG}/proj/checkout-service`],
    );

    const { stdout } = await datum(["status"]);
    expect(stdout).toContain(`org       ${ORG}`);
    expect(stdout).toContain(`scope     org/${ORG}/proj/checkout-service`);
    expect(stdout).toContain("mode      global");
    expect(stdout).toContain("mission   [active] Ship checkout v2");
    // A gate with no evidence of the demanded class reports no-evidence, never a false reading.
    expect(stdout).toContain("checkout.p99_ms <=250 actual=— no-evidence (needs measured)");
  });

  it("refuses to run project commands without a key, and says where to get one", async () => {
    await expect(datum(["status"], { DATUM_KEY: "" })).rejects.toThrow(/No API key/);
  });

  it("hashes a password without needing a database", async () => {
    const { stdout } = await exec(
      process.execPath,
      [TSX, CLI, "hash-password", "hunter2"],
      { env: { PATH: process.env.PATH ?? "" }, timeout: 60_000 },
    );
    expect(stdout.trim().startsWith("$argon2id$")).toBe(true);
  });

  it("refuses to boot with no admin credential, and says exactly how to make one", async () => {
    await expect(
      exec(process.execPath, [TSX, CLI, "serve"], {
        env: { PATH: process.env.PATH ?? "", DATABASE_URL: pg.url("datum_cli") },
        timeout: 60_000,
      }),
    ).rejects.toThrow(/refuses to boot|DATUM_SESSION_SECRET/);
  });
});
