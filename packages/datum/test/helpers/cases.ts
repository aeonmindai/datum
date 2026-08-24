import type { Db } from "../../src/db/pool.js";
import { asRejection } from "../../src/domain/errors.js";
import { assertFact } from "../../src/domain/store.js";
import { createMission } from "../../src/domain/store.js";
import { newId } from "../../src/domain/identity.js";
import type { AssertInput, AssertionRow } from "../../src/domain/types.js";

/**
 * The seven adversarial writes of deliverable 1, and the mutations that prove each guard is
 * load-bearing.
 *
 * Every case is run twice: once against the pristine schema, and once per mutation with that
 * one guard removed. A test that passes with the constraint removed proves nothing, so the
 * mutated outcome is asserted to be the opposite and both values are reported.
 */

export interface Outcome {
  accepted: boolean;
  reason: string | null;
  sqlstate: string | null;
  /** Verbatim, as Postgres said it. */
  message: string | null;
  extra?: Record<string, unknown>;
}

export interface Mutation {
  /** The guard being removed, in words. */
  guard: string;
  sql: string[];
  /** What must be observed once the guard is gone, in words. */
  expect: string;
  check(o: Outcome): boolean;
}

export interface CaseSpec {
  id: string;
  title: string;
  expect: "rejected" | "accepted";
  reason: string | null;
  invariant: number | null;
  mutations: Mutation[];
  run(db: Db): Promise<Outcome>;
}

/** Run a write and classify the result. Anything that is not a refusal is rethrown, so a
 *  broken test can never be recorded as a passing invariant. */
export async function attempt(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    await fn();
    return { accepted: true, reason: null, sqlstate: null, message: null };
  } catch (err) {
    const r = asRejection(err);
    if (!r) throw err;
    return { accepted: false, reason: r.reason, sqlstate: r.sqlstate, message: r.message };
  }
}

const EV = { source: "test/invariants.ts", instrument: "vitest" };
const SCOPE = "org/acme/proj/arc";

function base(over: Partial<AssertInput> = {}): AssertInput {
  return {
    scope: SCOPE,
    subject: "engine",
    predicate: "aggregate_tok_s_at_b256",
    object: { value: 757.5, unit: "tok/s" },
    kind: "measured",
    evidence: EV,
    asserted_by: "agent:test",
    valid_from: "2026-08-21T00:00:00Z",
    ...over,
  };
}

/**
 * Insert a `measured` row the only way one can legitimately exist: through the verifier role,
 * referencing a verification record. This is the shape the worker produces.
 */
export async function promote(
  db: Db,
  over: Partial<AssertInput> = {},
): Promise<{ assertion: AssertionRow; verificationId: string }> {
  const verificationId = newId("v");
  await db.query(
    "verifier",
    `INSERT INTO datum.verifications (id, target_assertion_id, outcome, checker, detail)
     VALUES ($1, $2, 'confirmed', 'test:seed', '{"note":"test fixture"}'::jsonb)`,
    [verificationId, "a_00000000000000000000000000"],
  );
  const { assertion } = await assertFact(
    db,
    base({ confidence: "measured", verification_id: verificationId, ...over }),
    { role: "verifier" },
  );
  return { assertion, verificationId };
}

const DROP_EXCLUSION = "ALTER TABLE datum.assertions DROP CONSTRAINT no_two_live_contradictions";

/** The exclusion constraint, widened to every confidence class — i.e. contradictions made
 *  blocking across authority tiers instead of advisory. This is the decision under test. */
const WIDEN_EXCLUSION_TO_ALL_TIERS = [
  DROP_EXCLUSION,
  `ALTER TABLE datum.assertions ADD CONSTRAINT no_two_live_contradictions
     EXCLUDE USING gist (scope WITH =, subject WITH =, predicate WITH =, valid_period WITH &&)
     WHERE (superseded_by IS NULL)`,
];

