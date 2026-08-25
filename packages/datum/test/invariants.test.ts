import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { CASES, type Outcome } from "./helpers/cases.js";
import type { Db } from "../src/db/pool.js";

/**
 * Deliverable 1. Seven adversarial writes, each handled correctly by the database with a
 * machine-readable reason, and every assertion mutation-checked both ways.
 *
 * The mutation check is the part that makes this evidence rather than decoration: a test that
 * still passes with its constraint dropped is testing nothing. So each case runs against the
 * pristine schema, then again on a fresh fork with exactly one guard removed, and the suite
 * asserts the outcome flipped. Both values end up in reports/invariants.md.
 */

const REPORT_DIR = fileURLToPath(new URL("../../../reports/", import.meta.url));

interface Row {
  case: string;
  title: string;
  expect: string;
  invariant: number | null;
  pristine: Outcome;
  mutations: Array<{ guard: string; expect: string; observed: Outcome; flipped: boolean }>;
}

let pg: TestPostgres;
const report: Row[] = [];
const open: Db[] = [];

async function fork(name: string): Promise<Db> {
  const db = await pg.fork(name);
  open.push(db);
  return db;
}

beforeAll(async () => {
  pg = await startPostgres();
  console.log(`\n  real postgres ${pg.version} in container ${pg.container}\n`);
}, 240_000);

afterAll(async () => {
  await Promise.all(open.map((d) => d.close().catch(() => {})));
  if (pg) {
    await mkdir(REPORT_DIR, { recursive: true });
    await writeFile(
      `${REPORT_DIR}invariants.json`,
      JSON.stringify(
        { postgres: pg.version, image: process.env.DATUM_TEST_PG_IMAGE ?? "postgres:latest", generated_at: new Date().toISOString(), cases: report },
        null,
        2,
      ),
    );
    await writeFile(`${REPORT_DIR}invariants.md`, renderMarkdown(pg.version, report));
    await pg.stop();
  }
});

describe("deliverable 1 — schema and the five invariants", () => {
  it("runs on postgres:latest while depending on nothing newer than PG13", async () => {
    const db = await fork("datum_probe");
    const row = await db.one<{ v: string; ext: string }>(
      "owner",
      `SELECT current_setting('server_version') AS v,
              (SELECT extversion FROM pg_extension WHERE extname='btree_gist') AS ext`,
    );
    expect(Number.parseInt(row!.v, 10)).toBeGreaterThanOrEqual(13);
    expect(row!.ext).toBeTruthy();

    // The invariant-3 constraint must be the portable exclusion constraint, not PG18
    // WITHOUT OVERLAPS. Asserting the mechanism keeps a future "simplification" honest.
    const con = await db.one<{ contype: string; def: string }>(
      "owner",
      `SELECT contype::text, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conname='no_two_live_contradictions'`,
    );
    expect(con!.contype).toBe("x");
    expect(con!.def).toContain("EXCLUDE USING gist");
    expect(con!.def).toContain("superseded_by IS NULL");
    expect(con!.def).toContain("'measured'::text");
    expect(con!.def).toContain("'derived'::text");
    expect(con!.def.toUpperCase()).not.toContain("WITHOUT OVERLAPS");
  });

  it("revokes UPDATE and DELETE from every runtime role", async () => {
    const db = await fork("datum_grants");
    const rows = await db.query<{ role: string; priv: string }>(
      "owner",
      `SELECT grantee AS role, privilege_type AS priv
         FROM information_schema.role_table_grants
        WHERE table_schema='datum' AND table_name='assertions'
          AND grantee IN ('datum_app','datum_verifier')
        ORDER BY 1,2`,
    );
    const privs = rows.rows.map((r) => `${r.role}:${r.priv}`);
    expect(privs).toContain("datum_app:SELECT");
    expect(privs).toContain("datum_app:INSERT");
    expect(privs.filter((p) => p.endsWith("UPDATE"))).toEqual([]);
    expect(privs.filter((p) => p.endsWith("DELETE"))).toEqual([]);
    expect(privs.filter((p) => p.endsWith("TRUNCATE"))).toEqual([]);
  });

  for (const spec of CASES) {
    it(`case ${spec.id} — ${spec.title} — is ${spec.expect}`, async () => {
      const pristineDb = await fork(`datum_case${spec.id}_pristine`);
      const pristine = await spec.run(pristineDb);

      if (spec.expect === "rejected") {
        expect(pristine.accepted, `case ${spec.id} must be refused by the database`).toBe(false);
        expect(pristine.reason).toBe(spec.reason);
        expect(pristine.message, "a refusal must carry a message").toBeTruthy();
      } else {
        expect(pristine.accepted, `case ${spec.id} must land`).toBe(true);
      }

      const mutations: Row["mutations"] = [];
      for (const [i, mutation] of spec.mutations.entries()) {
        const db = await fork(`datum_case${spec.id}_mut${i}`);
        for (const sql of mutation.sql) await db.query("owner", sql);
        const observed = await spec.run(db);
        const flipped = mutation.check(observed);
        mutations.push({ guard: mutation.guard, expect: mutation.expect, observed, flipped });
        expect(
          flipped,
          `case ${spec.id}: with "${mutation.guard}" removed, expected ${mutation.expect}, ` +
            `but observed ${JSON.stringify(observed)}`,
        ).toBe(true);
      }

      report.push({
        case: spec.id,
        title: spec.title,
        expect: spec.expect,
        invariant: spec.invariant,
        pristine,
        mutations,
      });
    });
  }
});

