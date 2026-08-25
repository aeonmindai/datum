import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import type { Db } from "../src/db/pool.js";
import { newId } from "../src/domain/identity.js";
import { announce, claim, fleet, release, report, retire } from "../src/fleet/index.js";

/**
 * The fleet plane, against a real Postgres.
 *
 * Every behaviour under test lives in the database — the partial unique index that makes a claim
 * idempotent, the `nodes_identity` index that makes re-announcing a heartbeat instead of a second
 * row, the liveness arithmetic inside `datum.fleet`, and the trigger that refuses to let an
 * activity row be rewritten. A stubbed database would test this file and nothing else.
 *
 * One fork, many scope roots. `datum.fleet` filters by an exact scope-chain match, so giving each
 * case its own top-level label isolates it as completely as a separate database would, without
 * paying for the fork.
 */

const DB = "datum_fleet";
let pg: TestPostgres;
let db: Db;

/**
 * Numbers this suite actually saw, printed once at the end. The delivery for this work has to
 * report observed values rather than assert that a test passed, in the same spirit as
 * `report:invariants`.
 */
const observed: Record<string, unknown> = {};

beforeAll(async () => {
  pg = await startPostgres();
  db = await pg.fork(DB);
}, 300_000);

afterAll(async () => {
  console.log("fleet observed:", JSON.stringify(observed, null, 2));
  await db?.close().catch(() => {});
  await pg?.stop();
});

/**
 * Read a field off a driver error by narrowing rather than asserting a shape onto it. A thrown
 * value that is not a Postgres error then reports null and the expectation fails loudly, instead
 * of quietly reading `undefined` off an invented type.
 */
function pgField(err: unknown, field: "constraint" | "code"): string | null {
  if (err === null || typeof err !== "object" || !(field in err)) return null;
  const value: unknown = Reflect.get(err, field);
  return typeof value === "string" ? value : null;
}

/** Backdate a heartbeat. Owner, because the point is to manufacture a corpse, not to model one. */
async function backdate(nodeId: string, interval: string): Promise<void> {
  await db.query(
    "owner",
    `UPDATE datum.nodes SET heartbeat_at = now() - $2::interval, last_seen = now() - $2::interval
      WHERE id = $1`,
    [nodeId, interval],
  );
}

async function heartbeatOf(nodeId: string): Promise<Date> {
  const row = await db.one<{ heartbeat_at: Date }>(
    "app",
    `SELECT heartbeat_at FROM datum.nodes WHERE id = $1`,
    [nodeId],
  );
  if (!row?.heartbeat_at) throw new Error(`node ${nodeId} has no heartbeat`);
  return row.heartbeat_at;
}

async function liveClaims(nodeId: string): Promise<string[]> {
  const { rows } = await db.query<{ path: string }>(
    "app",
    `SELECT path FROM datum.node_claims WHERE node_id = $1 AND released_at IS NULL ORDER BY path`,
    [nodeId],
  );
  return rows.map((r) => r.path);
}

describe("registration is the heartbeat", () => {
  it("the same worktree announcing twice is one node, revived not duplicated", async () => {
    const identity = {
      kind: "worktree",
      scope: "reg/org/proj/arc",
      label: "wt-parser",
      role: "builder",
    };
    const first = await announce(db, { ...identity, meta: { pid: 4242 } });
    expect(first.created).toBe(true);

    // A worktree that has not spoken for an hour, then comes back.
    await backdate(first.node_id, "1 hour");
    const stale = await heartbeatOf(first.node_id);

    const second = await announce(db, { ...identity, meta: { pid: 4243 } });
    expect(second.node_id).toBe(first.node_id);
    expect(second.created).toBe(false);

    const revived = await heartbeatOf(first.node_id);
    expect(revived.getTime()).toBeGreaterThan(stale.getTime());
    expect(Date.now() - revived.getTime()).toBeLessThan(60_000);

    const count = await db.one<{ n: string }>(
      "app",
      `SELECT count(*) AS n FROM datum.nodes WHERE kind = $1 AND scope = $2 AND label = $3`,
      [identity.kind, identity.scope, identity.label],
    );
    expect(Number(count?.n)).toBe(1);

    // The second announce is a full restatement of identity, not a merge — v1's convention.
    const meta = await db.one<{ meta: Record<string, unknown> }>(
      "app",
      `SELECT meta FROM datum.nodes WHERE id = $1`,
      [first.node_id],
    );
    expect(meta?.meta).toEqual({ pid: 4243 });

    observed["announce_twice"] = {
      node_rows: Number(count?.n),
      created_first: first.created,
      created_second: second.created,
      heartbeat_before: stale.toISOString(),
      heartbeat_after: revived.toISOString(),
      bumped_by_seconds: Math.round((revived.getTime() - stale.getTime()) / 1000),
    };
  });

  it("registering a node brings its scope into existence", async () => {
    await announce(db, { kind: "repo", scope: "screg/org/proj/thing", label: "thing" });
    const row = await db.one<{ kind: string }>(
      "app",
      `SELECT kind FROM datum.scopes WHERE path = $1`,
      ["screg/org/proj/thing"],
    );
    expect(row?.kind).toBe("proj");
  });
});

