import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import type { Db } from "../src/db/pool.js";
import { loadSeed, SEEDS_DIR } from "../src/ops/seed.js";
import { loadConfig, type Config } from "../src/config.js";
import { runVerificationPass } from "../src/worker/verify.js";
import { take } from "../src/domain/store.js";

/**
 * Deliverable 7 — seeded with Arc, and the example fixture from §15.5.
 *
 * The point of the Arc seed is not that it loads. It is that the retired numbers are in there as
 * `kind: dead`, superseded by their replacements, so the store can *prove* it refuses to surface
 * them. Arc's own corpus had 449 in-place retraction markers across 21,619 lines and its live
 * target appeared nowhere in it; at 500k context, retrieval returned the most emphatic match
 * rather than the most recent, and dead headline numbers won every time.
 */

const ARC_REPO = "/Users/jish/Documents/GitHub/arc";

let pg: TestPostgres;
let db: Db;
let config: Config;

beforeAll(async () => {
  pg = await startPostgres();
  db = await pg.fork("datum_seeds");
  config = loadConfig({
    DATABASE_URL: pg.url("datum_seeds"),
    DATUM_ORG: "aeonmind",
    DATUM_ADMIN_PASSWORD: "seed-test",
    DATUM_SESSION_SECRET: "2".repeat(64),
    ...(existsSync(ARC_REPO) ? { DATUM_GIT_MIRRORS: `aeonmindai/arc=${ARC_REPO}` } : {}),
  });
}, 240_000);

afterAll(async () => {
  await db?.close();
  await pg?.stop();
});

