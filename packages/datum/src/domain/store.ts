import type { Db, DbRole } from "../db/pool.js";
import { assertionHash, newAssertionId, newId } from "./identity.js";
import { asRejection, isDuplicateHash, Rejection } from "./errors.js";
import { resolveChain } from "./scope.js";
import type { AssertInput, AssertionRow, Gate, GateStatus, MissionRow } from "./types.js";

/**
 * The write and read paths.
 *
 * Datum writes what it is told, with evidence, or rejects the write. It never extracts a fact
 * from prose: a customer audit of 10,134 mem0 entries found 97.8% junk, including 808 copies
 * of one hallucinated preference manufactured by a recall→re-extraction loop. There is no
 * extraction code in this file and there is not meant to be.
 */

const INSERT_COLUMNS = `
  id, hash, scope, subject, predicate, object, claim, kind, binding, confidence, evidence,
  valid_from, valid_to, asserted_by, supersedes, why, reopen_if, causality, derived_from,
  verification_id`;

const RETURNING = `
  id, hash, scope, scope_depth, subject, predicate, object, claim, kind, binding, confidence,
  evidence, valid_from, valid_to, asserted_at, asserted_by, supersedes, superseded_by,
  superseded_at, why, reopen_if, causality, derived_from, verification_id, created_at`;

export interface AssertResult {
  assertion: AssertionRow;
  /** False when this exact content was already on record: `assert` is idempotent by hash. */
  created: boolean;
}

