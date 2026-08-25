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
  // A verified measurement that never landed on the default branch describes a branch, not the
  // product. Without this flag it reads identically to a shipped number, which is precisely how
  // "branch work quoted as shipped" survived three sessions on Arc — and how it got into this
  // project's own benchmark brief.
  if (a.evidence?.on_default_branch === false) flags.push("BRANCH-ONLY");
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
const overflowNote = (n: number): string =>
  `+${n} more — narrow by subject/predicate, or raise max_bytes`;

/**
 * Pack lines into a byte budget, then say plainly how many were left out. Silently dropping the
 * tail would make the facade lie by omission.
 *
 * The budget is a real ceiling on the whole response, note included. An earlier version appended
 * the "+N more" line after the fill loop had already spent the budget, so a caller asking for 240
 * bytes could receive 267 — a facade that exists to be cheap has no business overshooting the one
 * number it is asked to respect.
 *
 * `mandatory` lines are the sole exception and are never dropped, whatever the budget says. That
 * is not an optimisation: a contested pair must be returned in full. Returning one side of a
 * disagreement because the other did not fit is the silent last-write-wins behaviour this whole
 * system exists to refuse, and no byte budget outranks that.
 */
export function pack(
  lines: string[],
  budget = DEFAULT_BUDGET_BYTES,
  emptyMessage = "no facts on datum for this query",
  mandatory: string[] = [],
): string {
  if (lines.length === 0 && mandatory.length === 0) return emptyMessage;

  const cost = (s: string): number => Buffer.byteLength(s, "utf8") + 1;
  const kept: string[] = [];
  let used = mandatory.reduce((n, l) => n + cost(l), 0);

  for (const line of lines) {
    if ((kept.length > 0 || mandatory.length > 0) && used + cost(line) > budget) break;
    kept.push(line);
    used += cost(line);
  }

  // Make room for the note itself, so the ceiling holds. Recomputed each round because dropping
  // a line changes the count and therefore the note's own length.
  while (kept.length > 0 && lines.length > kept.length && used + cost(overflowNote(lines.length - kept.length)) > budget) {
    used -= cost(kept.pop()!);
  }

  const omitted = lines.length - kept.length;
  return [...mandatory, ...kept, ...(omitted > 0 ? [overflowNote(omitted)] : [])].join("\n");
}

export function compactGate(g: GateStatus): string {
  // `NO-EVIDENCE(confirmed-by-human)` already names who is missing. An OPEN one does not, and it
  // can happen: a human can assert a value that fails the comparison. Say so either way, because
  // an agent reading `OPEN` will otherwise try to close a gate only a person can close.
  const human = g.requires_confidence === "confirmed-by-human";
  const state =
    g.reached === null
      ? `NO-EVIDENCE(${g.requires_confidence})`
      : g.reached
        ? "REACHED"
        : human
          ? "OPEN(needs-human)"
          : "OPEN";
  const actual = g.actual === null || g.actual === undefined ? "—" : String(g.actual);
  return `${g.subject}.${g.predicate} ${g.op}${String(g.target)} actual=${actual} ${state}`;
}

export interface StatePreference {
  tier: string;
  statement: string;
  occasions: number;
  distinct_humans: number;
  binding?: boolean;
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
  preferences?: StatePreference[];
}

export function compactState(s: StateSummary, budget = DEFAULT_BUDGET_BYTES): string {
  const lines: string[] = [];
  const conf = Object.entries(s.byConfidence)
    .map(([k, v]) => `${k[0]}${v}`)
    .join(" ");
  const header =
    `${s.scope} mode=${s.mode} s${s.sequence} | live=${s.live} (${conf}) | ` +
    `contested=${s.contested} | binding-rules=${s.bindingRules}`;

  // A preference the org holds is mandatory, for the same reason a contested pair is: the whole
  // point of learning it was to stop the human repeating themselves, and a line dropped to save
  // bytes is a line that does not stop anything. An `org` preference has been independently
  // asked for by three or more people, so it outranks any byte budget.
  const mandatory: string[] = [header];
  const optional: string[] = [];
  for (const p of s.preferences ?? []) {
    const line =
      `prefers[${p.tier}] ${short(p.statement, 68)} ` +
      `(${p.distinct_humans} human${p.distinct_humans === 1 ? "" : "s"}, ${p.occasions}x)`;
    if (p.binding || p.tier === "org") mandatory.push(line);
    else optional.push(line);
  }

  // A gate that requires `confirmed-by-human` cannot be closed by any amount of agent work:
  // `evaluate_gate` only reads rows at the gate's exact confidence class. So an unreached one is
  // not a task, it is a decision someone is waiting on, and dropping it to save bytes means the
  // person holding it never finds out. Same rule as a contested pair: it is mandatory.
  //
  // The summary is one line rather than two per mission, because the budget is a real constraint
  // and the detail is a `missions` call away. What must never be lost is that blockers exist.
  const awaiting: string[] = [];
  for (const m of s.missions) {
    const reached = m.gates.filter((g) => g.reached === true).length;
    const noEvidence = m.gates.filter((g) => g.reached === null).length;
    optional.push(
      `mission[${m.state}] ${short(m.statement, 60)} gates ${reached}/${m.gates.length} reached` +
        (noEvidence > 0 ? `, ${noEvidence} with no qualifying evidence` : ""),
    );
    for (const g of m.gates) {
      optional.push(`  ${compactGate(g)}`);
      if (g.reached !== true && g.requires_confidence === "confirmed-by-human") {
        awaiting.push(`${g.subject}.${g.predicate}`);
      }
    }
  }
  if (awaiting.length > 0) {
    // Uncapped on purpose. Capping the list at some tidy number reintroduces exactly the bug
    // being fixed - the seventh decision becomes invisible - and an operator holding fifty
    // decisions is better served by a long line than by a count and another round trip.
    mandatory.push(`awaiting-you=${awaiting.length}: ${awaiting.join(", ")}`);
  }
  return pack(optional, budget, `${s.scope}: nothing on datum yet`, mandatory);
}