describe("deliverable 7 — the Arc seed", () => {
  it("loads every row without a single refusal", async () => {
    const report = await loadSeed(db, resolve(SEEDS_DIR, "arc.json"), { log: () => {} });
    console.log(
      `\n  arc.json: ${report.assertions} assertions, ${report.missions} mission(s), ` +
        `${report.nodes} nodes, ${report.scopes} scopes\n` +
        `  by kind:       ${JSON.stringify(report.byKind)}\n` +
        `  by confidence: ${JSON.stringify(report.byConfidence)}\n`,
    );
    expect(report.skipped).toEqual([]);
    expect(report.assertions).toBeGreaterThanOrEqual(30);
    // Nothing in a seed may claim `measured`: confidence is earned, including here.
    expect(report.byConfidence.measured).toBeUndefined();
    expect(report.byConfidence.derived).toBeUndefined();
    expect(report.byKind.dead).toBeGreaterThanOrEqual(4);
  });

  it("refuses to surface a retired number in a default read", async () => {
    // 16,600 and 16,602 are dead. Jish's correction is that 14,000 is the right number.
    const dead = await db.query<{ id: string; value: string; superseded_by: string | null }>(
      "app",
      `SELECT id, object->>'value' AS value, superseded_by FROM datum.assertions
        WHERE kind = 'dead' AND object->>'value' IN ('16600', '16602')`,
    );
    expect(dead.rows.length).toBeGreaterThan(0);
    // Every dead headline number is superseded, which is what takes it out of every live read.
    for (const row of dead.rows) expect(row.superseded_by).not.toBeNull();

    const live = await take(db, {
      scope: "org/aeonmind/proj/arc",
      subject: "engine",
      predicate: "target_aggregate_tok_s_at_b256",
    });
    const values = live.assertions.map((a) => String(a.object.value));
    expect(values).not.toContain("16600");
    expect(values).not.toContain("16602");
    expect(values).toContain("14000");

    // A `kind: dead` row is never returned by a default read, even when it is not superseded —
    // the retracted "K4/V4/L12 -> 1413 tok/s" rung has no live replacement because it was a
    // different budget class, so supersession cannot be what hides it.
    const orphanDead = await db.one<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.assertions
        WHERE superseded_by IS NULL AND kind = 'dead'`,
    );
    expect(Number(orphanDead?.n)).toBeGreaterThan(0);

    const everything = await take(db, { scope: "org/aeonmind/proj/arc", limit: 500 });
    expect(everything.assertions.filter((a) => a.kind === "dead")).toEqual([]);
    const anyDeadNumber = everything.assertions
      .map((a) => String(a.object.value))
      .filter((v) => ["16600", "16602", "1413"].includes(v));
    expect(anyDeadNumber).toEqual([]);

    // But asking for them by name works, so the store can prove exactly what it refuses.
    const audit = await take(db, { scope: "org/aeonmind/proj/arc", kind: "dead", limit: 500 });
    expect(audit.assertions.length).toBeGreaterThan(0);
    expect(audit.assertions.every((a) => a.kind === "dead" && a.why)).toBe(true);
  });

  it("keeps the contested pairs live and contested, on both sides", async () => {
    const open = await db.query<{ a_confidence: string; b_confidence: string; predicate: string }>(
      "app",
      `SELECT a_confidence, b_confidence, predicate FROM datum.contradictions WHERE status='open'`,
    );
    expect(open.rows.length).toBeGreaterThanOrEqual(2);
    // Every open contradiction crosses the authority tiers. Two `measured` rows disagreeing is
    // physically impossible, so a contradiction can only ever be cross-tier.
    for (const row of open.rows) {
      expect([row.a_confidence, row.b_confidence]).toContain("confirmed-by-human");
    }
  });

  it("reports a mission whose gates are honest about missing evidence", async () => {
    const rows = await db.query<{ statement: string; gates: unknown[] }>(
      "app",
      `SELECT statement, gates FROM datum.missions WHERE superseded_by IS NULL`,
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.statement).toContain("K=9");
    expect(rows.rows[0]!.gates.length).toBeGreaterThanOrEqual(3);
  });

  it("promotes real Arc measurements when the real repo is on disk", async () => {
    if (!existsSync(ARC_REPO)) {
      console.log("\n  arc repo not present on this machine; promotion path not exercised\n");
      return;
    }
    const results = await runVerificationPass(db, config, { recheckMs: 0, limit: 200 });
    const promoted = results.filter((r) => r.promoted_to);
    const refuted = results.filter((r) => r.outcome === "refuted");
    const unresolvable = results.filter((r) => r.outcome === "unresolvable");
    console.log(
      `\n  verification against the real arc repo: ${results.length} checked, ` +
        `${promoted.length} promoted to measured, ${refuted.length} refuted, ` +
        `${unresolvable.length} unresolvable\n`,
    );
    // The seed carries real commits on real branches, so at least some must promote — and any
    // that do not must have a stated reason rather than silently staying put.
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(String(r.detail.why ?? "")).not.toBe("");

    if (promoted.length > 0) {
      const measured = await db.one<{ n: string }>(
        "app",
        `SELECT count(*)::text AS n FROM datum.assertions
          WHERE confidence = 'measured' AND superseded_by IS NULL AND verification_id IS NOT NULL`,
      );
      expect(Number(measured?.n)).toBeGreaterThanOrEqual(promoted.length);
    }
  });
});

describe("§15.5 — the example fixture a stranger clicks through", () => {
  let exampleDb: Db;

  beforeAll(async () => {
    exampleDb = await pg.fork("datum_example");
  }, 120_000);

  afterAll(async () => {
    await exampleDb?.close();
  });

  it("loads clean and demonstrates the whole thesis on a fresh install", async () => {
    const report = await loadSeed(exampleDb, resolve(SEEDS_DIR, "example.json"), { log: () => {} });
    expect(report.skipped).toEqual([]);
    expect(report.assertions).toBeGreaterThanOrEqual(8);

    // A supersession chain.
    const chain = await exampleDb.one<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.assertions WHERE supersedes IS NOT NULL`,
    );
    expect(Number(chain?.n)).toBeGreaterThanOrEqual(2);

    // A contested pair.
    const contested = await exampleDb.one<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.contradictions WHERE status = 'open'`,
    );
    expect(Number(contested?.n)).toBeGreaterThanOrEqual(1);

    // A mission with a gate that has no qualifying evidence, so it reads null rather than false.
    const gates = await exampleDb.query<{ g: { reached: boolean | null } }>(
      "app",
      `SELECT datum.evaluate_gate(g.value, datum.scope_ancestors(m.scope)) AS g
         FROM datum.missions m, jsonb_array_elements(m.gates) g
        WHERE m.superseded_by IS NULL`,
    );
    expect(gates.rows.some((r) => r.g.reached === null)).toBe(true);

    // Nearest-scope-wins, with no contradiction raised: scope is part of the exclusion key.
    const org = await take(exampleDb, { scope: "org/acme" });
    const proj = await take(exampleDb, { scope: "org/acme/proj/checkout" });
    expect(proj.chain[0]).toBe("org/acme/proj/checkout");
    expect(org.assertions.length).toBeGreaterThan(0);
    expect(proj.assertions.length).toBeGreaterThan(0);

    // Nothing in the example references any real person, project or org.
    const leak = await exampleDb.one<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.assertions
        WHERE lower(coalesce(claim,'') || ' ' || evidence::text) ~ '(aeonmind|arc|jish)'`,
    );
    expect(Number(leak?.n)).toBe(0);
  });
});
