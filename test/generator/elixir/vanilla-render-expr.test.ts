// Vanilla foundation render-expr seam (vanilla-foundation-tdd-plan.md, Slice 0;
// vanilla-foundation-research.md §3). The shared Elixir expression renderer
// diverges at two leaves under `foundation: "vanilla"` (plain Ecto, no Ash):
// enum values render as stored strings (not Ash atoms), and a filter-bound
// param is a bare Ecto pin `^name` (not the Ash read-action `^arg(:name)`).
// One RenderCtx flag, not a separate target — the 17-arm dispatch is shared.

import { describe, expect, it } from "vitest";
import { type RenderCtx, renderExpr } from "../../../src/generator/elixir/render-expr.js";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";

const ash: RenderCtx = { thisName: "record", contextModule: "Acme.Sales", filterArgs: true };
const vanilla: RenderCtx = { ...ash, foundation: "vanilla" };

const enumVal: ExprIR = { kind: "ref", name: "Confirmed", refKind: "enum-value" };
const filterParam: ExprIR = { kind: "ref", name: "minTotal", refKind: "param" };
// `status == Confirmed` — the shorthand-view / find filter shape.
const filter: ExprIR = {
  kind: "binary",
  op: "==",
  left: { kind: "ref", name: "status", refKind: "this-prop" },
  right: enumVal,
};

describe("render-expr foundation seam", () => {
  it("ash (default): enum → atom, filter param → ^arg(:name)", () => {
    expect(renderExpr(enumVal, ash)).toBe(":confirmed");
    expect(renderExpr(filterParam, ash)).toBe("^arg(:min_total)");
    expect(renderExpr(filter, ash)).toBe("record.status == :confirmed");
  });

  it("vanilla: enum → stored string, filter param → bare ^pin", () => {
    expect(renderExpr(enumVal, vanilla)).toBe('"confirmed"');
    expect(renderExpr(filterParam, vanilla)).toBe("^min_total");
    expect(renderExpr(filter, vanilla)).toBe('record.status == "confirmed"');
  });

  it("this-prop access is foundation-agnostic (record.<field> either way)", () => {
    const prop: ExprIR = { kind: "ref", name: "shipState", refKind: "this-prop" };
    expect(renderExpr(prop, ash)).toBe("record.ship_state");
    expect(renderExpr(prop, vanilla)).toBe("record.ship_state");
  });
});
