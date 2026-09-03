import { describe, expect, it } from "vitest";
import { applyPatches, outline } from "../../src/api/index.js";
import {
  buildPlan,
  diffOutlines,
  exclusionPatches,
  isStructural,
  planIsEmpty,
  planSummary,
  splitAddress,
} from "../../web/src/agent/plan.js";

// ---------------------------------------------------------------------------
// The agent's PLAN step (M-T8.19 slice 2) — outline → outline → plan shape.
//
// The point of the whole slice is that Loom's plan is not prose the model
// invented: it is a MODEL-NODE DELTA over the real `loom_outline` address book,
// so every line is a patch target the compiler can act on.  These tests drive
// the pure diff with REAL outlines produced by `src/api`'s `outline()` — no
// model, no React — and then prove the exclusion patches actually apply
// through the shipped `applyPatches`.
// ---------------------------------------------------------------------------

const BASE = `context Sales {
  aggregate Order {
    total: int
  }
}
`;

// One added aggregate (structural), one added member on an existing one.
const CANDIDATE = `context Sales {
  aggregate Order {
    total: int
    placedAt: timestamp
  }

  aggregate Invoice {
    amount: int
  }
}
`;

describe("splitAddress", () => {
  it("splits a canonical address into keyword + dotted name", () => {
    expect(splitAddress("aggregate Sales.Order")).toEqual({
      kind: "aggregate",
      name: "Sales.Order",
    });
  });

  it("degrades rather than throwing on an address with no keyword", () => {
    expect(splitAddress("Sales.Order")).toEqual({ kind: "", name: "Sales.Order" });
  });
});

describe("diffOutlines over real outlines", () => {
  it("reports an added declaration, a changed one, and nothing else", async () => {
    const items = diffOutlines(await outline(BASE), await outline(CANDIDATE));

    // Additions sort first, then changes.
    expect(items.map((i) => `${i.change} ${i.node}`)).toEqual([
      "add aggregate Sales.Invoice",
      "change aggregate Sales.Order",
    ]);

    const added = items[0]!;
    expect(added.kind).toBe("aggregate");
    expect(added.name).toBe("Sales.Invoice");
    expect(added.addedMembers).toContain("aggregate Sales.Invoice.amount");
    expect(added.excludable).toBe(true);

    const changed = items[1]!;
    expect(changed.addedMembers).toEqual(["aggregate Sales.Order.placedAt"]);
    expect(changed.removedMembers).toEqual([]);
    expect(changed.excludable).toBe(true);
  });

  it("is empty when the model is unchanged — reformatting is not a plan line", async () => {
    const reformatted = BASE.replace("aggregate Order {", "aggregate Order   {");
    const items = diffOutlines(await outline(BASE), await outline(reformatted));
    expect(items).toEqual([]);
    expect(
      planIsEmpty(
        buildPlan({
          before: await outline(BASE),
          after: await outline(reformatted),
          base: BASE,
          candidate: reformatted,
          turn: 0,
        }),
      ),
    ).toBe(true);
  });

  it("reports a removal, and marks it not individually excludable", async () => {
    const items = diffOutlines(await outline(CANDIDATE), await outline(BASE));
    const removed = items.find((i) => i.change === "remove");
    expect(removed?.node).toBe("aggregate Sales.Invoice");
    expect(removed?.excludable).toBe(false);
    // The member that went with it is reported as dropped, not as its own line.
    expect(removed?.removedMembers).toContain("aggregate Sales.Invoice.amount");
  });

  it("classifies add/remove turns as structural and member-only turns as not", async () => {
    const structural = diffOutlines(await outline(BASE), await outline(CANDIDATE));
    expect(isStructural(structural)).toBe(true);

    const memberOnly = CANDIDATE.replace(
      /\n\n {2}aggregate Invoice \{\n {4}amount: int\n {2}\}/,
      "",
    );
    const items = diffOutlines(await outline(BASE), await outline(memberOnly));
    expect(items.map((i) => i.change)).toEqual(["change"]);
    expect(isStructural(items)).toBe(false);
  });

  it("summarises the delta for the collapsed card", async () => {
    const items = diffOutlines(await outline(BASE), await outline(CANDIDATE));
    expect(planSummary(items)).toBe("1 added · 1 changed");
    expect(planSummary([])).toBe("");
  });
});

describe("exclusionPatches", () => {
  it("removes an excluded ADDED declaration from the candidate, for real", async () => {
    const plan = buildPlan({
      before: await outline(BASE),
      after: await outline(CANDIDATE),
      base: BASE,
      candidate: CANDIDATE,
      turn: 0,
    });

    const patches = exclusionPatches(plan.items, ["aggregate Sales.Invoice"]);
    expect(patches).toEqual([{ op: "remove", target: "aggregate Sales.Invoice" }]);

    const applied = await applyPatches(CANDIDATE, patches);
    expect(applied.ok).toBe(true);
    expect(applied.text).not.toContain("Invoice");
    // The rest of the plan still landed.
    expect(applied.text).toContain("placedAt: timestamp");
  });

  it("removes only the members an excluded CHANGE introduced", async () => {
    const plan = buildPlan({
      before: await outline(BASE),
      after: await outline(CANDIDATE),
      base: BASE,
      candidate: CANDIDATE,
      turn: 0,
    });

    const patches = exclusionPatches(plan.items, ["aggregate Sales.Order"]);
    expect(patches).toEqual([{ op: "remove", target: "aggregate Sales.Order.placedAt" }]);

    const applied = await applyPatches(CANDIDATE, patches);
    expect(applied.ok).toBe(true);
    expect(applied.text).not.toContain("placedAt");
    expect(applied.text).toContain("aggregate Invoice");
    expect(applied.text).toContain("total: int");
  });

  it("never emits overlapping edits when a declaration and its member are both struck", async () => {
    const plan = buildPlan({
      before: await outline(BASE),
      after: await outline(CANDIDATE),
      base: BASE,
      candidate: CANDIDATE,
      turn: 0,
    });

    const patches = exclusionPatches(plan.items, [
      "aggregate Sales.Invoice",
      "aggregate Sales.Order",
    ]);
    // One decl removal + one member removal, no member of the removed decl.
    expect(patches).toEqual([
      { op: "remove", target: "aggregate Sales.Invoice" },
      { op: "remove", target: "aggregate Sales.Order.placedAt" },
    ]);
    const applied = await applyPatches(CANDIDATE, patches);
    expect(applied.ok).toBe(true);
    expect(applied.errors).toEqual([]);
    // Back to the base model (a removal leaves the blank line that separated
    // the two declarations — cosmetic, and not what this asserts).
    expect(applied.text.replace(/\n{2,}/g, "\n")).toBe(BASE.replace(/\n{2,}/g, "\n"));
  });

  it("ignores a struck line that cannot be honoured mechanically", async () => {
    const plan = buildPlan({
      before: await outline(CANDIDATE),
      after: await outline(BASE),
      base: CANDIDATE,
      candidate: BASE,
      turn: 0,
    });
    // The removal line is not excludable — striking it produces no patch, so
    // the UI's "Reject the whole plan" is the only honest way out.
    expect(exclusionPatches(plan.items, ["aggregate Sales.Invoice"])).toEqual([]);
  });

  it("is a no-op when nothing was struck", async () => {
    const plan = buildPlan({
      before: await outline(BASE),
      after: await outline(CANDIDATE),
      base: BASE,
      candidate: CANDIDATE,
      turn: 0,
    });
    expect(exclusionPatches(plan.items, [])).toEqual([]);
  });
});
