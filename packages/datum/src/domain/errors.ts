import { REASONS, isReason, type Reason } from "./reasons.js";

/**
 * A refused write, carrying the reason the database gave.
 *
 * The point of this class is that nothing invents an explanation. `reason` is the constraint
 * or trigger name Postgres reported; `sqlstate` is its class. If the store refuses a write,
 * the caller learns exactly which rule bit and what to do instead.
 */
export class Rejection extends Error {
  override readonly name = "Rejection";
  readonly reason: Reason;
  readonly sqlstate: string | null;
  readonly detail: Record<string, unknown>;
  readonly hint: string | null;
  readonly http: number;

  constructor(args: {
    reason: Reason;
    message?: string;
    sqlstate?: string | null;
    detail?: Record<string, unknown>;
    hint?: string | null;
  }) {
    const spec = REASONS[args.reason];
    super(args.message ?? spec.says);
    this.reason = args.reason;
    this.sqlstate = args.sqlstate ?? null;
    this.detail = args.detail ?? {};
    this.hint = args.hint ?? null;
    this.http = spec.http;
  }

  toBody(): Record<string, unknown> {
    const spec = REASONS[this.reason];
    return {
      ok: false,
      reason: this.reason,
      invariant: spec.invariant,
      message: this.message,
      says: spec.says,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(Object.keys(this.detail).length > 0 ? { detail: this.detail } : {}),
      ...(this.sqlstate ? { sqlstate: this.sqlstate } : {}),
    };
  }
}

interface PgErrorish {
  code?: string;
  constraint?: string;
  detail?: string;
  hint?: string;
  message?: string;
  table?: string;
}

/** SQLSTATEs that mean "an invariant refused this", as opposed to "the server is broken". */
const REFUSAL_CODES: Record<string, true> = {
  "23514": true, // check_violation, and every explicit RAISE ... USING CONSTRAINT
  "23P01": true, // exclusion_violation — invariant 3
  "23502": true, // not_null_violation
  "23503": true, // foreign_key_violation
};

export function asRejection(err: unknown): Rejection | null {
  if (err instanceof Rejection) return err;
  const e = err as PgErrorish | null;
  if (!e || typeof e !== "object" || typeof e.code !== "string") return null;

  // Every refusal Datum raises itself puts a JSON object in DETAIL, and that is what a caller
  // should get. Postgres's own DETAIL for a CHECK violation is `Failing row contains (...)`:
  // several hundred bytes echoing the whole tuple, including generated columns and the internal
  // column order. It tells the caller nothing the named reason does not, so it is dropped
  // rather than forwarded — an API answer should be readable, and a wire format that leaks
  // table layout is a wire format nobody can change later.
  let detail: Record<string, unknown> = {};
  if (typeof e.detail === "string" && e.detail.startsWith("{")) {
    try {
      detail = JSON.parse(e.detail) as Record<string, unknown>;
    } catch {
      detail = {};
    }
  }

  // Invariant 2 is enforced twice. This is the first layer: the runtime role was never
  // granted UPDATE or DELETE, so the attempt dies at the privilege check before any trigger
  // runs. Reporting it as its own reason rather than folding it into the trigger's reason is
  // deliberate — the two layers are separately verifiable, and both must hold.
  if (e.code === "42501") {
    return new Rejection({
      reason: "insufficient_privilege",
      message: e.message ?? "permission denied",
      sqlstate: e.code,
      detail: { ...detail, table: e.table ?? null },
      hint: "The runtime role holds SELECT and INSERT only. Corrections are new rows.",
    });
  }

  if (!Object.hasOwn(REFUSAL_CODES, e.code)) return null;

  const named = e.constraint && isReason(e.constraint) ? e.constraint : null;
  if (!named) {
    return new Rejection({
      reason: "malformed_request",
      message: e.message ?? "constraint violation",
      sqlstate: e.code,
      detail: { ...detail, constraint: e.constraint ?? null },
    });
  }

  return new Rejection({
    reason: named,
    message: e.message ?? REASONS[named].says,
    sqlstate: e.code,
    detail,
    hint: e.hint ?? null,
  });
}

/** True when two writers raced to insert the identical content-addressed row. */
export function isDuplicateHash(err: unknown): boolean {
  const e = err as PgErrorish | null;
  return !!e && typeof e === "object" && e.code === "23505";
}
