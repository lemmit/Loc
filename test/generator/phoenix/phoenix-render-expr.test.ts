// Direct unit tests for Phoenix's `renderExpr` — exercises each
// `ExprIR.kind` arm against the live emitter to lock per-kind output
// without going through codegen/build.  Mirrors the dispatch table in
// `src/generator/phoenix-live-view/render-expr.ts:55-102`.
//
// These tests run in the fast suite (no `LOOM_PHOENIX_BUILD`, no Elixir,
// no `mix`); Phoenix codegen is pure TS string emission.

import { describe, expect, it } from "vitest";
import { renderExpr } from "../../../src/generator/phoenix-live-view/render-expr.js";
import type { ExprIR, TypeIR } from "../../../src/ir/types/loom-ir.js";

const ctx = { thisName: "record", contextModule: "MyApp" };

const prim = (name: TypeIR extends { kind: "primitive" } ? string : never): TypeIR =>
  ({ kind: "primitive", name }) as TypeIR;
const STRING: TypeIR = { kind: "primitive", name: "string" };
const INT: TypeIR = { kind: "primitive", name: "int" };
const MONEY: TypeIR = { kind: "primitive", name: "money" };
const BOOL: TypeIR = { kind: "primitive", name: "bool" };

const litInt = (v: string): ExprIR => ({ kind: "literal", lit: "int", value: v });
const litStr = (v: string): ExprIR => ({ kind: "literal", lit: "string", value: v });
const litMoney = (v: string): ExprIR => ({ kind: "literal", lit: "money", value: v });
const refParam = (name: string): ExprIR => ({ kind: "ref", name, refKind: "param" });
const thisProp = (name: string): ExprIR => ({ kind: "ref", name, refKind: "this-prop" });

describe("phoenix renderExpr — literals", () => {
  it("renders string literals as Elixir-quoted strings", () => {
    expect(renderExpr(litStr("hello"), ctx)).toBe('"hello"');
  });

  it("renders int literals verbatim", () => {
    expect(renderExpr(litInt("42"), ctx)).toBe("42");
  });

  it("renders bool literals as Elixir atoms (true/false)", () => {
    expect(renderExpr({ kind: "literal", lit: "bool", value: "true" }, ctx)).toBe("true");
    expect(renderExpr({ kind: "literal", lit: "bool", value: "false" }, ctx)).toBe("false");
  });

  it("renders null as nil", () => {
    expect(renderExpr({ kind: "literal", lit: "null", value: "" }, ctx)).toBe("nil");
  });

  it("renders `now` as DateTime.utc_now()", () => {
    expect(renderExpr({ kind: "literal", lit: "now", value: "" }, ctx)).toBe("DateTime.utc_now()");
  });

  it("renders decimal literals as plain numbers", () => {
    expect(renderExpr({ kind: "literal", lit: "decimal", value: "1.5" }, ctx)).toBe("1.5");
  });

  it("wraps money literals in Decimal.new(\"…\")", () => {
    expect(renderExpr(litMoney("9.99"), ctx)).toBe('Decimal.new("9.99")');
  });
});

describe("phoenix renderExpr — receivers", () => {
  it("renders `this` as ctx.thisName", () => {
    expect(renderExpr({ kind: "this" }, ctx)).toBe("record");
    expect(renderExpr({ kind: "this" }, { ...ctx, thisName: "changeset" })).toBe("changeset");
  });

  it("renders `id` as <thisName>.id", () => {
    expect(renderExpr({ kind: "id" }, ctx)).toBe("record.id");
  });

  it("snake-cases param refs", () => {
    expect(renderExpr(refParam("orderNumber"), ctx)).toBe("order_number");
  });

  it("renders this-prop refs as <thisName>.<snake_name>", () => {
    expect(renderExpr(thisProp("customerName"), ctx)).toBe("record.customer_name");
  });

  it("renders enum-value refs as Elixir atoms", () => {
    expect(renderExpr({ kind: "ref", name: "Active", refKind: "enum-value" }, ctx)).toBe(":active");
  });

  it("renders current-user refs verbatim", () => {
    expect(renderExpr({ kind: "ref", name: "currentUser", refKind: "current-user" }, ctx)).toBe(
      "current_user",
    );
  });
});