export async function assertFact(
  db: Db,
  input: AssertInput,
  opts: { role?: DbRole } = {},
): Promise<AssertResult> {
  const role: DbRole = opts.role ?? "app";
  const validFrom = input.valid_from ?? new Date().toISOString();
  const body = {
    scope: input.scope,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    kind: input.kind,
    binding: input.binding ?? false,
    // An agent that does not say defaults to `unverified`. Confidence is earned.
    confidence: input.confidence ?? "unverified",
    evidence: input.evidence,
    valid_from: validFrom,
    valid_to: input.valid_to ?? null,
    supersedes: input.supersedes ?? null,
    why: input.why ?? null,
    reopen_if: input.reopen_if ?? null,
  };
  const hash = assertionHash(body);

  try {
    return await db.tx(role, async (client) => {
      const existing = await client.query<AssertionRow>(
        `SELECT ${RETURNING} FROM datum.assertions WHERE hash = $1`,
        [hash],
      );
      const found = existing.rows[0];
      if (found) return { assertion: found, created: false };

      const id = newAssertionId();
      const inserted = await client.query<AssertionRow>(
        `INSERT INTO datum.assertions (${INSERT_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING ${RETURNING}`,
        [
          id,
          hash,
          body.scope,
          body.subject,
          body.predicate,
          JSON.stringify(body.object),
          input.claim ?? null,
          body.kind,
          body.binding,
          body.confidence,
          JSON.stringify(body.evidence ?? null),
          body.valid_from,
          body.valid_to,
          input.asserted_by,
          body.supersedes,
          body.why,
          body.reopen_if,
          input.causality ?? null,
          input.derived_from ?? [],
          input.verification_id ?? null,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("insert returned no row");

      // Outbox, not LISTEN/NOTIFY: NOTIFY takes a global AccessExclusiveLock at commit,
      // which serialises the whole instance. Written in v0, consumed when projections land.
      await client.query(
        `INSERT INTO datum.outbox (topic, payload, causality) VALUES ($1, $2::jsonb, $3)`,
        ["assertion.created", JSON.stringify({ id: row.id, scope: row.scope }), row.causality],
      );
      return { assertion: row, created: true };
    });
  } catch (err) {
    if (isDuplicateHash(err)) {
      // Lost a race with an identical write. The winner's row is the answer.
      const row = await db.one<AssertionRow>(
        role,
        `SELECT ${RETURNING} FROM datum.assertions WHERE hash = $1`,
        [hash],
      );
      if (row) return { assertion: row, created: false };
    }
    throw asRejection(err) ?? err;
  }
}

/** A correction is an assertion that names what it replaces. There is no update path. */
export async function supersede(
  db: Db,
  targetId: string,
  input: Omit<AssertInput, "supersedes">,
  opts: { role?: DbRole } = {},
): Promise<AssertResult> {
  return assertFact(db, { ...input, supersedes: targetId }, opts);
}

export interface TakeOptions {
  scope: string;
  subject?: string | null;
  predicate?: string | null;
  kind?: string | null;
  /** As-of read on the assert-time axis: what did we believe at this sequence number. */
  asOf?: number | null;
  limit?: number;
}

export interface TakeResult {
  scope: string;
  mode: string;
  chain: string[];
  as_of: number | null;
  assertions: AssertionRow[];
}

export async function take(db: Db, opts: TakeOptions, role: DbRole = "app"): Promise<TakeResult> {
  const { chain, mode } = await resolveChain(db, opts.scope, role);
  const { rows } = await db.query<{ take: AssertionRow }>(
    role,
    `SELECT datum.take($1::text[], $2, $3, $4, $5::bigint, $6) AS take`,
    [
      chain,
      opts.subject ?? null,
      opts.predicate ?? null,
      opts.kind ?? null,
      opts.asOf ?? null,
      opts.limit ?? 50,
    ],
  );
  return {
    scope: opts.scope,
    mode,
    chain,
    as_of: opts.asOf ?? null,
    assertions: rows.map((r) => r.take),
  };
}

export async function search(
  db: Db,
  scope: string,
  query: string,
  limit = 25,
  role: DbRole = "app",
): Promise<AssertionRow[]> {
  const { chain } = await resolveChain(db, scope, role);
  const { rows } = await db.query<{ search: AssertionRow }>(
    role,
    `SELECT datum.search($1::text[], $2, $3) AS search`,
    [chain, query, limit],
  );
  return rows.map((r) => r.search);
}

export async function lineage(db: Db, id: string, role: DbRole = "app"): Promise<AssertionRow[]> {
  const { rows } = await db.query<{ lineage: AssertionRow }>(
    role,
    `SELECT datum.lineage($1) AS lineage`,
    [id],
  );
  return rows.map((r) => r.lineage);
}

export async function byId(db: Db, id: string, role: DbRole = "app"): Promise<AssertionRow | null> {
  return db.one<AssertionRow>(role, `SELECT ${RETURNING} FROM datum.assertions WHERE id = $1`, [id]);
}

export async function currentSequence(db: Db, role: DbRole = "app"): Promise<number> {
  const row = await db.one<{ seq: string }>(
    role,
    `SELECT coalesce(max(asserted_at), 0)::text AS seq FROM datum.assertions`,
  );
  return Number(row?.seq ?? 0);
}

// ---------------------------------------------------------------------------------------
// Missions

export interface MissionWithGates extends Omit<MissionRow, "gates"> {
  gates: GateStatus[];
}

export async function missions(
  db: Db,
  scope: string,
  role: DbRole = "app",
): Promise<MissionWithGates[]> {
  const { chain } = await resolveChain(db, scope, role);
  const { rows } = await db.query<MissionRow>(
    role,
    `SELECT * FROM datum.missions
      WHERE superseded_by IS NULL AND scope = ANY($1::text[])
      ORDER BY array_position($1::text[], scope), asserted_at DESC`,
    [chain],
  );

  const out: MissionWithGates[] = [];
  for (const m of rows) {
    const gates: GateStatus[] = [];
    for (const gate of m.gates) {
      const status = await db.one<{ evaluate_gate: Record<string, unknown> }>(
        role,
        `SELECT datum.evaluate_gate($1::jsonb, $2::text[]) AS evaluate_gate`,
        [JSON.stringify(gate), chain],
      );
      gates.push({ ...gate, ...(status?.evaluate_gate ?? {}) } as GateStatus);
    }
    out.push({ ...m, gates });
  }
  return out;
}

export async function createMission(
  db: Db,
  input: {
    scope: string;
    statement: string;
    state: MissionRow["state"];
    gates: Gate[];
    asserted_by: string;
    supersedes?: string | null;
  },
  role: DbRole = "app",
): Promise<MissionRow> {
  try {
    const row = await db.one<MissionRow>(
      role,
      `INSERT INTO datum.missions (id, scope, statement, state, gates, version, supersedes, asserted_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,
               coalesce((SELECT version + 1 FROM datum.missions WHERE id = $6), 1),
               $6, $7)
       RETURNING *`,
      [
        newId("m"),
        input.scope,
        input.statement,
        input.state,
        JSON.stringify(input.gates),
        input.supersedes ?? null,
        input.asserted_by,
      ],
    );
    if (!row) throw new Error("mission insert returned no row");
    return row;
  } catch (err) {
    throw asRejection(err) ?? err;
  }
}

// ---------------------------------------------------------------------------------------
// Contradictions, the registry, the rejection log

export interface ContradictionRow {
  id: string;
  scope: string;
  subject: string;
  predicate: string;
  a_id: string;
  b_id: string;
  a_confidence: string;
  b_confidence: string;
  status: string;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  detected_at: string;
}

export async function contradictions(
  db: Db,
  opts: { status?: string; limit?: number } = {},
  role: DbRole = "app",
): Promise<ContradictionRow[]> {
  const { rows } = await db.query<ContradictionRow>(
    role,
    `SELECT * FROM datum.contradictions
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY detected_at DESC LIMIT $2`,
    [opts.status ?? null, opts.limit ?? 100],
  );
  return rows;
}

export async function logRejection(
  db: Db,
  entry: {
    actor: string | null;
    route: string;
    rejection: Rejection;
    scope?: string | null;
    subject?: string | null;
    predicate?: string | null;
  },
): Promise<void> {
  // The rejecting transaction has already rolled back, so this is necessarily a new one.
  try {
    await db.query(
      "app",
      `INSERT INTO datum.rejections (id, actor, route, reason, sqlstate, message, detail, scope, subject, predicate)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
      [
        newId("r"),
        entry.actor,
        entry.route,
        entry.rejection.reason,
        entry.rejection.sqlstate,
        entry.rejection.message.slice(0, 2000),
        JSON.stringify(entry.rejection.detail),
        entry.scope ?? null,
        entry.subject ?? null,
        entry.predicate ?? null,
      ],
    );
  } catch (err) {
    // Never let audit logging fail a request that already has an answer.
    console.error(`[rejections] could not record refusal: ${(err as Error).message}`);
  }
}
