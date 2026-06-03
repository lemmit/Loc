import { describe, expect, it } from "vitest";
import { applyPatches } from "../../src/language/model-patch.js";
import { parseString } from "../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Model-patch applier (docs/proposals/ai-authoring-loop.md §4).  Node-addressed
// edits over `.ddd` source: add/replace/remove, atomic batches, untouched bytes
// preserved, and the round-trip property (the patched output re-parses).
// ---------------------------------------------------------------------------

const MODEL = `context Sales {
  aggregate Order {
    total: int
    status: string
  }
}
`;

describe("applyPatches", () => {
  it("replace swaps a member and preserves every other byte", async () => {
    const r = await applyPatches(MODEL, [
      { op: "replace", target: "aggregate Sales.Order.status", source: "status: OrderStatus" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.text).toBe(MODEL.replace("status: string", "status: OrderStatus"));
    expect(r.applied).toEqual([{ op: "replace", target: "aggregate Sales.Order.status" }]);
  });

  it("remove deletes the member's line cleanly (no blank line left)", async () => {
    const r = await applyPatches(MODEL, [{ op: "remove", target: "aggregate Sales.Order.total" }]);
    expect(r.ok).toBe(true);
    expect(r.text).toBe(MODEL.replace("    total: int\n", ""));
  });

  it("add inserts a new aggregate before the context's closing brace, indented", async () => {
    const r = await applyPatches(MODEL, [
      { op: "add", target: "context Sales", source: "aggregate Wallet {\n    balance: int\n  }" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("  aggregate Wallet {\n    balance: int\n  }\n}");
  });

  it("add inserts a member into an aggregate", async () => {
    const r = await applyPatches(MODEL, [
      { op: "add", target: "aggregate Sales.Order", source: "note: string" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("    status: string\n    note: string\n  }");
  });

  it("is atomic — one bad target applies nothing and returns the original text", async () => {
    const r = await applyPatches(MODEL, [
      { op: "replace", target: "aggregate Sales.Order.status", source: "status: OrderStatus" },
      { op: "remove", target: "aggregate Sales.Nope" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.applied).toEqual([]);
    expect(r.text).toBe(MODEL);
    expect(r.errors[0]?.message).toMatch(/not found/);
  });

  it("rejects overlapping edits in one batch", async () => {
    const r = await applyPatches(MODEL, [
      { op: "replace", target: "aggregate Sales.Order", source: "aggregate Order { x: int }" },
      { op: "remove", target: "aggregate Sales.Order.total" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /overlaps/.test(e.message))).toBe(true);
  });

  it("'add' rejects a non-container target", async () => {
    const r = await applyPatches(MODEL, [
      { op: "add", target: "aggregate Sales.Order.total", source: "x: int" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/not a container/);
  });

  it("round-trip — the patched output re-parses without errors", async () => {
    const r = await applyPatches(MODEL, [
      { op: "add", target: "context Sales", source: "aggregate Wallet {\n    balance: int\n  }" },
    ]);
    expect(r.ok).toBe(true);
    const { errors } = await parseString(r.text);
    expect(errors).toEqual([]);
  });

  it("applies multiple non-overlapping patches in one batch", async () => {
    const r = await applyPatches(MODEL, [
      { op: "replace", target: "aggregate Sales.Order.status", source: "status: bool" },
      { op: "remove", target: "aggregate Sales.Order.total" },
      { op: "add", target: "context Sales", source: "aggregate Wallet {\n    balance: int\n  }" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("status: bool");
    expect(r.text).not.toContain("total: int");
    expect(r.text).toContain("aggregate Wallet");
    const { errors } = await parseString(r.text);
    expect(errors).toEqual([]);
  });
});