describe("phoenix renderExpr — binary operators", () => {
  it("renders `+` on ints as native plus", () => {
    expect(
      renderExpr(
        { kind: "binary", op: "+", left: litInt("1"), right: litInt("2"), leftType: INT },
        ctx,
      ),
    ).toBe("1 + 2");
  });

  it("renders `+` on money as Decimal.add", () => {
    expect(
      renderExpr(
        { kind: "binary", op: "+", left: litMoney("1"), right: litMoney("2"), leftType: MONEY },
        ctx,
      ),
    ).toBe('Decimal.add(Decimal.new("1"), Decimal.new("2"))');
  });

  it("renders `*` on money as Decimal.mult", () => {
    expect(
      renderExpr(
        { kind: "binary", op: "*", left: litMoney("3"), right: litInt("2"), leftType: MONEY },
        ctx,
      ),
    ).toBe('Decimal.mult(Decimal.new("3"), 2)');
  });

  it("renders money comparisons via Decimal.compare", () => {
    expect(
      renderExpr(
        { kind: "binary", op: ">", left: litMoney("5"), right: litMoney("3"), leftType: MONEY },
        ctx,
      ),
    ).toBe('Decimal.compare(Decimal.new("5"), Decimal.new("3")) == :gt');
  });

  it("renders `+` on string types as Elixir <>", () => {
    expect(
      renderExpr(
        { kind: "binary", op: "+", left: litStr("a"), right: litStr("b"), leftType: STRING },
        ctx,
      ),
    ).toBe('"a" <> "b"');
  });

  it("renders `&&` as Elixir `and`", () => {
    expect(
      renderExpr(
        {
          kind: "binary",
          op: "&&",
          left: { kind: "literal", lit: "bool", value: "true" },
          right: { kind: "literal", lit: "bool", value: "false" },
          leftType: BOOL,
        },
        ctx,
      ),
    ).toBe("true and false");
  });

  it("renders `||` as Elixir `or`", () => {
    expect(
      renderExpr(
        {
          kind: "binary",
          op: "||",
          left: { kind: "literal", lit: "bool", value: "true" },
          right: { kind: "literal", lit: "bool", value: "false" },
          leftType: BOOL,
        },
        ctx,
      ),
    ).toBe("true or false");
  });

  it("renders `%` as the `rem(...)` function", () => {
    expect(
      renderExpr(
        { kind: "binary", op: "%", left: litInt("7"), right: litInt("3"), leftType: INT },
        ctx,
      ),
    ).toBe("rem(7, 3)");
  });
});

describe("phoenix renderExpr — unary, paren, ternary", () => {
  it("renders `!` as Elixir `not`", () => {
    expect(renderExpr({ kind: "unary", op: "!", operand: thisProp("active") }, ctx)).toBe(
      "not record.active",
    );
  });

  it("renders unary minus as a prefix operator", () => {
    expect(renderExpr({ kind: "unary", op: "-", operand: litInt("3") }, ctx)).toBe("-3");
  });

  it("preserves paren as visual grouping in source", () => {
    expect(
      renderExpr({ kind: "paren", inner: { kind: "literal", lit: "bool", value: "true" } }, ctx),
    ).toBe("(true)");
  });

  it("lowers ternary to `if cond, do: x, else: y`", () => {
    expect(
      renderExpr(
        {
          kind: "ternary",
          cond: { kind: "literal", lit: "bool", value: "true" },
          then: litInt("1"),
          otherwise: litInt("2"),
        },
        ctx,
      ),
    ).toBe("if true, do: 1, else: 2");
  });
});

describe("phoenix renderExpr — convert", () => {
  it("converts string(money) via Decimal.to_string", () => {
    expect(
      renderExpr({ kind: "convert", target: "string", from: "money", value: thisProp("price") }, ctx),
    ).toBe("Decimal.to_string(record.price)");
  });

  it("converts string(int) via to_string", () => {
    expect(
      renderExpr({ kind: "convert", target: "string", from: "int", value: litInt("3") }, ctx),
    ).toBe("to_string(3)");
  });

  it("converts money(int) via Decimal.new", () => {
    expect(
      renderExpr({ kind: "convert", target: "money", from: "int", value: litInt("5") }, ctx),
    ).toBe("Decimal.new(5)");
  });

  it("treats money→money convert as no-op", () => {
    expect(
      renderExpr(
        { kind: "convert", target: "money", from: "money", value: thisProp("amount") },
        ctx,
      ),
    ).toBe("record.amount");
  });
});

describe("phoenix renderExpr — match", () => {
  it("renders match → cond do … end with `true ->` fallthrough on no else", () => {
    expect(
      renderExpr(
        {
          kind: "match",
          arms: [{ cond: thisProp("active"), value: litStr("yes") }],
        },
        ctx,
      ),
    ).toBe('cond do\n    record.active -> "yes"\n    true -> nil\n  end');
  });

  it("renders match with else as the trailing `true ->` clause", () => {
    expect(
      renderExpr(
        {
          kind: "match",
          arms: [{ cond: thisProp("active"), value: litStr("yes") }],
          otherwise: litStr("no"),
        },
        ctx,
      ),
    ).toBe('cond do\n    record.active -> "yes"\n    true -> "no"\n  end');
  });
});

