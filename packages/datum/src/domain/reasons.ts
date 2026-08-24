/**
 * Machine-readable rejection reasons.
 *
 * Every refusal the database can produce has a stable name, and that name is the wire
 * contract. Postgres reports it in the error's `constraint` field for CHECK, EXCLUDE and
 * explicit `RAISE ... USING CONSTRAINT`, which means a trigger refusal and a check
 * violation are indistinguishable to a client — deliberately, because the caller should
 * care what rule it broke, not which mechanism caught it.
 *
 * A write that violates an invariant is rejected. Not warned. Not logged and kept.
 */

export type Reason =
  // invariant 1 — no assertion without evidence
  | "evidence_required"
  | "human_evidence_names_a_human"
  // invariant 2 — no mutation, ever
  | "assertions_are_immutable"
  | "assertions_are_append_only"
  | "missions_are_immutable"
  | "missions_are_append_only"
  // invariant 3 — no two live contradicting assertions, within the machine tier
  | "no_two_live_contradictions"
  // invariant 4 — confidence is earned, never claimed
  | "confidence_is_earned"
  | "measured_requires_verification"
  | "derived_requires_inputs"
  // invariant 5 — no target without a machine-checkable gate
  | "target_requires_machine_checkable_gate"
  | "gates_must_be_machine_checkable"
  | "active_mission_requires_gate"
  // a dead end must carry its own falsifier
  | "failed_requires_reopen_if"
  | "failure_requires_why"
  // supersession integrity
  | "supersedes_target_not_found"
  | "supersedes_target_already_superseded"
  | "mission_supersedes_target_not_found"
  | "mission_supersedes_target_already_superseded"
  | "no_self_supersede"
  // shape
  | "id_shape"
  | "hash_shape"
  | "scope_shape"
  | "mission_scope_shape"
  | "subject_present"
  | "predicate_present"
  | "kind_known"
  | "confidence_known"
  | "valid_period_ordered"
  | "mission_state_known"
  | "mission_statement_present"
  | "superseded_at_with_by"
  // invariant 2, first layer: the grant system refused before any trigger ran
  | "insufficient_privilege"
  // not a constraint: the request never reached the database
  | "unauthorized"
  | "forbidden"
  | "malformed_request"
  | "not_found"
  | "internal";

export interface ReasonSpec {
  readonly invariant: 1 | 2 | 3 | 4 | 5 | null;
  readonly http: number;
  readonly says: string;
}

export const REASONS: Record<Reason, ReasonSpec> = {
  evidence_required: {
    invariant: 1,
    http: 422,
    says: "Every assertion carries evidence with a non-empty `source`. Optional provenance provably decays, so it is not optional.",
  },
  human_evidence_names_a_human: {
    invariant: 1,
    http: 422,
    says: "`confirmed-by-human` means a named human. Set evidence.human.",
  },
  assertions_are_immutable: {
    invariant: 2,
    http: 409,
    says: "Assertions are never updated. Correct a fact by inserting a new one with supersedes=<id>.",
  },
  assertions_are_append_only: {
    invariant: 2,
    http: 409,
    says: "Assertions are never deleted or truncated. The log is the record.",
  },
  missions_are_immutable: {
    invariant: 2,
    http: 409,
    says: "Missions are versioned by supersession, so an edited objective never silently erases the old one.",
  },
  missions_are_append_only: { invariant: 2, http: 409, says: "Missions are never deleted." },
  no_two_live_contradictions: {
    invariant: 3,
    http: 409,
    says: "Two reproducible facts cannot disagree about the same scope, subject, predicate and period. One of them is wrong: supersede it explicitly.",
  },
  confidence_is_earned: {
    invariant: 4,
    http: 422,
    says: "An agent cannot assert `measured`. Write it `unverified`; the verification worker promotes it once evidence.commit resolves and is contained where claimed.",
  },
  measured_requires_verification: {
    invariant: 4,
    http: 422,
    says: "A `measured` row must reference the verification that earned it.",
  },
  derived_requires_inputs: {
    invariant: 4,
    http: 422,
    says: "A `derived` row must carry the assertions it was computed from.",
  },
  target_requires_machine_checkable_gate: {
    invariant: 5,
    http: 422,
    says: "A target needs object.op, object.value and object.requires_confidence, or no machine can ever check it.",
  },
  gates_must_be_machine_checkable: {
    invariant: 5,
    http: 422,
    says: "Every gate needs subject, predicate, op, target and requires_confidence.",
  },
  active_mission_requires_gate: {
    invariant: 5,
    http: 422,
    says: "An active mission with no gate is a goal nobody can check. Add at least one.",
  },
  failed_requires_reopen_if: {
    invariant: null,
    http: 422,
    says: "kind=failed must carry reopen_if: the falsifier that would justify trying again.",
  },
  failure_requires_why: {
    invariant: null,
    http: 422,
    says: "kind=failed and kind=dead must carry `why`.",
  },
  supersedes_target_not_found: {
    invariant: null,
    http: 404,
    says: "The assertion being superseded does not exist.",
  },
  supersedes_target_already_superseded: {
    invariant: null,
    http: 409,
    says: "That assertion has already been superseded. A chain has one live head; supersede that.",
  },
  mission_supersedes_target_not_found: {
    invariant: null,
    http: 404,
    says: "The mission being superseded does not exist.",
  },
  mission_supersedes_target_already_superseded: {
    invariant: null,
    http: 409,
    says: "That mission version has already been superseded.",
  },
  no_self_supersede: { invariant: null, http: 422, says: "An assertion cannot supersede itself." },
  id_shape: { invariant: null, http: 422, says: "id must be a ULID prefixed with a_." },
  hash_shape: { invariant: null, http: 422, says: "hash must be sha256:<64 lowercase hex>." },
  scope_shape: {
    invariant: null,
    http: 422,
    says: "scope must be slash-separated labels of [A-Za-z0-9_.-].",
  },
  mission_scope_shape: { invariant: null, http: 422, says: "mission scope is malformed." },
  subject_present: { invariant: null, http: 422, says: "subject is required." },
  predicate_present: { invariant: null, http: 422, says: "predicate is required." },
  kind_known: {
    invariant: null,
    http: 422,
    says: "kind must be one of measured|target|rule|constraint|state|untried|failed|dead.",
  },
  confidence_known: {
    invariant: null,
    http: 422,
    says: "confidence must be one of measured|confirmed-by-human|derived|unverified.",
  },
  valid_period_ordered: { invariant: null, http: 422, says: "valid_to must be after valid_from." },
  mission_state_known: {
    invariant: null,
    http: 422,
    says: "mission state must be proposed|active|blocked|closed.",
  },
  mission_statement_present: { invariant: null, http: 422, says: "mission statement is required." },
  superseded_at_with_by: {
    invariant: 2,
    http: 409,
    says: "superseded_by and superseded_at are set together, by the database, or not at all.",
  },
  insufficient_privilege: {
    invariant: 2,
    http: 403,
    says: "The runtime role holds SELECT and INSERT only. UPDATE and DELETE are revoked, so the write died at the privilege check.",
  },
  unauthorized: { invariant: null, http: 401, says: "Present a valid Bearer key." },
  forbidden: { invariant: null, http: 403, says: "This key lacks the permission or the scope." },
  malformed_request: { invariant: null, http: 400, says: "The request body did not parse." },
  not_found: { invariant: null, http: 404, says: "No such object." },
  internal: { invariant: null, http: 500, says: "Unexpected server error." },
};

export function isReason(v: string): v is Reason {
  return Object.hasOwn(REASONS, v);
}
