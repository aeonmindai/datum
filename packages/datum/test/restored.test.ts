import { randomBytes } from "node:crypto";
import { describe, expect, it, afterAll } from "vitest";
import { Db } from "../src/db/pool.js";
import { makeCases } from "./helpers/cases.js";

/**
 * Deliverable 8 — the restored database must still refuse everything.
 *
 * `scripts/restore-drill.sh` restores a `pg_dump` into a throwaway Postgres, replays the
 * GRANT/REVOKE layer that `--no-privileges` leaves out of the dump, and then runs THIS file
 * against the restored server. That is the difference between "the bytes came back" and "the
 * invariants came back", and only the second one is a backup.
 *
 * The seven cases run in a scope unique to this run, so they neither collide with whatever data
 * was restored nor leave anything behind that looks like a real fact.
 *
 * Skipped unless DATUM_RESTORED_URL is set, so a normal `npm test` is unaffected.
 */

const url = process.env.DATUM_RESTORED_URL;
const scope = `org/restore-drill/run-${randomBytes(4).toString("hex")}/proj/probe`;
const db = url ? new Db(url, { max: 4 }) : null;

afterAll(async () => {
  await db?.close();
});

describe.skipIf(!url)("deliverable 8 — invariants survive a restore", () => {
  it("has the exclusion constraint, with its partial predicate intact", async () => {
    const row = await db!.one<{ contype: string; def: string }>(
      "owner",
      `SELECT contype::text, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conname = 'no_two_live_contradictions'`,
    );
    expect(row?.contype).toBe("x");
    expect(row?.def).toContain("EXCLUDE USING gist");
    // The predicate is what keeps human testimony exempt. A restore that lost it would turn
    // advisory contradictions back into blocking ones and silently destroy knowledge.
    expect(row?.def).toContain("'measured'::text");
    expect(row?.def).toContain("'derived'::text");
  });

  it("still withholds UPDATE, DELETE and TRUNCATE from every runtime role", async () => {
    const { rows } = await db!.query<{ role: string; priv: string }>(
      "owner",
      `SELECT grantee AS role, privilege_type AS priv
         FROM information_schema.role_table_grants
        WHERE table_schema = 'datum' AND table_name = 'assertions'
          AND grantee IN ('datum_app','datum_verifier')`,
    );
    const privs = rows.map((r) => `${r.role}:${r.priv}`);
    // A restore that dropped the grants entirely would make the negative checks below pass
    // vacuously, so the positive grants are asserted first.
    expect(privs).toContain("datum_app:SELECT");
    expect(privs).toContain("datum_app:INSERT");
    expect(privs.filter((p) => /UPDATE|DELETE|TRUNCATE/.test(p))).toEqual([]);
  });
  // One database, seven cases, so each case gets its own scope. Sharing a scope would let one
  // case's rows satisfy another's setup — and because `assert` is idempotent by content hash,
  // a collision would surface as a spurious "accepted".
  for (const spec of makeCases(scope)) {
    it(`case ${spec.id} — ${spec.title} — is still ${spec.expect}`, async () => {
      const [isolated] = makeCases(`${scope}/case-${spec.id}`).filter((c) => c.id === spec.id);
      const outcome = await isolated!.run(db!);
      if (spec.expect === "rejected") {
        expect(outcome.accepted).toBe(false);
        expect(outcome.reason).toBe(spec.reason);
      } else {
        expect(outcome.accepted).toBe(true);
      }
    });
  }
});
