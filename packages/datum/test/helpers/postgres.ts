import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";
import { Db } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";

const exec = promisify(execFile);

/**
 * A real Postgres, in a container, for every test that touches the schema.
 *
 * Nothing here is stubbed and nothing is faked. The invariants under test are database
 * invariants — an exclusion constraint, a grant, a trigger — so a fake would test nothing at
 * all. `postgres:latest` is used deliberately: the schema must run on the newest server while
 * refusing to depend on anything newer than PG13, which is what keeps the host swappable.
 */

const IMAGE = process.env.DATUM_TEST_PG_IMAGE ?? "postgres:latest";
const PASSWORD = "datum-test";
const TEMPLATE_DB = "datum_template";

export interface TestPostgres {
  container: string;
  port: number;
  version: string;
  /** Connection string for a named database on this server, as the superuser/owner. */
  url(database: string): string;
  /** A database forked from the migrated template. Fast, and isolated per test. */
  fork(name: string): Promise<Db>;
  drop(name: string): Promise<void>;
  stop(): Promise<void>;
}

async function mappedPort(container: string): Promise<number> {
  const { stdout } = await exec("docker", ["port", container, "5432/tcp"]);
  const line = stdout.trim().split("\n")[0] ?? "";
  const port = Number.parseInt(line.slice(line.lastIndexOf(":") + 1), 10);
  if (!Number.isInteger(port)) {
    throw new Error(`could not parse mapped port from ${JSON.stringify(stdout)}`);
  }
  return port;
}

async function waitReady(container: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      await exec("docker", ["exec", container, "pg_isready", "-U", "postgres", "-q"]);
      // pg_isready can pass while the server is still in its bootstrap restart, so make a
      // real connection before declaring victory.
      const client = new pg.Client({
        connectionString: `postgres://postgres:${PASSWORD}@127.0.0.1:${await mappedPort(container)}/postgres`,
      });
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (err) {
      lastErr = (err as Error).message;
      await sleep(250);
    }
  }
  throw new Error(`postgres container ${container} never became ready: ${lastErr}`);
}

export async function startPostgres(): Promise<TestPostgres> {
  const container = `datum-test-${Math.random().toString(36).slice(2, 10)}`;
  await exec("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    container,
    "-e",
    `POSTGRES_PASSWORD=${PASSWORD}`,
    "-P",
    IMAGE,
    // A test server never needs to survive a crash, and fsync dominates the runtime of a
    // suite that creates a database per case.
    "-c",
    "fsync=off",
    "-c",
    "full_page_writes=off",
    "-c",
    "synchronous_commit=off",
  ]);
  await waitReady(container);
  const port = await mappedPort(container);
  const url = (database: string) => `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/${database}`;

  const admin = new pg.Client({ connectionString: url("postgres") });
  await admin.connect();
  const { rows } = await admin.query<{ server_version: string }>("SHOW server_version");
  const version = rows[0]?.server_version ?? "unknown";

  // Migrate once into a template, then fork it per test. Roles are cluster-scoped so they
  // are created once; grants live in the database and are copied with the template.
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  const templateDb = new Db(url(TEMPLATE_DB));
  await migrate(templateDb, { log: () => {} });
  await templateDb.close();

  return {
    container,
    port,
    version,
    url,
    async fork(name: string): Promise<Db> {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
      return new Db(url(name), { max: 4 });
    },
    async drop(name: string): Promise<void> {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    },
    async stop(): Promise<void> {
      await admin.end().catch(() => {});
      await exec("docker", ["kill", container]).catch(() => {});
    },
  };
}
