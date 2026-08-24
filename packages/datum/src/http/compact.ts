import type { AssertionRow, GateStatus } from "../domain/types.js";

/**
 * The MCP facade's wire format.
 *
 * Every MCP tool definition and every MCP response is injected into an agent session, so a
 * chatty MCP server is a permanent context tax on everything that connects to it. The budget
 * here is ~200 bytes per response, not 20 KB — which means each line has to be provenance-dense
 * rather than merely short. A bare number must never leave the system, so the confidence class
 * and the evidence are on the line even when the value is truncated away.
 */

export const DEFAULT_BUDGET_BYTES = 240;

const short = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** `org/aeonmind/proj/arc/mission/k9-rebake` -> `arc/mission/k9-rebake` */
function tailScope(scope: string): string {
  const parts = scope.split("/");
  return parts.length <= 3 ? scope : parts.slice(-3).join("/");
}

function provenance(a: AssertionRow): string {
  const e = a.evidence ?? { source: "?" };
  const commit = typeof e.commit === "string" ? e.commit.slice(0, 8) : null;
  const repo = typeof e.repo === "string" ? e.repo.split("/").pop() : null;
  const contained = Array.isArray(e.contained_in) && e.contained_in.length > 0
    ? String(e.contained_in[0])
    : null;
  if (commit) {
    return `${repo ?? "repo"}@${commit}${contained ? `~${short(contained, 20)}` : ""}`;
  }
  if (typeof e.human === "string") return `human:${e.human}`;
  if (typeof e.instrument === "string") return `via:${short(e.instrument, 14)}`;
  return `src:${short(String(e.source ?? "?"), 22)}`;
}

function value(a: AssertionRow): string {
  const v = a.object?.value;
  const unit = typeof a.object?.unit === "string" ? ` ${short(a.object.unit, 14)}` : "";
  if (v === undefined) return short(JSON.stringify(a.object ?? null), 30);
  if (typeof v === "object" && v !== null) return short(JSON.stringify(v), 30);
  return `${String(v)}${unit}`;
}

export function compactAssertion(a: AssertionRow): string {
  const flags: string[] = [];
  if (a.contested) flags.push("CONTESTED");
  if (a.inputs_unresolvable) flags.push("INPUTS-UNRESOLVABLE");
  if (a.superseded_by) flags.push("SUPERSEDED");
  if (a.kind === "dead") flags.push("DEAD");
  if (a.kind === "failed") flags.push("FAILED");
  if (a.binding) flags.push("BINDING");
  return (
    `${a.subject}.${a.predicate}=${value(a)}` +
    ` | ${a.confidence} | ${tailScope(a.scope)} | ${provenance(a)} | s${a.asserted_at}` +
    (flags.length > 0 ? ` | ${flags.join(",")}` : "")
  );
}
/**
 * Pack lines into a byte budget, then say plainly how many were left out. Silently dropping the
 * tail would make the facade lie by omission.
 *
 * `mandatory` lines are never dropped, whatever the budget says. That exists for exactly one
 * reason and it is not an optimisation: a contested pair must be returned in full. Returning one
 * side of a disagreement because the other did not fit is the silent last-write-wins behaviour
 * this whole system exists to refuse, and no byte budget outranks that.
 */
export function pack(
  lines: string[],
  budget = DEFAULT_BUDGET_BYTES,
  emptyMessage = "no facts on datum for this query",
  mandatory: string[] = [],
): string {
  if (lines.length === 0 && mandatory.length === 0) return emptyMessage;
  const out: string[] = [...mandatory];
  let used = mandatory.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
  for (const line of lines) {
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (out.length > 0 && used + cost > budget) break;
    out.push(line);
    used += cost;
  }
  const omitted = lines.length - (out.length - mandatory.length);
  if (omitted > 0) {
    out.push(`+${omitted} more — narrow by subject/predicate, or raise max_bytes`);
  }
  return out.join("\n");
}

export function compactGate(g: GateStatus): string {
  const state =
    g.reached === null ? `NO-EVIDENCE(${g.requires_confidence})` : g.reached ? "REACHED" : "OPEN";
  const actual = g.actual === null || g.actual === undefined ? "—" : String(g.actual);
  return `${g.subject}.${g.predicate} ${g.op}${String(g.target)} actual=${actual} ${state}`;
}

export interface StateSummary {
  scope: string;
  mode: string;
  sequence: number;
  live: number;
  byConfidence: Record<string, number>;
  contested: number;
  missions: Array<{ statement: string; state: string; gates: GateStatus[] }>;
  bindingRules: number;
}

export function compactState(s: StateSummary, budget = DEFAULT_BUDGET_BYTES): string {
  const lines: string[] = [];
  const conf = Object.entries(s.byConfidence)
    .map(([k, v]) => `${k[0]}${v}`)
    .join(" ");
  lines.push(
    `${s.scope} mode=${s.mode} s${s.sequence} | live=${s.live} (${conf}) | ` +
      `contested=${s.contested} | binding-rules=${s.bindingRules}`,
  );
  for (const m of s.missions) {
    const reached = m.gates.filter((g) => g.reached === true).length;
    const noEvidence = m.gates.filter((g) => g.reached === null).length;
    lines.push(
      `mission[${m.state}] ${short(m.statement, 60)} gates ${reached}/${m.gates.length} reached` +
        (noEvidence > 0 ? `, ${noEvidence} with no qualifying evidence` : ""),
    );
    for (const g of m.gates) lines.push(`  ${compactGate(g)}`);
  }
  return pack(lines, budget, `${s.scope}: nothing on datum yet`);
}
