export const KINDS = [
  "measured",
  "target",
  "rule",
  "constraint",
  "state",
  "untried",
  "failed",
  "dead",
] as const;
export type Kind = (typeof KINDS)[number];

export const CONFIDENCE_CLASSES = [
  "measured",
  "confirmed-by-human",
  "derived",
  "unverified",
] as const;
export type Confidence = (typeof CONFIDENCE_CLASSES)[number];

/** What an agent is permitted to write directly. `measured` and `derived` are earned. */
export const ASSERTABLE_CONFIDENCE: Record<string, true> = {
  unverified: true,
  "confirmed-by-human": true,
};

export interface Evidence {
  /** Required. Where this claim came from — a file:line, a session, a person, a run id. */
  source: string;
  repo?: string;
  commit?: string;
  contained_in?: string[];
  instrument?: string;
  protocol?: string;
  artifacts?: string[];
  /** Required when confidence is `confirmed-by-human`: the named human. */
  human?: string;
  [k: string]: unknown;
}

export interface AssertionRow {
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
  /** Present on reads: this row is one side of an open contradiction. */
  contested?: boolean;
  /** Present on reads: a derived row whose inputs are no longer resolvable in this chain. */
  inputs_unresolvable?: boolean;
}

export interface AssertInput {
  scope: string;
  subject: string;
  predicate: string;
  object: Record<string, unknown>;
  kind: Kind;
  evidence: Evidence;
  claim?: string | null;
  binding?: boolean;
  confidence?: Confidence;
  valid_from?: string;
  valid_to?: string | null;
  asserted_by: string;
  supersedes?: string | null;
  why?: string | null;
  reopen_if?: string | null;
  causality?: string | null;
  derived_from?: string[];
  verification_id?: string | null;
}

export interface Gate {
  subject: string;
  predicate: string;
  op: ">=" | "<=" | ">" | "<" | "=" | "!=";
  target: number | string | boolean;
  requires_confidence: Confidence;
  note?: string;
}

export interface GateStatus extends Gate {
  reached: boolean | null;
  actual: unknown;
  unit?: string | null;
  evidence: string | null;
  resolved_scope?: string | null;
  confidence?: string | null;
  why_null?: string;
}

export interface MissionRow {
  id: string;
  scope: string;
  statement: string;
  state: "proposed" | "active" | "blocked" | "closed";
  gates: Gate[];
  version: number;
  supersedes: string | null;
  superseded_by: string | null;
  asserted_at: string;
  asserted_by: string;
  created_at: string;
}