function renderMarkdown(version: string, rows: Row[]): string {
  const out: string[] = [];
  out.push("# Deliverable 1 — the seven cases, mutation-checked both ways");
  out.push("");
  out.push(`Generated by \`npm run test:invariants\` against **real Postgres ${version}** in a`);
  out.push("container. Nothing in this suite is stubbed: every refusal below came out of the");
  out.push("database, and every reason is the constraint or trigger name Postgres reported.");
  out.push("");
  out.push("| # | case | expected | reason reported | sqlstate |");
  out.push("|---|---|---|---|---|");
  for (const r of rows.sort((a, b) => a.case.localeCompare(b.case))) {
    out.push(
      `| ${r.case} | ${r.title} | **${r.expect}** | \`${r.pristine.reason ?? "—"}\` | ${r.pristine.sqlstate ?? "—"} |`,
    );
  }
  out.push("");
  for (const r of rows.sort((a, b) => a.case.localeCompare(b.case))) {
    out.push(`## Case ${r.case} — ${r.title}`);
    out.push("");
    out.push(`- expected: **${r.expect}**${r.invariant ? ` (invariant ${r.invariant})` : ""}`);
    out.push(`- accepted: \`${r.pristine.accepted}\``);
    out.push(`- reason: \`${r.pristine.reason ?? "—"}\`  sqlstate: \`${r.pristine.sqlstate ?? "—"}\``);
    if (r.pristine.message) {
      out.push("- message, verbatim:");
      out.push("");
      out.push("  ```");
      out.push(`  ${r.pristine.message}`);
      out.push("  ```");
    }
    if (r.pristine.extra) {
      out.push("- observed:");
      for (const [k, v] of Object.entries(r.pristine.extra)) {
        out.push(`  - \`${k}\` = \`${JSON.stringify(v)}\``);
      }
    }
    out.push("");
    out.push("### Mutation check");
    out.push("");
    for (const m of r.mutations) {
      out.push(`**Removed:** ${m.guard}`);
      out.push("");
      out.push(`| direction | accepted | reason | sqlstate |`);
      out.push(`|---|---|---|---|`);
      out.push(
        `| guard present | \`${r.pristine.accepted}\` | \`${r.pristine.reason ?? "—"}\` | \`${r.pristine.sqlstate ?? "—"}\` |`,
      );
      out.push(
        `| guard removed | \`${m.observed.accepted}\` | \`${m.observed.reason ?? "—"}\` | \`${m.observed.sqlstate ?? "—"}\` |`,
      );
      out.push("");
      out.push(`Expected without the guard: ${m.expect}. Observed: \`${m.flipped}\`.`);
      if (m.observed.extra) {
        for (const [k, v] of Object.entries(m.observed.extra)) {
          out.push(`- \`${k}\` = \`${JSON.stringify(v)}\``);
        }
      }
      out.push("");
    }
  }
  return out.join("\n");
}
