import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET_BYTES, pack } from "../src/http/compact.js";

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