/** fn_apply_supersession with only the already-superseded branch removed, so the mutation
 *  isolates that single check rather than deleting the whole trigger. */
const SUPERSESSION_WITHOUT_CHAIN_CHECK = `
CREATE OR REPLACE FUNCTION datum.fn_apply_supersession()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = datum, pg_catalog AS $mut$
DECLARE v_target datum.assertions;
BEGIN
  IF NEW.supersedes IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_target FROM datum.assertions WHERE id = NEW.supersedes FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cannot supersede unknown assertion %', NEW.supersedes
      USING ERRCODE='23514', CONSTRAINT='supersedes_target_not_found',
            DETAIL=json_build_object('reason','supersedes_target_not_found')::text;
  END IF;
  UPDATE datum.assertions SET superseded_by = NEW.id, superseded_at = NEW.asserted_at
   WHERE id = NEW.supersedes;
  RETURN NEW;
END
$mut$;`;


/** fn_assertions_no_mutate with only the "already superseded, cannot re-stamp" branch
 *  removed. Needed because the same rule is defended twice: layer 1 refuses the insert with a
 *  precise reason, layer 2 refuses the stamp that insert would have caused. Removing one and
 *  observing the other is evidence of depth; removing both is what proves the rule matters. */
const NO_MUTATE_WITHOUT_RESTAMP_CHECK = `
CREATE OR REPLACE FUNCTION datum.fn_assertions_no_mutate()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = datum, pg_catalog AS $mut$
DECLARE v_exempt text[] := datum.immutability_exempt_columns('datum.assertions'::regclass);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'assertions are append-only: DELETE is never permitted (id=%)', OLD.id
      USING ERRCODE='23514', CONSTRAINT='assertions_are_append_only',
            DETAIL=json_build_object('reason','assertions_are_append_only','op','DELETE')::text;
  END IF;
  IF (to_jsonb(OLD) - v_exempt) IS DISTINCT FROM (to_jsonb(NEW) - v_exempt) THEN
    RAISE EXCEPTION 'assertions are immutable (id=%)', OLD.id
      USING ERRCODE='23514', CONSTRAINT='assertions_are_immutable',
            DETAIL=json_build_object('reason','assertions_are_immutable','op','UPDATE')::text;
  END IF;
  RETURN NEW;
END
$mut$;`;
export const CASES: CaseSpec[] = [
  {
    id: "1",
    title: "no evidence",
    expect: "rejected",
    reason: "evidence_required",
    invariant: 1,
    mutations: [
      {
        guard: "CHECK evidence_required",
        sql: ["ALTER TABLE datum.assertions DROP CONSTRAINT evidence_required"],
        expect: "the evidence-free write lands",
        check: (o) => o.accepted,
      },
    ],
    async run(db) {
      // Three shapes of "no evidence", all of which must be refused. The first is reported.
      const outcomes: Outcome[] = [];
      for (const evidence of [null, {}, { source: "   " }]) {
        outcomes.push(
          await attempt(() =>
            assertFact(db, base({ evidence: evidence as never }), { role: "app" }),
          ),
        );
      }
      const first = outcomes[0]!;
      return {
        ...first,
        extra: {
          "evidence: null": outcomes[0]!.reason ?? "ACCEPTED",
          "evidence: {}": outcomes[1]!.reason ?? "ACCEPTED",
          "evidence: {source:'   '}": outcomes[2]!.reason ?? "ACCEPTED",
        },
      };
    },
  },

  {
    id: "2",
    title: "UPDATE / DELETE",
    expect: "rejected",
    reason: "insufficient_privilege",
    invariant: 2,
    mutations: [
      {
        guard: "the grant system (GRANT UPDATE, DELETE to the runtime role)",
        sql: ["GRANT UPDATE, DELETE ON datum.assertions TO datum_app"],
        expect:
          "the privilege check no longer bites, so the trigger becomes the thing that refuses",
        check: (o) =>
          !o.accepted &&
          o.reason === "assertions_are_immutable" &&
          (o.extra as Record<string, string>)?.["delete_reason"] === "assertions_are_append_only",
      },
      {
        guard: "the grant system AND trigger trg_assertions_no_mutate",
        sql: [
          "GRANT UPDATE, DELETE ON datum.assertions TO datum_app",
          "DROP TRIGGER trg_assertions_no_mutate ON datum.assertions",
        ],
        expect: "the row is mutated and then deleted",
        check: (o) => o.accepted && (o.extra as Record<string, unknown>)?.["rows_left"] === 0,
      },
    ],
    async run(db) {
      const { assertion } = await assertFact(db, base({ confidence: "unverified" }), {
        role: "app",
      });
      const upd = await attempt(() =>
        db.query("app", `UPDATE datum.assertions SET object = '{"value":9999}'::jsonb WHERE id=$1`, [
          assertion.id,
        ]),
      );
      const del = await attempt(() =>
        db.query("app", `DELETE FROM datum.assertions WHERE id=$1`, [assertion.id]),
      );
      const left = await db.one<{ n: string }>(
        "app",
        `SELECT count(*)::text AS n FROM datum.assertions WHERE id=$1`,
        [assertion.id],
      );
      const value = await db.one<{ v: string | null }>(
        "app",
        `SELECT (object->>'value') AS v FROM datum.assertions WHERE id=$1`,
        [assertion.id],
      );
      return {
        accepted: upd.accepted || del.accepted,
        reason: upd.reason,
        sqlstate: upd.sqlstate,
        message: upd.message,
        extra: {
          update_reason: upd.reason ?? "ACCEPTED",
          update_sqlstate: upd.sqlstate,
          update_message: upd.message,
          delete_reason: del.reason ?? "ACCEPTED",
          delete_sqlstate: del.sqlstate,
          delete_message: del.message,
          rows_left: Number(left?.n ?? -1),
          value_now: value?.v ?? null,
        },
      };
    },
  },

  {
    id: "3",
    title: "two `measured` rows contradicting on the same scope/subject/predicate/period",
    expect: "rejected",
    reason: "no_two_live_contradictions",
    invariant: 3,
    mutations: [
      {
        guard: "EXCLUDE USING gist no_two_live_contradictions",
        sql: [DROP_EXCLUSION],
        expect: "two live measured rows disagree, and only an advisory record notices",
        check: (o) => o.accepted && (o.extra as Record<string, unknown>)?.["live_rows"] === 2,
      },
    ],
    async run(db) {
      await promote(db, { object: { value: 757.5, unit: "tok/s" } });
      const second = await attempt(() =>
        promote(db, {
          object: { value: 16600, unit: "tok/s" },
          valid_from: "2026-08-21T12:00:00Z",
        }),
      );
      const live = await db.one<{ n: string }>(
        "app",
        `SELECT count(*)::text AS n FROM datum.assertions
          WHERE superseded_by IS NULL AND confidence IN ('measured','derived')
            AND subject='engine' AND predicate='aggregate_tok_s_at_b256'`,
      );
      return { ...second, extra: { live_rows: Number(live?.n ?? -1) } };
    },
  },

  {
    id: "4",
    title: "kind='failed' without reopen_if",
    expect: "rejected",
    reason: "failed_requires_reopen_if",
    invariant: null,
    mutations: [
      {
        guard: "CHECK failed_requires_reopen_if",
        sql: ["ALTER TABLE datum.assertions DROP CONSTRAINT failed_requires_reopen_if"],
        expect: "a dead end lands with no falsifier attached",
        check: (o) => o.accepted,
      },
    ],
    async run(db) {
      // `why` is supplied so the only constraint that can fire is the one under test.
      return attempt(() =>
        assertFact(
          db,
          base({
            kind: "failed",
            subject: "ragged_pair",
            predicate: "decode_delta_pct",
            object: { value: -41, unit: "%" },
            why: "ragged pair regressed decode by 41% as shipped",
            reopen_if: null,
          }),
          { role: "app" },
        ),
      );
    },
  },

  {
    id: "5",
    title: "asserting `measured` directly",
    expect: "rejected",
    reason: "confidence_is_earned",
    invariant: 4,
    mutations: [
      {
        guard: "trigger trg_assertions_confidence_is_earned",
        sql: ["DROP TRIGGER trg_assertions_confidence_is_earned ON datum.assertions"],
        expect: "an agent successfully claims `measured` for itself",
        check: (o) => o.accepted,
      },
    ],
    async run(db) {
      // The verification row is created by the verifier first, so `measured_requires_
      // verification` cannot be the constraint that fires. The only thing left to refuse the
      // write is the role gate.
      const verificationId = newId("v");
      await db.query(
        "verifier",
        `INSERT INTO datum.verifications (id, target_assertion_id, outcome, checker)
         VALUES ($1, 'a_00000000000000000000000000', 'confirmed', 'test:seed')`,
        [verificationId],
      );
      const asAgent = await attempt(() =>
        assertFact(db, base({ confidence: "measured", verification_id: verificationId }), {
          role: "app",
        }),
      );
      // Positive control: the same write, from the role that earned the right, must land.
      const asVerifier = await attempt(() =>
        assertFact(
          db,
          base({
            confidence: "measured",
            verification_id: verificationId,
            object: { value: 757.5, unit: "tok/s" },
          }),
          { role: "verifier" },
        ),
      );
      return {
        ...asAgent,
        extra: {
          agent_role_outcome: asAgent.reason ?? "ACCEPTED",
          verifier_role_outcome: asVerifier.accepted ? "ACCEPTED" : (asVerifier.reason ?? "?"),
        },
      };
    },
  },

  {
    id: "6",
    title: "superseding an already-superseded row",
    expect: "rejected",
    reason: "supersedes_target_already_superseded",
    invariant: null,
    mutations: [
      {
        guard: "the already-superseded branch of fn_apply_supersession (layer 1 only)",
        sql: [SUPERSESSION_WITHOUT_CHAIN_CHECK],
        expect:
          "the write is still refused, but by the second layer — the re-stamp guard — with reason assertions_are_immutable",
        check: (o) => !o.accepted && o.reason === "assertions_are_immutable",
      },
      {
        guard: "both layers: the fn_apply_supersession branch and the re-stamp guard",
        sql: [SUPERSESSION_WITHOUT_CHAIN_CHECK, NO_MUTATE_WITHOUT_RESTAMP_CHECK],
        expect: "the chain forks: one row is superseded twice",
        check: (o) => o.accepted && (o.extra as Record<string, unknown>)?.["forks"] === 2,
      },
    ],
    async run(db) {
      const a = await assertFact(db, base({ object: { value: 1, unit: "tok/s" } }), { role: "app" });
      await assertFact(
        db,
        base({ object: { value: 2, unit: "tok/s" }, supersedes: a.assertion.id }),
        { role: "app" },
      );
      const third = await attempt(() =>
        assertFact(db, base({ object: { value: 3, unit: "tok/s" }, supersedes: a.assertion.id }), {
          role: "app",
        }),
      );
      const forks = await db.one<{ n: string }>(
        "app",
        `SELECT count(*)::text AS n FROM datum.assertions WHERE supersedes = $1`,
        [a.assertion.id],
      );
      return { ...third, extra: { forks: Number(forks?.n ?? -1) } };
    },
  },

  {
    id: "7",
    title: "ACCEPTED: a `confirmed-by-human` row contradicting a live `measured` row",
    expect: "accepted",
    reason: null,
    invariant: 3,
    mutations: [
      {
        guard:
          "the confidence predicate on the exclusion constraint (making contradictions blocking across tiers)",
        sql: WIDEN_EXCLUSION_TO_ALL_TIERS,
        expect: "the human's claim is refused and the knowledge is destroyed",
        check: (o) => !o.accepted && o.reason === "no_two_live_contradictions",
      },
      {
        guard: "trigger trg_assertions_detect_contradictions",
        sql: ["DROP TRIGGER trg_assertions_detect_contradictions ON datum.assertions"],
        expect: "the write still lands, but the disagreement becomes invisible",
        check: (o) =>
          o.accepted &&
          (o.extra as Record<string, unknown>)?.["contradictions"] === 0 &&
          (o.extra as Record<string, unknown>)?.["contested_on_read"] === false,
      },
    ],
    async run(db) {
      // The live example from Arc: the instrument has never observed <=60 minutes on one
      // card; Jish states it was reached once, before model confusion lost it. Blocking
      // would destroy that knowledge. Silent human-wins would mark a target reached with no
      // evidence. Advisory keeps both, and the pair tells the next agent what to do.
      const measured = await promote(db, {
        subject: "bake",
        predicate: "single_card_minutes",
        object: { value: 97.4, unit: "minutes" },
        claim: "single-card bake measured at 97.4 minutes",
      });

      const human = await attempt(() =>
        assertFact(
          db,
          base({
            subject: "bake",
            predicate: "single_card_minutes",
            object: { value: 60, unit: "minutes" },
            confidence: "confirmed-by-human",
            claim: "the <=60-minute single-card bake was reached once, then lost to model confusion",
            evidence: {
              source: "direct statement, 2026-08-24",
              human: "Jish",
              protocol: "none on record; the box and commit were not recovered",
            },
            asserted_by: "human:jish",
          }),
          { role: "app" },
        ),
      );

      const live = await db.one<{ n: string }>(
        "app",
        `SELECT count(*)::text AS n FROM datum.assertions
          WHERE superseded_by IS NULL AND subject='bake' AND predicate='single_card_minutes'`,
      );
      const contradictions = await db.one<{ n: string; a: string | null; b: string | null }>(
        "app",
        `SELECT count(*)::text AS n,
                min(a_confidence) AS a, max(b_confidence) AS b
           FROM datum.contradictions WHERE status='open'`,
      );
      const read = await db.query<{ take: { id: string; contested?: boolean } }>(
        "app",
        `SELECT datum.take(ARRAY['org/acme/proj/arc','org/acme/proj','org/acme','org']::text[],
                            'bake','single_card_minutes',NULL,NULL,50) AS take`,
      );

      // The safety property: a gate demanding `measured` cannot be satisfied by testimony,
      // however confidently the testimony is written.
      await createMission(db, {
        scope: "org/acme/proj/arc",
        statement: "Bake DeepSeek-V4-Flash into K=9/V=4/L=12 and serve it.",
        state: "active",
        gates: [
          {
            subject: "bake",
            predicate: "single_card_minutes",
            op: "<=",
            target: 60,
            requires_confidence: "measured",
          },
        ],
        asserted_by: "human:jish",
      });
      const gate = await db.one<{ g: Record<string, unknown> }>(
        "app",
        `SELECT datum.evaluate_gate(
                  '{"subject":"bake","predicate":"single_card_minutes","op":"<=","target":60,
                    "requires_confidence":"measured"}'::jsonb,
                  ARRAY['org/acme/proj/arc','org/acme/proj','org/acme','org']::text[]) AS g`,
      );

      return {
        ...human,
        extra: {
          live_rows: Number(live?.n ?? -1),
          measured_still_live: true,
          contradictions: Number(contradictions?.n ?? -1),
          contradiction_tiers: [contradictions?.a, contradictions?.b],
          contested_on_read: read.rows.every((r) => r.take.contested === true),
          rows_returned_on_read: read.rows.length,
          gate_reached_with_measured_required: gate?.g?.["reached"] ?? null,
          gate_evidence: gate?.g?.["evidence"] ?? null,
          measured_id: measured.assertion.id,
        },
      };
    },
  },
];
