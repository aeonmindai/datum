import type { Db, DbRole } from "../db/pool.js";
import { asRejection } from "../domain/errors.js";
import { newId } from "../domain/identity.js";
import { resolveChain } from "../domain/scope.js";

/**
 * The fleet: who is running, what they say they are doing, and who else is in this file.
 *
 * This machine carries 141 working copies and 426 branches, and until now no agent on it could
 * observe that any other existed. The registry (migration 006) already held identity; migration
 * 013 added the two things identity does not answer — a heartbeat that carries a sentence, and a
 * node saying "I am touching these paths".
 *
 * Nothing here writes an assertion. A node reporting what it is doing is an utterance about
 * itself, not a measurement of the world, and the moment activity text became a fact source the
 * store would be manufacturing beliefs out of chatter. Promotion stays an explicit act.
 */

/** Mirrors `datum.fleet`'s default, so a caller that omits it gets the documented threshold. */
const DEFAULT_STALE_SECONDS = 300;

export interface FleetMember {
  node_id: string;
  kind: string;
  label: string;
  scope: string;
  role: string | null;
  /** Last heartbeat within `staleSeconds`. Always present: a stale member is still returned. */
  live: boolean;
  seconds_ago: number;
  /** Newest `node_activity` statement, or null if the node has never said anything. */
  activity: string | null;
  activity_at: Date | null;
  claims: string[];
}

export interface Collision {
  path: string;
  node_id: string;
  label: string;
  kind: string;
  intent: string | null;
  claimed_at: Date;
}

/**
 * Every write here can trip a scope-shape check or a foreign key naming an unregistered node.
 * Mapping at the module boundary means a caller learns which rule bit, in the same machine-
 * readable shape `domain/store.ts` returns, rather than a raw driver error.
 */
async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw asRejection(err) ?? err;
  }
}

/** `datum link`'s rule, unchanged: a four-label path through `proj` is a project, else custom. */
function scopeKind(scope: string): string {
  return scope.includes("/proj/") && scope.split("/").length === 4 ? "proj" : "custom";
}

export async function announce(
  db: Db,
  opts: {
    kind: string;
    scope: string;
    label: string;
    role?: string | null;
    meta?: Record<string, unknown>;
  },
  role: DbRole = "app",
): Promise<{ node_id: string; created: boolean }> {
  return refusing(async () => {
    // Registering a node in a scope is how a scope comes into existence, exactly as `POST
    // /v1/nodes` does it — announcing through another entry point must not leave the registry
    // holding nodes in scopes it has never heard of.
    await db.query(
      role,
      `INSERT INTO datum.scopes (path, kind, label, created_by)
       VALUES ($1, $2, $3, 'node registration')
       ON CONFLICT (path) DO NOTHING`,
      [opts.scope, scopeKind(opts.scope), opts.label],
    );

    const row = await db.one<{ id: string; created: boolean }>(
      role,
      `INSERT INTO datum.nodes (id, kind, scope, label, role, meta, heartbeat_at, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb, now(), now())
       -- Registration is a heartbeat: the same worktree re-announcing itself updates its
       -- liveness rather than creating a second row.
       ON CONFLICT (kind, scope, label) WHERE retired_at IS NULL DO UPDATE
          SET heartbeat_at = now(), last_seen = now(),
              role = excluded.role, meta = excluded.meta
       -- xmax is zero on a tuple this transaction inserted and its own xid on one it updated,
       -- which is the only way to learn which arm of ON CONFLICT fired without a second query.
       RETURNING id, (xmax = 0) AS created`,
      [
        newId("n"),
        opts.kind,
        opts.scope,
        opts.label,
        opts.role ?? null,
        JSON.stringify(opts.meta ?? {}),
      ],
    );
    if (!row) throw new Error("node upsert returned no row");
    return { node_id: row.id, created: row.created };
  });
}

/**
 * Say what you are doing.
 *
 * The heartbeat moves in the same call because an agent that just described its work is by
 * definition alive, and a separate ping would let a node be reported dead while its newest
 * statement is seconds old.
 */
