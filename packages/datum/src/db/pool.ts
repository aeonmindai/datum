import pg from "pg";

/**
 * One DATABASE_URL, three privilege levels.
 *
 * A self-hoster supplies a single connection string. Privilege separation is applied by
 * asking Postgres to start the session under a specific role, using the `options` startup
 * parameter rather than a `SET ROLE` issued after connecting: pg's pool hands out a client
 * as soon as it connects, so a post-connect `SET ROLE` has a window where a caller could get
 * an owner-privileged client. `-c role=...` closes that window at the protocol level.
 *
 * - `owner`    — migrations and admin operations only.
 * - `app`      — everything an agent can reach. SELECT + INSERT. No UPDATE. No DELETE.
 * - `verifier` — app, plus the only role permitted to write `measured`/`derived` rows.
 */
export type DbRole = "owner" | "app" | "verifier";

const ROLE_OPTION: Record<DbRole, string> = {
  owner: "-c search_path=datum,public",
  app: "-c role=datum_app -c search_path=datum,public",
  verifier: "-c role=datum_verifier -c search_path=datum,public",
};

const APP_NAME: Record<DbRole, string> = {
  owner: "datum-owner",
  app: "datum-app",
  verifier: "datum-verifier",
};

export interface QueryResultLike<T> {
  rows: T[];
  rowCount: number | null;
}

export class Db {
  readonly #url: string;
  readonly #pools: Partial<Record<DbRole, pg.Pool>> = {};
  readonly #max: number;

  constructor(url: string, opts: { max?: number } = {}) {
    this.#url = url;
    this.#max = opts.max ?? 10;
  }

  pool(role: DbRole): pg.Pool {
    let p = this.#pools[role];
    if (!p) {
      p = new pg.Pool({
        connectionString: this.#url,
        options: ROLE_OPTION[role],
        application_name: APP_NAME[role],
        max: this.#max,
        // Fail fast rather than hang a request behind a dead database.
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
      });
      // A pool-level error with no listener takes the process down.
      p.on("error", (err) => {
        console.error(`[db:${role}] idle client error: ${err.message}`);
      });
      this.#pools[role] = p;
    }
    return p;
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    role: DbRole,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResultLike<T>> {
    const res = await this.pool(role).query<T>(sql, params as unknown[]);
    return { rows: res.rows, rowCount: res.rowCount };
  }

  async one<T extends pg.QueryResultRow = pg.QueryResultRow>(
    role: DbRole,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    const { rows } = await this.query<T>(role, sql, params);
    return rows[0] ?? null;
  }

  async tx<T>(role: DbRole, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool(role).connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection is already broken; the pool will discard it.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await Promise.all(Object.values(this.#pools).map((p) => p?.end()));
    for (const key of Object.keys(this.#pools) as DbRole[]) delete this.#pools[key];
  }
}
