import { describe, expect, it } from "vitest";
import { validate } from "../../src/api/index.js";
import {
  diagnosticKeys,
  EMPTY_LOOP_GUARD,
  foldFixTurns,
  recordFixTurn,
  resetLoopGuard,
  STUCK_THRESHOLD,
} from "../../web/src/agent/loop-guard.js";

// ---------------------------------------------------------------------------
// The three-strikes STOP CONDITION (M-T8.19 slice 5).
//
// The rule the card claims is exact — three CONSECUTIVE fix turns leaving the
// SAME code on the SAME node — so these tests pin each half of it: the streak
// that trips, and every way a streak is supposed to break (the problem clears,
// it moves node, it moves code, or a clean turn intervenes).
// ---------------------------------------------------------------------------

const A = { code: "loom.unknown-type", node: "aggregate Sales.Order.total" };
const B = { code: "loom.unknown-type", node: "aggregate Sales.Invoice.amount" };
const C = { code: "loom.bare-aggregate-in-type", node: "aggregate Sales.Order.total" };

describe("recordFixTurn", () => {
  it("does not trip before the third consecutive turn", () => {
    let s = recordFixTurn(EMPTY_LOOP_GUARD, [A]);
    expect(s.stuck).toBeNull();
    s = recordFixTurn(s, [A]);
    expect(s.stuck).toBeNull();
    s = recordFixTurn(s, [A]);
    expect(s.stuck).toEqual({ ...A, turns: 3 });
  });

  it("names the same code and node the diagnostic carried", () => {
    const s = foldFixTurns([
      { fix: true, remaining: [A] },
      { fix: true, remaining: [A] },
      { fix: true, remaining: [A] },
    ]);
    expect(s.stuck?.code).toBe(A.code);
    expect(s.stuck?.node).toBe(A.node);
    expect(s.stuck?.turns).toBe(STUCK_THRESHOLD);
  });

  it("resets when the problem is fixed", () => {
    let s = recordFixTurn(EMPTY_LOOP_GUARD, [A]);
    s = recordFixTurn(s, [A]);
    s = recordFixTurn(s, []); // fixed
    expect(s.streaks).toEqual({});
    s = recordFixTurn(s, [A]); // and it came back — that is strike ONE
    expect(s.stuck).toBeNull();
    expect(Object.values(s.streaks)).toEqual([1]);
  });

  it("does not trip when the SAME code moves to a different node", () => {
    const s = foldFixTurns([
      { fix: true, remaining: [A] },
      { fix: true, remaining: [B] },
      { fix: true, remaining: [A] },
    ]);
    expect(s.stuck).toBeNull();
  });

  it("does not trip when a DIFFERENT code lands on the same node", () => {
    const s = foldFixTurns([
      { fix: true, remaining: [A] },
      { fix: true, remaining: [C] },
      { fix: true, remaining: [A] },
    ]);
    expect(s.stuck).toBeNull();
  });

  it("counts only CONSECUTIVE fix turns — a clean turn breaks the run", () => {
    const s = foldFixTurns([
      { fix: true, remaining: [A] },
      { fix: true, remaining: [A] },
      { fix: false, remaining: [] }, // the model was clean when this turn began
      { fix: true, remaining: [A] },
    ]);
    expect(s.stuck).toBeNull();
    expect(Object.values(s.streaks)).toEqual([1]);
  });

  it("tracks several problems independently and reports the first to trip", () => {
    const s = foldFixTurns([
      { fix: true, remaining: [A, B] },
      { fix: true, remaining: [A, B] },
      { fix: true, remaining: [A, B] },
    ]);
    expect(s.stuck?.node).toBe(A.node);
  });

  it("honours a raised threshold", () => {
    const turns = [
      { fix: true, remaining: [A] },
      { fix: true, remaining: [A] },
      { fix: true, remaining: [A] },
    ];
    expect(foldFixTurns(turns, 4).stuck).toBeNull();
    expect(foldFixTurns([...turns, { fix: true, remaining: [A] }], 4).stuck).toEqual({
      ...A,
      turns: 4,
    });
  });

  it("resetLoopGuard clears everything", () => {
    const s = recordFixTurn(EMPTY_LOOP_GUARD, [A]);
    expect(resetLoopGuard()).toEqual(EMPTY_LOOP_GUARD);
    expect(s).not.toEqual(EMPTY_LOOP_GUARD);
  });
});

describe("diagnosticKeys", () => {
  it("keeps errors with both a code and a node, de-duplicated", () => {
    expect(
      diagnosticKeys([
        { code: "x", node: "n", severity: "error" },
        { code: "x", node: "n", severity: "error" },
        { code: "y", node: "n", severity: "error" },
      ]),
    ).toEqual([
      { code: "x", node: "n" },
      { code: "y", node: "n" },
    ]);
  });

  it("drops warnings and anything with no stable identity", () => {
    expect(
      diagnosticKeys([
        { code: "w", node: "n", severity: "warning" },
        { code: "x", severity: "error" },
        { node: "n", severity: "error" },
      ]),
    ).toEqual([]);
  });

  it("reads a REAL validator report — the oracle the guard counts", async () => {
    const broken = `context Sales {
  aggregate Order {
    total: NotAType
  }
}
`;
    const report = await validate(broken);
    const keys = diagnosticKeys(report.diagnostics);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0]!.code).toMatch(/^loom\./);
    expect(keys[0]!.node).toBeTruthy();

    // Three turns that leave the same report → stuck, on that exact key.
    const s = foldFixTurns([
      { fix: true, remaining: keys },
      { fix: true, remaining: keys },
      { fix: true, remaining: keys },
    ]);
    expect(s.stuck).toEqual({ ...keys[0]!, turns: 3 });
  });
});