describe("claims are advisory", () => {
  it("re-claiming a path is idempotent and collides with nobody", async () => {
    const node = await announce(db, {
      kind: "agent",
      scope: "idem/org",
      label: "agent-a",
    });

    const once = await claim(db, {
      node_id: node.node_id,
      scope: "idem/org",
      paths: ["src/parser.rs"],
      intent: "rewriting the tokenizer",
    });
    expect(once.claimed).toEqual(["src/parser.rs"]);
    expect(once.collisions).toEqual([]);

    const twice = await claim(db, {
      node_id: node.node_id,
      scope: "idem/org",
      paths: ["src/parser.rs"],
      intent: "rewriting the tokenizer",
    });
    // Still mine, still one row: the unique partial index absorbed the second write.
    expect(twice.claimed).toEqual(["src/parser.rs"]);
    expect(twice.collisions).toEqual([]);

    const rows = await db.one<{ n: string }>(
      "app",
      `SELECT count(*) AS n FROM datum.node_claims
        WHERE node_id = $1 AND path = $2 AND released_at IS NULL`,
      [node.node_id, "src/parser.rs"],
    );
    expect(Number(rows?.n)).toBe(1);

    observed["idempotent_claim"] = {
      live_rows_after_two_claims: Number(rows?.n),
      self_collisions: twice.collisions.length,
    };
  });

  it("the second agent into a file is told who was first, and is never refused", async () => {
    const first = await announce(db, {
      kind: "worktree",
      scope: "coll/org",
      label: "wt-first",
    });
    const second = await announce(db, {
      kind: "agent",
      scope: "coll/org",
      label: "agent-second",
    });

    await claim(db, {
      node_id: first.node_id,
      scope: "coll/org",
      paths: ["src/http/v1.ts", "src/http/mcp.ts"],
      intent: "adding the fleet routes",
    });

    const collided = await claim(db, {
      node_id: second.node_id,
      scope: "coll/org",
      paths: ["src/http/v1.ts"],
      intent: "adding the episode routes",
    });

    // Advisory: the claim went through. That is the whole design decision.
    expect(collided.claimed).toEqual(["src/http/v1.ts"]);
    expect(collided.collisions).toHaveLength(1);
    const other = collided.collisions[0];
    expect(other?.node_id).toBe(first.node_id);
    expect(other?.label).toBe("wt-first");
    expect(other?.kind).toBe("worktree");
    expect(other?.intent).toBe("adding the fleet routes");
    expect(other?.path).toBe("src/http/v1.ts");

    // And the untouched sibling path is not reported as contested.
    expect(collided.collisions.map((c) => c.path)).not.toContain("src/http/mcp.ts");

    observed["collision"] = {
      claimed_anyway: collided.claimed,
      collisions: collided.collisions.map((c) => ({
        path: c.path,
        label: c.label,
        kind: c.kind,
        intent: c.intent,
      })),
    };
  });

  it("release takes back the named paths, or all of them", async () => {
    const node = await announce(db, { kind: "agent", scope: "rel/org", label: "agent-rel" });
    await claim(db, {
      node_id: node.node_id,
      scope: "rel/org",
      paths: ["a.ts", "b.ts", "c.ts"],
    });
    expect(await liveClaims(node.node_id)).toEqual(["a.ts", "b.ts", "c.ts"]);

    const one = await release(db, { node_id: node.node_id, paths: ["b.ts"] });
    expect(one.released).toBe(1);
    const afterOne = await liveClaims(node.node_id);
    expect(afterOne).toEqual(["a.ts", "c.ts"]);

    const rest = await release(db, { node_id: node.node_id });
    expect(rest.released).toBe(2);
    expect(await liveClaims(node.node_id)).toEqual([]);

    // Released, not deleted: the lease history survives.
    const total = await db.one<{ n: string }>(
      "app",
      `SELECT count(*) AS n FROM datum.node_claims WHERE node_id = $1`,
      [node.node_id],
    );
    expect(Number(total?.n)).toBe(3);

    observed["release"] = {
      after_named_release: afterOne,
      released_named: one.released,
      released_rest: rest.released,
      rows_retained: Number(total?.n),
    };
  });
});

