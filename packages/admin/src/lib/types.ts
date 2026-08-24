/**
 * Mirrors of the server contract. These are the shapes `/admin/api/*` returns;
 * nothing here is invented. Kept in one file so a contract change is a
 * one-file diff.
 */

export type Confidence =
  | "measured"
  | "confirmed-by-human"
  | "derived"
  | "unverified";

export const CONFIDENCE_CLASSES: readonly Confidence[] = [
  "measured",
  "confirmed-by-human",
  "derived",
  "unverified",
];

export type Kind =
  | "measured"
  | "target"
  | "rule"
  | "constraint"
  | "state"
  | "untried"
  | "failed"
  | "dead";

export const KINDS: readonly Kind[] = [
  "measured",
  "target",
  "rule",
  "constraint",
  "state",
  "untried",
  "failed",
  "dead",
];

export interface Evidence {
  source: string;
  repo?: string;
  commit?: string;
  contained_in?: string[];
  instrument?: string;
  protocol?: string;
  artifacts?: string[];
  human?: string;
  [k: string]: unknown;
}

export interface Assertion {
  id: string;
  hash: string;
  scope: string;
  scope_depth: number;
  subject: string;
  predicate: string;
  object: Record<string, unknown>;
  claim: string | null;
  kind: Kind;
  binding: boolean;
  confidence: Confidence;
  evidence: Evidence;
  valid_from: string;
  valid_to: string | null;
  /**
   * A SEQUENCE number rendered as a string. NEVER format this as a date — the
   * as-of control is sequence-based and `created_at` is the row's only wall
   * clock.
   */
  asserted_at: string;
  asserted_by: string;
  supersedes: string | null;
  superseded_by: string | null;
  superseded_at: string | null;
  why: string | null;
  reopen_if: string | null;
  causality: string | null;
  derived_from: string[];
  verification_id: string | null;
  created_at: string;
  /** One side of an open contradiction. */
  contested?: boolean;
  /** A derived row whose inputs left the resolution chain. */
  inputs_unresolvable?: boolean;
}

export type GateOp = ">=" | "<=" | ">" | "<" | "=" | "!=";

export interface GateStatus {
  subject: string;
  predicate: string;
  op: GateOp;
  target: number | string | boolean;
  requires_confidence: Confidence;
  note?: string;
  /** `null` means no evidence of the required class exists. Never render as false. */
  reached: boolean | null;
  actual: unknown;
  unit?: string | null;
  evidence: string | null;
  resolved_scope?: string | null;
  confidence?: string | null;
  why_null?: string;
}

export type ContradictionStatus =
  | "open"
  | "resolved"
  | "superseded"
  | "unreproducible";

export interface Contradiction {
  id: string;
  scope: string;
  subject: string;
  predicate: string;
  a_id: string;
  b_id: string;
  a_confidence: Confidence;
  b_confidence: Confidence;
  status: ContradictionStatus;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  detected_at: string;
}

export interface ContradictionWithSides extends Contradiction {
  a: Assertion;
  b: Assertion;
}

export type Permission = "read" | "assert" | "supersede" | "admin";

export const PERMISSIONS: readonly Permission[] = [
  "read",
  "assert",
  "supersede",
  "admin",
];

export interface ApiKey {
  id: string;
  prefix: string;
  label: string;
  scope: string;
  permissions: string[];
  expires_at: string | null;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  revoked_at: string | null;
}

export interface ScopeNode {
  path: string;
  kind: string;
  depth: number;
  assertions: number;
}

export type MissionState = "proposed" | "active" | "blocked" | "closed";

export interface Mission {
  id: string;
  scope: string;
  statement: string;
  state: MissionState;
  gates: GateStatus[];
  version: number;
  asserted_by: string;
  created_at: string;
}

export interface Rejection {
  id: string;
  at: string;
  actor: string | null;
  route: string | null;
  reason: string;
  sqlstate: string | null;
  message: string | null;
  detail: Record<string, unknown> | null;
  scope: string | null;
  subject: string | null;
  predicate: string | null;
}

export interface RegistryNode {
  id: string;
  kind: string;
  scope: string;
  label: string | null;
  role: string | null;
  meta: Record<string, unknown> | null;
  heartbeat_at: string | null;
  last_seen: string | null;
  created_at: string;
}

/**
 * Instance-level verification capability. When `configured` is false nothing on
 * this instance can ever be promoted to `measured`, so an `unverified` row is
 * not "pending" — it is terminal until an operator wires a checker up. The
 * provenance popover says so rather than implying a queue exists.
 */
export interface VerificationCapability {
  configured: boolean;
  method: "local-mirror" | "github-api" | "none";
}

export interface Me {
  authenticated: true;
  org: string;
  scope_root: string;
  postgres: string;
  sequence: number;
  verification: VerificationCapability;
}

export type VerificationOutcome = "confirmed" | "refuted" | "unresolvable";

export interface VerificationRecord {
  id: string;
  outcome: VerificationOutcome;
  checker: string;
  checked_at: string;
  detail: Record<string, unknown> | null;
}

export interface TakeResult {
  scope: string;
  mode: "global" | "isolated";
  chain: string[];
  as_of: number | null;
  assertions: Assertion[];
}

export interface AssertionDetail {
  assertion: Assertion;
  lineage: Assertion[];
  contradictions: Contradiction[];
  verification: VerificationRecord | null;
}
