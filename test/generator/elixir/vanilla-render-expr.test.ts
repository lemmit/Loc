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
  it("enum → declared string in a filter (query) context, atom in-memory; filter param → bare ^pin", () => {
    // Query context (filterArgs): dumped DECLARED string, matching the text column.
    expect(renderExpr(enumVal, ctx)).toBe('"Confirmed"');
    expect(renderExpr(filterParam, ctx)).toBe("^min_total");
    expect(renderExpr(filter, ctx)).toBe('record.status == "Confirmed"');
    // In-memory context (no filterArgs): the loaded Ecto.Enum field is the
    // declared-case atom, so the comparison literal is `:Confirmed` (unquoted —
    // value names are identifiers; `:"Confirmed"` would warn under -Werror).
    const memCtx: RenderCtx = {
      thisName: "record",
      contextModule: "Acme.Sales",
      foundation: "vanilla",
    };
    expect(renderExpr(enumVal, memCtx)).toBe(":Confirmed");
    expect(renderExpr(filter, memCtx)).toBe("record.status == :Confirmed");
  });

  it("this-prop access renders record.<field>", () => {
    const prop: ExprIR = { kind: "ref", name: "shipState", refKind: "this-prop" };
    expect(renderExpr(prop, ctx)).toBe("record.ship_state");
  });

  it("string.trim() intrinsic → SQL fragment in a filter (query) context, String.trim in-memory (stdlib A1)", () => {
    const trimmed: ExprIR = {
      kind: "method-call",
      receiver: { kind: "ref", name: "name", refKind: "this-prop" },
      member: "trim",
      args: [],
      receiverType: { kind: "primitive", name: "string" },
      isCollectionOp: false,
    };
    // Query context (filterArgs): a `String.*` call is not a valid Ecto query
    // expression — render the SQL fragment (both column-side and value-side
    // receivers compose inside `where:`).
    expect(renderExpr(trimmed, ctx)).toBe('fragment("btrim(?)", record.name)');
    // In-memory context: the `String.trim/1` stdlib call (Elixir strings have
    // no methods — the old fallthrough emitted invalid `record.name.trim()`).
    const memCtx: RenderCtx = {
      thisName: "record",
      contextModule: "Acme.Sales",
      foundation: "vanilla",
    };
    expect(renderExpr(trimmed, memCtx)).toBe("String.trim(record.name)");
  });

  // An operation self-call resolves to the sibling op's context fn
  // `<op>_<agg>(record, params)` (arity 2, tagged-tuple result); a `function`
  // self-call stays the bare arity-1 `is_draft(record)`.  The op ctx needs `agg`
  // so the `_<agg>` suffix resolves.
  const opCtx: RenderCtx = {
    thisName: "record",
    contextModule: "Acme.Sales",
    foundation: "vanilla",
    // biome-ignore lint/suspicious/noExplicitAny: only `.name` is read by the call seam
    agg: { name: "Item" } as any,
  };

  it("operation self-call → <op>_<agg>(record, %{}); named args → string-keyed map", () => {
    const noArg: ExprIR = {
      kind: "call",
      callKind: "private-operation",
      name: "reserve",
      args: [],
    };
    expect(renderExpr(noArg, opCtx)).toBe("reserve_item(record, %{})");

    const withArgs: ExprIR = {
      kind: "call",
      callKind: "private-operation",
      name: "adjust",
      args: [{ kind: "literal", lit: "int", value: "5" }],
      argNames: ["delta"],
    };
    expect(renderExpr(withArgs, opCtx)).toBe('adjust_item(record, %{"delta" => 5})');
  });

  it("function self-call stays the bare arity-1 name", () => {
    const fn: ExprIR = { kind: "call", callKind: "function", name: "isDraft", args: [] };
    expect(renderExpr(fn, opCtx)).toBe("is_draft(record)");
  });
});