describe("phoenix renderExpr — member, method-call, call, new, list, lambda", () => {
  it("renders member access as <recv>.<snake_member>", () => {
    expect(
      renderExpr(
        {
          kind: "member",
          receiver: thisProp("address"),
          member: "postalCode",
          receiverType: { kind: "valueobject", name: "Address" },
          memberType: STRING,
        },
        ctx,
      ),
    ).toBe("record.address.postal_code");
  });

  it("collapses string.length → String.length(...)", () => {
    expect(
      renderExpr(
        {
          kind: "member",
          receiver: thisProp("name"),
          member: "length",
          receiverType: STRING,
          memberType: INT,
        },
        ctx,
      ),
    ).toBe("String.length(record.name)");
  });

  it("collapses array.count → Enum.count(...)", () => {
    expect(
      renderExpr(
        {
          kind: "member",
          receiver: thisProp("items"),
          member: "count",
          receiverType: { kind: "array", element: STRING },
          memberType: INT,
        },
        ctx,
      ),
    ).toBe("Enum.count(record.items)");
  });

  it("renders string.matches(literal) as Regex.match?(~r/…/, …)", () => {
    expect(
      renderExpr(
        {
          kind: "method-call",
          receiver: thisProp("email"),
          member: "matches",
          args: [litStr("^[^@]+@.+$")],
          receiverType: STRING,
          isCollectionOp: false,
        },
        ctx,
      ),
    ).toBe("Regex.match?(~r/^[^@]+@.+$/, record.email)");
  });

  it("renders collection-op `count` as Enum.count", () => {
    expect(
      renderExpr(
        {
          kind: "method-call",
          receiver: thisProp("items"),
          member: "count",
          args: [],
          receiverType: { kind: "array", element: STRING },
          isCollectionOp: true,
        },
        ctx,
      ),
    ).toBe("Enum.count(record.items)");
  });

  it("renders function call with receiver prepended (passed first arg)", () => {
    expect(
      renderExpr(
        { kind: "call", callKind: "function", name: "computeTotal", args: [litInt("3")] },
        ctx,
      ),
    ).toBe("compute_total(record, 3)");
  });

  it("omits the trailing receiver-comma when a function takes no extra args", () => {
    expect(
      renderExpr({ kind: "call", callKind: "function", name: "refresh", args: [] }, ctx),
    ).toBe("refresh(record)");
  });

  it("renders value-object constructor as %ContextModule.Name{…}", () => {
    expect(
      renderExpr(
        {
          kind: "call",
          callKind: "value-object-ctor",
          name: "Money",
          args: [litInt("3")],
        },
        ctx,
      ),
    ).toBe("%MyApp.Money{3}");
  });

  it("renders entity-part constructor (kind: new) with snake field keys", () => {
    expect(
      renderExpr(
        {
          kind: "new",
          partName: "LineItem",
          fields: [
            { name: "sku", value: litStr("ABC") },
            { name: "qtyOrdered", value: litInt("2") },
          ],
        },
        ctx,
      ),
    ).toBe('%MyApp.LineItem{sku: "ABC", qty_ordered: 2}');
  });

  it("renders single-expression lambda as fn x -> expr end", () => {
    expect(
      renderExpr(
        { kind: "lambda", param: "item", body: thisProp("active") },
        ctx,
      ),
    ).toBe("fn item -> record.active end");
  });

  it("renders block-body lambda as a TODO comment (Elixir disallows inline blocks)", () => {
    expect(renderExpr({ kind: "lambda", param: "x", block: [] }, ctx)).toBe(
      "fn x -> # block-body-lambda end",
    );
  });

  it("renders list literal as Elixir [a, b, c]", () => {
    expect(
      renderExpr({ kind: "list", elements: [litInt("1"), litInt("2"), litInt("3")] }, ctx),
    ).toBe("[1, 2, 3]");
  });

  it("renders object literal as %{k: v, …} with snake keys", () => {
    expect(
      renderExpr(
        {
          kind: "object",
          fields: [
            { name: "firstName", value: litStr("Ada") },
            { name: "age", value: litInt("36") },
          ],
        },
        ctx,
      ),
    ).toBe('%{first_name: "Ada", age: 36}');
  });
});

// Keep the type-import only used by the test helpers from being elided.
void prim;
