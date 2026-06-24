// Vanilla foundation render-expr leaves (vanilla-foundation-tdd-plan.md, Slice 0;
// vanilla-foundation-research.md §3). `platform: elixir` only emits the vanilla
// foundation (plain Ecto, no Ash): enum values render as stored strings, and a
// filter-bound param is a bare Ecto pin `^name`.

import { describe, expect, it } from "vitest";
import { type RenderCtx, renderExpr } from "../../../src/generator/elixir/render-expr.js";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";

const ctx: RenderCtx = {
  thisName: "record",
  contextModule: "Acme.Sales",
  filterArgs: true,
  foundation: "vanilla",
};

const enumVal: ExprIR = { kind: "ref", name: "Confirmed", refKind: "enum-value" };
const filterParam: ExprIR = { kind: "ref", name: "minTotal", refKind: "param" };
// `status == Confirmed` — the shorthand-view / find filter shape.
const filter: ExprIR = {
  kind: "binary",
  op: "==",
  left: { kind: "ref", name: "status", refKind: "this-prop" },
  right: enumVal,
};

describe("render-expr vanilla leaves", () => {
  it("enum → stored string, filter param → bare ^pin", () => {
    expect(renderExpr(enumVal, ctx)).toBe('"confirmed"');
    expect(renderExpr(filterParam, ctx)).toBe("^min_total");
    expect(renderExpr(filter, ctx)).toBe('record.status == "confirmed"');
  });

  it("this-prop access renders record.<field>", () => {
    const prop: ExprIR = { kind: "ref", name: "shipState", refKind: "this-prop" };
    expect(renderExpr(prop, ctx)).toBe("record.ship_state");
  });
});
