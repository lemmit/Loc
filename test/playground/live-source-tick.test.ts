import { describe, expect, it } from "vitest";
import { LIVE_SYNC_DEBOUNCE_MS, reseedDecision } from "../../web/src/builder/live-source-tick.js";

// The builder panes used to re-derive (main-thread Langium parse + graph build
// + React Flow reflow) on the `ctx` object identity, so every unrelated app
// tick paid for a full rebuild.  They key off a debounced source tick instead;
// this is the pure half of that rule — the timer itself is deliberately not
// unit-tested (a timing assertion here would just be flaky).

describe("live source tick — reseed decision", () => {
  it("treats the first observed tick as a baseline, not a change", () => {
    // A pane mounting mid-session sees whatever tick the editor is already on.
    // Re-deriving on it would clobber a selection / in-flight inline edit the
    // user started during the debounce window right after switching panes.
    expect(reseedDecision(null, 0)).toBe("baseline");
    expect(reseedDecision(null, 41)).toBe("baseline");
  });

  it("schedules a re-derive only for ticks that advance past the baseline", () => {
    expect(reseedDecision(7, 8)).toBe("schedule");
    expect(reseedDecision(0, 1)).toBe("schedule");
  });

  it("ignores a tick that repeats (or predates) the baseline", () => {
    // An unrelated app re-render re-runs the effect with the SAME tick — that
    // is exactly the churn this gate exists to swallow.
    expect(reseedDecision(7, 7)).toBe("ignore");
    expect(reseedDecision(7, 6)).toBe("ignore");
  });

  it("debounces at or above the 300 ms floor the live-sync contract sets", () => {
    expect(LIVE_SYNC_DEBOUNCE_MS).toBeGreaterThanOrEqual(300);
  });
});
