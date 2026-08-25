import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import type { Db } from "../src/db/pool.js";
import { newId } from "../src/domain/identity.js";

/**
 * The load-bearing invariant of the episodes plane: a conversation is evidence, never a
 * measurement.
 *
 * Episodes exist so that what somebody said stops being lost. The danger they introduce is the
 * failure mode of every memory product: extract facts from prose, then re-extract from your own
 * output. One audited deployment held 10,134 entries, 97.8% junk, including 808 copies of a
 * single invented preference. The corpus this store was built for has the same disease from the
 * same cause - 449 correction markers across 21,619 lines.
 *
 * So the rule is enforced by the database, not by whoever writes the next ingest path: an
 * assertion whose evidence names an episode can never be `measured` or `derived`. A conversation
 * can support "a named human said so" and nothing stronger, which means it can never close a
 * gate, because `evaluate_gate` reads a single confidence class and the two strong classes are
 * writable only by the verifier.
 *
 * Every assertion below is mutation-checked. A guard that can be removed with the test still
 * passing is not a guard.
 */

let pg: TestPostgres;
const open: Db[] = [];

async function fork(name: string): Promise<Db> {
  const db = await pg.fork(name);
  open.push(db);
  return db;
}

beforeAll(async () => {
  pg = await startPostgres();
}, 300_000);

afterAll(async () => {
  await Promise.all(open.map((d) => d.close().catch(() => {})));
  await pg?.stop();
});

const SCOPE = "org/acme";

/** A verification row, so `measured_requires_verification` is satisfied and cannot be the thing
 *  doing the refusing. Without this the episode guard is never reached and the test is a lie.
 *  `target_assertion_id` is deliberately a bare text column, not a foreign key, because a
 *  verification is written before the row it promotes exists. */
async function verification(db: Db): Promise<string> {
  const id = newId("v");
  await db.query(
    "verifier",
    `INSERT INTO datum.verifications (id, target_assertion_id, outcome, checker, detail)
     VALUES ($1, $2, 'confirmed', 'worker:verification@acme', '{}'::jsonb)`,
    [id, newId("a")],
  );
  return id;
}

interface Attempt {
  accepted: boolean;
  constraint: string | null;
}

/** Write an otherwise-valid row at a given confidence with given evidence, as the verifier -
 *  the only role permitted the strong classes. */
async function write(
  db: Db,
  opts: { confidence: string; evidence: Record<string, unknown>; verificationId?: string },
): Promise<Attempt> {
  const cols = ["id", "scope", "subject", "predicate", "object", "kind", "confidence", "evidence", "valid_from", "asserted_by", "hash"];
  const vals: unknown[] = [
    newId("a"),
    SCOPE,
    `s_${Math.random().toString(36).slice(2, 8)}`,
    "p",
    JSON.stringify({ value: 1 }),
    "measured",
    opts.confidence,
    JSON.stringify(opts.evidence),
    new Date().toISOString(),
    "worker:verification@acme",
    `sha256:${Math.random().toString(16).slice(2).padEnd(64, "0").slice(0, 64)}`,
  ];
  if (opts.verificationId) {
    cols.push("verification_id");
    vals.push(opts.verificationId);
  }
  if (opts.confidence === "derived") {
    cols.push("derived_from");
    vals.push([newId("a")]);
  }
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  try {
    await db.query("verifier", `INSERT INTO datum.assertions (${cols.join(",")}) VALUES (${placeholders})`, vals);
    return { accepted: true, constraint: null };
  } catch (err) {
    const e = err as { constraint?: string };
    return { accepted: false, constraint: e.constraint ?? null };
  }
}

const EPISODE_EVIDENCE = { source: "chat", episode: "e_01M0WMCDEY86SE60HQS9DXBKN1" };
const GIT_EVIDENCE = { source: "git", commit: "4d03b9e25", repo: "aeonmind/arc" };

