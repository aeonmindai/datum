import { describe, expect, it } from "vitest";
import {
  compactGate,
  compactState,
  DEFAULT_BUDGET_BYTES,
  pack,
  type GateStatus,
  type StateSummary,
} from "../src/http/compact.js";

/**
 * The MCP facade's byte budget is a contract, not an aspiration.
 *
 * Every MCP response is injected into an agent session, so overshooting the one number a caller
 * asked us to respect is a permanent context tax on everything that connects. The single
 * exception is a contested pair, which is never truncated to one side — returning half a
 * disagreement is the silent last-write-wins behaviour the whole system exists to refuse.
 */

const line = (n: number, len = 60): string => `f${n}.`.padEnd(len, "x");
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

describe("pack — the byte budget is a real ceiling", () => {
  it("never exceeds the budget, note included", () => {
    for (const budget of [80, 120, 200, DEFAULT_BUDGET_BYTES, 400, 1000]) {
      const out = pack(
        Array.from({ length: 40 }, (_, i) => line(i)),
        budget,
      );
      expect(bytes(out), `budget ${budget} produced ${bytes(out)} bytes:\n${out}`).toBeLessThanOrEqual(
        budget,
      );
    }
  });

  it("still says how many it left out, and the count is right", () => {
    const lines = Array.from({ length: 40 }, (_, i) => line(i));
    const out = pack(lines, 200);
    const kept = out.split("\n").filter((l) => !l.startsWith("+"));
    const note = out.split("\n").find((l) => l.startsWith("+"));
    expect(note).toBeTruthy();
    expect(note).toContain(`+${lines.length - kept.length} more`);
    // Every kept line is intact: truncating a fact mid-provenance would be worse than dropping it.
    for (const k of kept) expect(lines).toContain(k);
  });

  it("emits at least one fact even when a single line blows the whole budget", () => {
    const out = pack([line(0, 400)], 80);
    // A response of "nothing fit" would be useless. One fact plus an honest count is not.
    expect(out.split("\n")[0]).toBe(line(0, 400));
  });

  it("never drops a mandatory line, and says so by exceeding the budget rather than lying", () => {
    const contested = [line(1, 150), line(2, 150)];
    const out = pack([line(3), line(4)], 100, "empty", contested);
    for (const c of contested) expect(out).toContain(c);
    // The budget loses to correctness here, deliberately and visibly.
    expect(bytes(out)).toBeGreaterThan(100);
    // And the optional tail is still accounted for rather than silently discarded.
    expect(out).toContain("+2 more");
  });

  it("returns the empty message only when there is genuinely nothing", () => {
    expect(pack([], 200, "nothing on datum")).toBe("nothing on datum");
    expect(pack([], 200, "nothing on datum", [line(1)])).toContain(line(1));
  });
});

describe("compactState — a decision only a human can close is never dropped", () => {
  const gate = (over: Partial<GateStatus>): GateStatus =>
    ({
      subject: "s",
      predicate: "p",
      op: ">=",
      target: 1,
      requires_confidence: "measured",
      reached: false,
      actual: 0,
      ...over,
    }) as GateStatus;

  const state = (missions: StateSummary["missions"]): StateSummary => ({
    scope: "org/acme/proj/x",
    mode: "global",
    sequence: 1,
    live: 1,
    byConfidence: { measured: 1 },
    contested: 0,
    missions,
    bindingRules: 0,
  });

  it("surfaces every human-gated blocker even when the budget cannot hold one mission", () => {
    // Eight missions of prose cannot fit 200 bytes, and before this the packer dropped all of
    // them - so an operator asking "what is waiting on me" got counts and a truncation note.
    const missions = Array.from({ length: 8 }, (_, i) => ({
      statement: `mission number ${i} with a deliberately long statement`.padEnd(90, "."),
      state: "blocked",
      gates: [gate({ subject: `d${i}`, predicate: "approved", requires_confidence: "confirmed-by-human", reached: null, actual: null })],
    }));
    const out = compactState(state(missions), 200);
    for (let i = 0; i < 8; i++) expect(out, out).toContain(`d${i}.approved`);
    expect(out).toContain("awaiting-you=8");
  });

  it("says nothing about blockers when every human gate is closed", () => {
    const out = compactState(
      state([
        {
          statement: "done thing",
          state: "closed",
          gates: [gate({ requires_confidence: "confirmed-by-human", reached: true, actual: 1 })],
        },
      ]),
      200,
    );
    expect(out).not.toContain("awaiting-you");
  });

  it("counts a human gate that is open on the evidence, not only one with no evidence", () => {
    // A person can assert a value that fails the comparison. That is still their gate.
    const out = compactState(
      state([
        {
          statement: "open on evidence",
          state: "blocked",
          gates: [gate({ subject: "bucket", predicate: "chosen", requires_confidence: "confirmed-by-human", reached: false, actual: 0 })],
        },
      ]),
      200,
    );
    expect(out).toContain("awaiting-you=1");
    expect(out).toContain("bucket.chosen");
  });

  it("names the human requirement on the gate line, so OPEN is not mistaken for actionable", () => {
    expect(compactGate(gate({ requires_confidence: "confirmed-by-human" }))).toContain(
      "OPEN(needs-human)",
    );
    expect(compactGate(gate({ requires_confidence: "measured" }))).toMatch(/ OPEN$/);
    // No evidence at all already names the class it is waiting for.
    expect(
      compactGate(gate({ requires_confidence: "confirmed-by-human", reached: null, actual: null })),
    ).toContain("NO-EVIDENCE(confirmed-by-human)");
  });
});
