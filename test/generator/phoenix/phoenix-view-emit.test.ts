// Supplementary `emitViews` unit tests focused on the shorthand-form
// path (`view X = Aggregate where filter`) — the full-form path is
// already covered in `phoenix-live-view-pipeline.test.ts:1306+`.
//
// Shorthand emits a thin Ash.Query.filter pipe; no projection,
// no auxiliary loads.

import { describe, expect, it } from "vitest";
import { emitViews } from "../../../src/generator/phoenix-live-view/view-emit.js";
import type { BoundedContextIR, ExprIR } from "../../../src/ir/types/loom-ir.js";

const baseAggregate = {
  name: "Order",
  idValueType: "guid" as const,
  fields: [
    {
      name: "status",
      type: { kind: "enum", name: "OrderStatus" } as const,
      optional: false,
    },
  ],
  contains: [],
  derived: [],
  invariants: [],
  functions: [],
  operations: [],
  parts: [],
  tests: [],
};

function buildCtx(filter: ExprIR | undefined): BoundedContextIR {
  return {
    name: "Sales",
    enums: [{ name: "OrderStatus", values: ["Draft", "Confirmed", "Cancelled"] }],
    valueObjects: [],
    events: [],
    aggregates: [baseAggregate],
    repositories: [],
    workflows: [],
    views: [
      {
        name: "ActiveOrders",
        aggregateName: "Order",
        filter,
        // No output → shorthand form
      },
    ],
  } as unknown as BoundedContextIR;
}

function emit(ctx: BoundedContextIR): string {
  const out = new Map<string, string>();
  emitViews("acme", ctx, "Acme", out);
  const file = out.get("lib/acme/sales/views/active_orders.ex");
  if (!file) throw new Error("expected view file at lib/acme/sales/views/active_orders.ex");
  return file;
}

describe("phoenix emitViews — shorthand form", () => {
  const filterIR: ExprIR = {
    kind: "binary",
    op: "==",
    left: { kind: "ref", name: "status", refKind: "this-prop" },
    right: { kind: "ref", name: "Confirmed", refKind: "enum-value" },
  };

  it("emits the module at lib/<app>/<ctx>/views/<view_snake>.ex", () => {
    const out = new Map<string, string>();
    emitViews("acme", buildCtx(filterIR), "Acme", out);
    expect(out.has("lib/acme/sales/views/active_orders.ex")).toBe(true);
  });

  it("declares a module at <ContextModule>.Views.<View>", () => {
    expect(emit(buildCtx(filterIR))).toMatch(/^defmodule Acme\.Sales\.Views\.ActiveOrders do/m);
  });

  it("emits `alias <ContextModule>.<Aggregate>` and `require Ash.Query`", () => {
    const src = emit(buildCtx(filterIR));
    expect(src).toMatch(/alias Acme\.Sales\.Order/);
    expect(src).toMatch(/require Ash\.Query/);
  });

  it("emits an Ash.Query.filter when a filter is present", () => {
    expect(emit(buildCtx(filterIR))).toMatch(
      /\|> Ash\.Query\.filter\(record\.status == :confirmed\)/,
    );
  });

  it("emits `|> Ash.read!()` as the final pipe stage", () => {
    expect(emit(buildCtx(filterIR))).toMatch(/\|> Ash\.read!\(\)/);
  });

  it("omits Ash.Query.filter when no filter is declared", () => {
    expect(emit(buildCtx(undefined))).not.toMatch(/Ash\.Query\.filter/);
  });

  it("describes the return type as `list of <Aggregate> records` in moduledoc", () => {
    expect(emit(buildCtx(filterIR))).toMatch(/Returns list of Order records\./);
  });

  it("emits a run/1 function that threads `current_user` (default nil)", () => {
    const src = emit(buildCtx(filterIR));
    expect(src).toMatch(/def run\(current_user \\\\ nil\) do/);
    expect(src).toMatch(/_ = current_user/);
  });

  it("skips the view entirely when its aggregateName doesn't resolve", () => {
    const ctx = buildCtx(filterIR);
    // biome-ignore lint/style/noNonNullAssertion: test setup mutation
    ctx.views[0]!.aggregateName = "DoesNotExist";
    const out = new Map<string, string>();
    emitViews("acme", ctx, "Acme", out);
    expect(out.size).toBe(0);
  });

  it("emits nothing when the context has no views", () => {
    const ctx = buildCtx(filterIR);
    ctx.views = [];
    const out = new Map<string, string>();
    emitViews("acme", ctx, "Acme", out);
    expect(out.size).toBe(0);
  });
});
