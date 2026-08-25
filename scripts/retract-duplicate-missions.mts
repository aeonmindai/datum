#!/usr/bin/env node
/**
 * One-off: close the missions a non-idempotent seed load duplicated.
 *
 * Assertions are content-addressed, so re-inserting one is a no-op the database enforces. Missions
 * are not, so a second load of `seeds/datum.json` put eight identical live missions into
 * production. The loader now skips them, but the eight already written have to go somewhere.
 *
 * They go where the schema says: superseded by a new version, because a mission row is immutable
 * and `fn_missions_apply_supersession` is the only thing allowed to set `superseded_by`. The
 * replacement is `state='closed'` and carries **no gates**, which matters for more than tidiness -
 * a closed duplicate with the original's gates would keep counting toward `awaiting-you` and
 * report six decisions as fourteen.
 *
 * The earliest row for each (scope, statement) is kept. Safe to re-run: once a duplicate is
 * superseded it is no longer live, so the second pass finds nothing.
 */
import { loadConfig } from "../packages/datum/src/config.js";
import { Db } from "../packages/datum/src/db/pool.js";
import { createMission } from "../packages/datum/src/domain/store.js";

const config = loadConfig();
const db = new Db(config.databaseUrl);

interface Dup {
  id: string;
  scope: string;
  statement: string;
  keeper: string;
}

// Rank live missions per (scope, statement) by insertion order; everything after the first is a
// duplicate of it.
const { rows } = await db.query<Dup>(
  "app",
  `WITH ranked AS (
     SELECT id, scope, statement, asserted_at,
            row_number() OVER (PARTITION BY scope, statement ORDER BY asserted_at) AS rn,
            first_value(id) OVER (PARTITION BY scope, statement ORDER BY asserted_at) AS keeper
       FROM datum.missions
      WHERE superseded_by IS NULL
   )
   SELECT id, scope, statement, keeper FROM ranked WHERE rn > 1 ORDER BY asserted_at`,
);

if (rows.length === 0) {
  console.log("nothing to close: no duplicate live mission for any (scope, statement)");
} else {
  console.log(`closing ${rows.length} duplicate mission(s)`);
}

let closed = 0;
for (const d of rows) {
  // The statement must differ from the keeper's, or the replacement is itself a duplicate.
  await createMission(db, {
    scope: d.scope,
    statement: `Closed as a duplicate load of: ${d.statement}`,
    state: "closed",
    gates: [],
    asserted_by: "agent:cleanup",
    supersedes: d.id,
  });
  closed += 1;
  console.log(`  ${d.id} -> closed (duplicate of ${d.keeper})`);
}

const after = await db.one<{ live: string; distinct: string }>(
  "app",
  `SELECT count(*)::text AS live, count(DISTINCT statement)::text AS distinct
     FROM datum.missions WHERE superseded_by IS NULL`,
);
console.log(`\nclosed ${closed}; live missions now ${after?.live} across ${after?.distinct} statements`);
await db.close();