export async function report(
  db: Db,
  opts: { node_id: string; scope: string; statement: string; mission_id?: string | null },
  role: DbRole = "app",
): Promise<{ activity_id: string }> {
  const activityId = newId("na");
  return refusing(async () => {
    await db.tx(role, async (client) => {
      await client.query(
        `INSERT INTO datum.node_activity (id, node_id, scope, statement, mission_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [activityId, opts.node_id, opts.scope, opts.statement, opts.mission_id ?? null],
      );
      await client.query(
        `UPDATE datum.nodes SET heartbeat_at = now(), last_seen = now() WHERE id = $1`,
        [opts.node_id],
      );
    });
    return { activity_id: activityId };
  });
}

/**
 * Take an advisory lease on some paths, and learn who else already holds them.
 *
 * A claim never refuses. A hard lock deadlocks a fleet whose members die unpredictably — the
 * holder crashes, the lease outlives it, and every later agent waits behind a corpse. The useful
 * signal is not "you may not" but "you are the second agent in this file, here is the first",
 * which is what `collisions` carries.
 */
export async function claim(
  db: Db,
  opts: { node_id: string; scope: string; paths: string[]; intent?: string | null },
  role: DbRole = "app",
): Promise<{ claimed: string[]; collisions: Collision[] }> {
  const paths = [...new Set(opts.paths)];
  return refusing(async () =>
    db.tx(role, async (client) => {
      if (paths.length > 0) {
        await client.query(
          `INSERT INTO datum.node_claims (id, node_id, scope, path, intent)
           SELECT p.id, $2, $3, p.path, $4 FROM unnest($1::text[], $5::text[]) AS p(id, path)
           -- DO NOTHING rather than refreshing the intent: the app role is granted UPDATE on
           -- released_at alone, so a live claim's terms are fixed until it is handed back.
           ON CONFLICT (node_id, path) WHERE released_at IS NULL DO NOTHING`,
          [paths.map(() => newId("nc")), opts.node_id, opts.scope, opts.intent ?? null, paths],
        );
      }

      // What this node now holds, not what this call inserted: a node re-claiming a path it
      // already holds must be told "yes, it is yours" rather than handed an empty list.
      const held = await client.query<{ path: string }>(
        `SELECT path FROM datum.node_claims
          WHERE node_id = $1 AND released_at IS NULL AND path = ANY($2::text[])
          ORDER BY path`,
        [opts.node_id, paths],
      );
      const collisions = await client.query<Collision>(
        `SELECT * FROM datum.collisions($1, $2::text[])`,
        [opts.node_id, paths],
      );
      return { claimed: held.rows.map((r) => r.path), collisions: collisions.rows };
    }),
  );
}

/** Hand back leases. Without `paths`, everything this node still holds. */
export async function release(
  db: Db,
  opts: { node_id: string; paths?: string[] },
  role: DbRole = "app",
): Promise<{ released: number }> {
  return refusing(async () => {
    const { rowCount } = await db.query(
      role,
      `UPDATE datum.node_claims SET released_at = now()
        WHERE node_id = $1 AND released_at IS NULL
          AND ($2::text[] IS NULL OR path = ANY($2::text[]))`,
      [opts.node_id, opts.paths ?? null],
    );
    return { released: rowCount ?? 0 };
  });
}

interface FleetRow {
  node_id: string;
  kind: string;
  label: string;
  scope: string;
  role: string | null;
  live: boolean | null;
  /** `numeric` arrives as a string; the driver will not narrow it for us. */
  seconds_ago: string | null;
  activity: string | null;
  activity_at: Date | null;
  claims: string[] | null;
}

/**
 * Who is in this scope.
 *
 * The scope chain is resolved rather than matched, so a project asking who is around also sees
 * the org-level services it depends on — the same union every read in the store uses.
 *
 * Stale members are returned by default. A fleet view that hid them would answer "nobody is here"
 * for a scope full of crashed agents still holding claims, which is the situation a caller most
 * needs to see; `live` is what distinguishes a working agent from a corpse.
 */
export async function fleet(
  db: Db,
  opts: { scope: string; staleSeconds?: number; includeStale?: boolean },
  role: DbRole = "app",
): Promise<FleetMember[]> {
  const { chain } = await resolveChain(db, opts.scope, role);
  const includeStale = opts.includeStale ?? true;
  return refusing(async () => {
    const { rows } = await db.query<FleetRow>(
      role,
      `SELECT * FROM datum.fleet($1::text[], $2::int) f
        WHERE $3::boolean OR coalesce(f.live, false)`,
      [chain, opts.staleSeconds ?? DEFAULT_STALE_SECONDS, includeStale],
    );
    return rows.map((r) => ({
      node_id: r.node_id,
      kind: r.kind,
      label: r.label,
      scope: r.scope,
      role: r.role,
      // A node registered without ever beating has no age to compare, and unknown liveness
      // reported as alive is the one error that would let a caller trust a corpse.
      live: r.live ?? false,
      seconds_ago: r.seconds_ago === null ? Number.POSITIVE_INFINITY : Number(r.seconds_ago),
      activity: r.activity,
      activity_at: r.activity_at,
      claims: r.claims ?? [],
    }));
  });
}

/** A node leaving. Its claims go with it — a lease held by something gone blocks nobody usefully. */
export async function retire(
  db: Db,
  opts: { node_id: string },
  role: DbRole = "app",
): Promise<void> {
  await refusing(async () =>
    db.tx(role, async (client) => {
      await client.query(
        `UPDATE datum.nodes SET retired_at = now() WHERE id = $1 AND retired_at IS NULL`,
        [opts.node_id],
      );
      await client.query(
        `UPDATE datum.node_claims SET released_at = now()
          WHERE node_id = $1 AND released_at IS NULL`,
        [opts.node_id],
      );
    }),
  );
}