describe("who is out there", () => {
  it("a node past staleSeconds is returned, marked dead, and can be filtered out", async () => {
    const corpse = await announce(db, { kind: "agent", scope: "stale/org", label: "agent-dead" });
    const alive = await announce(db, { kind: "agent", scope: "stale/org", label: "agent-alive" });
    await claim(db, { node_id: corpse.node_id, scope: "stale/org", paths: ["held/by/a/corpse.ts"] });
    await backdate(corpse.node_id, "1 hour");

    const all = await fleet(db, { scope: "stale/org" });
    const dead = all.find((m) => m.node_id === corpse.node_id);
    const living = all.find((m) => m.node_id === alive.node_id);
    expect(dead?.live).toBe(false);
    expect(dead?.seconds_ago).toBeGreaterThan(3500);
    expect(living?.live).toBe(true);
    expect(living?.seconds_ago).toBeLessThan(300);
    // The claim a dead agent still holds is exactly what a caller needs to see.
    expect(dead?.claims).toEqual(["held/by/a/corpse.ts"]);

    const onlyLive = await fleet(db, { scope: "stale/org", includeStale: false });
    expect(onlyLive.map((m) => m.node_id)).not.toContain(corpse.node_id);
    expect(onlyLive.map((m) => m.node_id)).toContain(alive.node_id);

    // The threshold is the caller's: at two hours the same node is alive again.
    const generous = await fleet(db, { scope: "stale/org", staleSeconds: 7200 });
    expect(generous.find((m) => m.node_id === corpse.node_id)?.live).toBe(true);

    observed["staleness"] = {
      stale_node: { live: dead?.live, seconds_ago: dead?.seconds_ago, claims: dead?.claims },
      fresh_node: { live: living?.live, seconds_ago: living?.seconds_ago },
      members_include_stale: all.length,
      members_exclude_stale: onlyLive.length,
      live_at_7200s: generous.find((m) => m.node_id === corpse.node_id)?.live,
    };
  });

  it("a node that has never beaten is reported dead, not merely unknown", async () => {
    // `announce` always stamps a heartbeat, so this row can only come from a writer that does
    // not — a hand-registered entry, or an importer. Unknown liveness rendered as alive is the
    // one error that lets a caller trust a corpse, so the absence has to resolve to `false`.
    const id = newId("n");
    await db.query(
      "app",
      `INSERT INTO datum.nodes (id, kind, scope, label) VALUES ($1,'agent','quiet/org','never-spoke')`,
      [id],
    );

    const [member] = await fleet(db, { scope: "quiet/org" });
    expect(member?.node_id).toBe(id);
    expect(member?.live).toBe(false);
    expect(member?.seconds_ago).toBe(Number.POSITIVE_INFINITY);
    expect(await fleet(db, { scope: "quiet/org", includeStale: false })).toEqual([]);

    observed["never_beaten"] = { live: member?.live, seconds_ago: member?.seconds_ago };
  });

  it("a project sees the org-level services above it, and not its siblings' children", async () => {
    const service = await announce(db, {
      kind: "service",
      scope: "chain/org",
      label: "verification-worker",
      role: "verifier",
    });
    const worktree = await announce(db, {
      kind: "worktree",
      scope: "chain/org/proj/arc",
      label: "wt-arc",
    });

    const atProject = await fleet(db, { scope: "chain/org/proj/arc" });
    const ids = atProject.map((m) => m.node_id);
    expect(ids).toContain(service.node_id);
    expect(ids).toContain(worktree.node_id);

    // Inheritance runs up, never down: the org view does not absorb the project's worktrees.
    const atOrg = await fleet(db, { scope: "chain/org" });
    expect(atOrg.map((m) => m.node_id)).toContain(service.node_id);
    expect(atOrg.map((m) => m.node_id)).not.toContain(worktree.node_id);

    observed["scope_chain"] = {
      at_project: atProject.map((m) => `${m.scope}:${m.label}`),
      at_org: atOrg.map((m) => `${m.scope}:${m.label}`),
    };
  });

  it("reporting is a heartbeat, and the newest statement is what the fleet shows", async () => {
    const node = await announce(db, { kind: "agent", scope: "act/org", label: "agent-busy" });
    await backdate(node.node_id, "1 hour");

    await report(db, {
      node_id: node.node_id,
      scope: "act/org",
      statement: "reading migration 013",
    });
    const second = await report(db, {
      node_id: node.node_id,
      scope: "act/org",
      statement: "writing the fleet module",
    });
    expect(second.activity_id).toMatch(/^na_[0-9A-HJKMNP-TV-Z]{26}$/);

    const [member] = await fleet(db, { scope: "act/org" });
    expect(member?.activity).toBe("writing the fleet module");
    expect(member?.live).toBe(true);
    expect(member?.seconds_ago).toBeLessThan(60);

    observed["report"] = {
      activity: member?.activity,
      live_after_report: member?.live,
      seconds_ago: member?.seconds_ago,
    };
  });

  it("a retired node leaves the fleet and lets go of its files", async () => {
    const node = await announce(db, { kind: "worktree", scope: "ret/org", label: "wt-done" });
    await claim(db, { node_id: node.node_id, scope: "ret/org", paths: ["src/done.ts"] });
    await report(db, { node_id: node.node_id, scope: "ret/org", statement: "finishing up" });
    expect((await fleet(db, { scope: "ret/org" })).map((m) => m.node_id)).toContain(node.node_id);

    await retire(db, { node_id: node.node_id });

    const after = await fleet(db, { scope: "ret/org" });
    expect(after.map((m) => m.node_id)).not.toContain(node.node_id);
    expect(await liveClaims(node.node_id)).toEqual([]);

    // The path is free for whoever comes next — a lease held by something gone blocks nobody.
    const successor = await announce(db, { kind: "agent", scope: "ret/org", label: "agent-next" });
    const taken = await claim(db, {
      node_id: successor.node_id,
      scope: "ret/org",
      paths: ["src/done.ts"],
    });
    expect(taken.collisions).toEqual([]);

    observed["retire"] = {
      members_after: after.length,
      claims_after: await liveClaims(node.node_id),
      successor_collisions: taken.collisions.length,
    };
  });
});

