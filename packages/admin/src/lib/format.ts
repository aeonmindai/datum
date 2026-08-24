/** Presentation helpers. No formatting decision is duplicated in a screen. */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const SEVEN_DAYS = 7 * DAY;

/**
 * "4m ago" for the past, "in 4mo" for the future. Expiry dates are routinely in
 * the future, so a past-only formatter would render every live key's expiry as
 * a useless placeholder. Returns null for a null or unparseable input.
 */
export function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const delta = Date.now() - then;
  const magnitude = Math.abs(delta);
  if (magnitude < 45_000) return "just now";
  const span =
    magnitude < HOUR
      ? `${Math.round(magnitude / MIN)}m`
      : magnitude < DAY
        ? `${Math.round(magnitude / HOUR)}h`
        : magnitude < 30 * DAY
          ? `${Math.round(magnitude / DAY)}d`
          : `${Math.round(magnitude / (30 * DAY))}mo`;
  return delta >= 0 ? `${span} ago` : `in ${span}`;
}

export function ageMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Date.now() - then;
}

/** Wall-clock stamp. Only ever applied to `created_at` / `at` / `checked_at`. */
export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Short id for tables. Full id stays in the title attribute. */
export function shortId(id: string, chars = 8): string {
  return id.length <= chars ? id : id.slice(0, chars);
}

/** Commits render at 9 characters, the git default abbreviation. */
export function shortCommit(commit: string | undefined | null): string | null {
  if (!commit) return null;
  return commit.slice(0, 9);
}

/**
 * The value an assertion is actually about. Datum objects are free-form JSON,
 * so prefer the conventional keys and fall back to compact JSON.
 */
export function objectValue(object: Record<string, unknown> | null | undefined): {
  value: string;
  unit: string | null;
  raw: unknown;
} {
  if (!object || typeof object !== "object") {
    return { value: "—", unit: null, raw: object };
  }
  const unit = typeof object.unit === "string" ? object.unit : null;
  for (const key of ["value", "n", "amount", "count", "state", "text"]) {
    if (key in object) {
      const v = object[key];
      return { value: scalar(v), unit, raw: v };
    }
  }
  const keys = Object.keys(object).filter((k) => k !== "unit");
  if (keys.length === 1) {
    const only = keys[0] as string;
    return { value: scalar(object[only]), unit, raw: object[only] };
  }
  return { value: compactJson(object), unit, raw: object };
}

function scalar(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "—";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  return compactJson(v);
}

export function compactJson(v: unknown, max = 80): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? "—";
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? "null";
  } catch {
    return String(v);
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Renders an unknown gate `actual` without pretending null is false. */
export function gateActual(actual: unknown): string {
  if (actual === null || actual === undefined) return "no value";
  return scalar(actual);
}

/**
 * A verification promotion is a supersession by the verification worker, not a
 * correction by an agent. The two mean different things and the timeline must
 * not conflate them.
 */
export function isVerificationActor(assertedBy: string): boolean {
  return /^worker:verification(@|$)/.test(assertedBy);
}