describe("an episode is evidence, never a measurement", () => {
  it("refuses `measured` when the evidence is a conversation", async () => {
    const db = await fork("ep_measured");
    const v = await verification(db);
    const out = await write(db, { confidence: "measured", evidence: EPISODE_EVIDENCE, verificationId: v });
    expect(out.accepted).toBe(false);
    expect(out.constraint).toBe("episode_evidence_is_never_measured");
  });

  it("refuses `derived` when the evidence is a conversation", async () => {
    const db = await fork("ep_derived");
    const out = await write(db, { confidence: "derived", evidence: EPISODE_EVIDENCE });
    expect(out.accepted).toBe(false);
    expect(out.constraint).toBe("episode_evidence_is_never_measured");
  });

  it("accepts the identical row when the evidence is a git commit — so the guard is the evidence, not the shape", async () => {
    // Without this control the two refusals above prove only that my INSERT was malformed.
    const db = await fork("ep_control");
    const v = await verification(db);
    const out = await write(db, { confidence: "measured", evidence: GIT_EVIDENCE, verificationId: v });
    expect(out.accepted, `control row refused by ${out.constraint}`).toBe(true);
  });

  it("accepts a human confirming what was said — the bridge from conversation to record", async () => {
    // This is the whole point of the plane. A person reading a transcript and vouching for it is
    // testimony, and testimony is a real confidence class. It just is not a measurement.
    const db = await fork("ep_human");
    const out = await write(db, {
      confidence: "confirmed-by-human",
      evidence: { ...EPISODE_EVIDENCE, human: "jish" },
    });
    expect(out.accepted, `refused by ${out.constraint}`).toBe(true);
  });

  it("MUTATION: with the guard dropped, a conversation becomes a measurement", async () => {
    // The both-ways proof. `measured_requires_verification` is satisfied first, so this isolates
    // exactly one guard: remove it and the write lands.
    const db = await fork("ep_mutation");
    const v = await verification(db);

    const before = await write(db, { confidence: "measured", evidence: EPISODE_EVIDENCE, verificationId: v });
    expect(before.accepted).toBe(false);
    expect(before.constraint).toBe("episode_evidence_is_never_measured");

    await db.query("owner", `ALTER TABLE datum.assertions DROP CONSTRAINT episode_evidence_is_never_measured`);

    const after = await write(db, { confidence: "measured", evidence: EPISODE_EVIDENCE, verificationId: v });
    expect(after.accepted, "guard removed but the write still failed — something else is refusing").toBe(true);

    console.log(
      `\n  episode_evidence_is_never_measured: present -> refused (${before.constraint}); dropped -> accepted\n`,
    );
  });

  it("a gate demanding `measured` cannot be closed by anything a conversation supports", async () => {
    // The consequence that actually matters. A human vouches for a value that would satisfy the
    // comparison, and the gate still reads no-evidence, because it reads one confidence class.
    const db = await fork("ep_gate");
    await db.query("app", `INSERT INTO datum.scopes (path, kind, label) VALUES ($1,'org','Acme')`, [SCOPE]);

    const subject = "bake";
    const predicate = "minutes";
    await db.query(
      "app",
      `INSERT INTO datum.assertions
         (id, scope, subject, predicate, object, kind, confidence, evidence, valid_from, asserted_by, hash)
       VALUES ($1,$2,$3,$4,$5,'measured','confirmed-by-human',$6,now(),'human:jish',$7)`,
      [
        newId("a"),
        SCOPE,
        subject,
        predicate,
        JSON.stringify({ value: 42 }),
        JSON.stringify({ source: "chat", episode: "e_01M0WMCDEY86SE60HQS9DXBKN1", human: "jish" }),
        `sha256:${"c".repeat(64)}`,
      ],
    );

    const gate = { subject, predicate, op: "<=", target: 60, requires_confidence: "measured" };
    const status = await db.one<{ evaluate_gate: Record<string, unknown> }>(
      "app",
      `SELECT datum.evaluate_gate($1::jsonb, $2::text[]) AS evaluate_gate`,
      [JSON.stringify(gate), [SCOPE]],
    );
    const result = status?.evaluate_gate ?? {};

    // 42 <= 60 is true. The gate is still not reached, because no row of the required class exists.
    expect(result["reached"]).toBeNull();
    expect(result["why_null"]).toContain("no live assertion of the required confidence class");

    // And the same gate at the class a human CAN write does resolve, proving the value was there
    // all along and only the class was refusing.
    const human = await db.one<{ evaluate_gate: Record<string, unknown> }>(
      "app",
      `SELECT datum.evaluate_gate($1::jsonb, $2::text[]) AS evaluate_gate`,
      [JSON.stringify({ ...gate, requires_confidence: "confirmed-by-human" }), [SCOPE]],
    );
    expect(human?.evaluate_gate["reached"]).toBe(true);
    expect(Number(human?.evaluate_gate["actual"])).toBe(42);
  });

  it("episodes themselves are append-only", async () => {
    const db = await fork("ep_immutable");
    const id = newId("e");
    await db.query(
      "app",
      `INSERT INTO datum.episodes
         (id, scope, session_id, seq, occurred_at, actor, role, text, source, hash)
       VALUES ($1,$2,'s1',0,now(),'human:jish','human','a thing was said',$3,$4)`,
      [id, SCOPE, JSON.stringify({ kind: "test" }), `sha256:${"d".repeat(64)}`],
    );

    for (const sql of [
      `UPDATE datum.episodes SET text = 'rewritten' WHERE id = $1`,
      `DELETE FROM datum.episodes WHERE id = $1`,
    ]) {
      let constraint: string | null = null;
      try {
        await db.query("owner", sql, [id]);
      } catch (err) {
        constraint = (err as { constraint?: string }).constraint ?? null;
      }
      // Owner, not app: privilege revocation stops the app roles, the trigger stops everyone.
      expect(constraint, `${sql} was not refused`).toBe("episodes_are_immutable");
    }
  });
});
