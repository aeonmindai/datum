import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { Db } from "./pool.js";

/**
 * Migrations run on boot, idempotently, and are safe to run concurrently.
 *
 * One-click platforms have no reliable pre-deploy or release hook, so a README that tells a
 * stranger to apply SQL files in order is how self-hosted installs end up on undocumented
 * schema drift. An advisory lock serialises concurrent boots; a checksum per applied file
 * makes drift an error instead of a mystery.
 */

const LOCK_KEY = 8_527_411_903_112_004n; // arbitrary, fixed: "datum:migrate"

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

export interface AppliedMigration {
  filename: string;
  checksum: string;
  applied_at: Date;
}

export async function migrate(
  db: Db,
  opts: { dir?: string; log?: (msg: string) => void } = {},
): Promise<{ applied: string[]; alreadyApplied: string[] }> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const log = opts.log ?? ((m: string) => console.log(m));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error(`no migrations found in ${dir}`);

  const client = await db.pool("owner").connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY.toString()]);
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS datum;
      CREATE TABLE IF NOT EXISTS datum.schema_migrations (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const { rows } = await client.query<AppliedMigration>(
      "SELECT filename, checksum, applied_at FROM datum.schema_migrations",
    );
    const seen: Record<string, string> = {};
    for (const r of rows) seen[r.filename] = r.checksum;

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const filename of files) {
      const sql = await readFile(new URL(filename, `file://${dir}`), "utf8");
      const checksum = createHash("sha256").update(sql, "utf8").digest("hex").slice(0, 16);
      const prior = seen[filename];

      if (prior !== undefined) {
        if (prior !== checksum) {
          throw new Error(
            `migration ${filename} changed after it was applied (recorded ${prior}, on disk ${checksum}).\n` +
              `Stored events are never rewritten and neither is applied DDL: add a new migration instead.`,
          );
        }
        alreadyApplied.push(filename);
        continue;
      }

      log(`[migrate] applying ${filename}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO datum.schema_migrations (filename, checksum) VALUES ($1, $2)",
          [filename, checksum],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${filename} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(filename);
    }

    if (applied.length === 0) log(`[migrate] schema up to date (${alreadyApplied.length} files)`);
    return { applied, alreadyApplied };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY.toString()]).catch(() => {});
    client.release();
  }
}