describe("what a node said is append-only", () => {
  it("node_activity refuses UPDATE and DELETE", async () => {
    const node = await announce(db, { kind: "agent", scope: "imm/org", label: "agent-imm" });
    const { activity_id } = await report(db, {
      node_id: node.node_id,
      scope: "imm/org",
      statement: "the original sentence",
    });

    const refusals: Record<string, string | null> = {};
    for (const [op, sql] of [
      ["UPDATE", `UPDATE datum.node_activity SET statement = 'rewritten' WHERE id = $1`],
      ["DELETE", `DELETE FROM datum.node_activity WHERE id = $1`],
    ] as const) {
      let constraint: string | null = null;
      try {
        // Owner, not app: the grants stop the runtime roles, the trigger stops everyone.
        await db.query("owner", sql, [activity_id]);
      } catch (err) {
        constraint = pgField(err, "constraint");
      }
      expect(constraint, `${op} was not refused`).toBe("activity_is_immutable");
      refusals[op] = constraint;
    }

    // Layer one, separately verifiable: the app role was never granted the privilege at all.
    let sqlstate: string | null = null;
    try {
      await db.query("app", `UPDATE datum.node_activity SET statement = 'x' WHERE id = $1`, [
        activity_id,
      ]);
    } catch (err) {
      sqlstate = pgField(err, "code");
    }
    expect(sqlstate).toBe("42501");

    const survived = await db.one<{ statement: string }>(
      "app",
      `SELECT statement FROM datum.node_activity WHERE id = $1`,
      [activity_id],
    );
    expect(survived?.statement).toBe("the original sentence");

    observed["immutability"] = { ...refusals, app_role_sqlstate: sqlstate };
  });
});
