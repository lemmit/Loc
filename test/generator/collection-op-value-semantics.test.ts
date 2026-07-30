import { describe, expect, it } from "vitest";
import { renderCsExpr } from "../../src/generator/dotnet/render-expr.js";
import { renderExpr as renderElixirExpr } from "../../src/generator/elixir/render-expr.js";
import { collectPyExprImports, renderPyExpr } from "../../src/generator/python/render-expr.js";
import type { ExprIR, TypeIR } from "../../src/ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// M-T9.24 group 1 — collection-op VALUE semantics that diverged per backend.
// These compile clean everywhere; they just answer differently at runtime,
// which is the class the cross-backend wire differential exists to kill.
//
//   B3  Elixir `sortBy` fell back to `Enum.sort_by/2`'s structural TERM
//       ordering: `%DateTime{}` compares map fields alphabetically (`:day`
//       before `:month` before `:year`) and `%Decimal{}` compares `coef`/`exp`
//       (so `2` sorts before `1.5`).  Verified live in the hexpm image.
//   B4  Python `.sum(λ)` over money seeded the accumulator with int `0` —
//       `mypy --strict` rejects `Decimal | Literal[0]`, and an EMPTY
//       collection returned int `0` where Java gives `BigDecimal.ZERO`.
//   C2  .NET `firstOrNull()` over a VALUE-type element returned `default(T)`
//       (`0` / `false` / `DateTime.MinValue`) widened into `T?` as NON-null,
//       masking emptiness where TS/Python/Java all return null/None.
// ---------------------------------------------------------------------------

const INT: TypeIR = { kind: "primitive", name: "int" };
const MONEY: TypeIR = { kind: "primitive", name: "money" };
const DECIMAL: TypeIR = { kind: "primitive", name: "decimal" };
const DATETIME: TypeIR = { kind: "primitive", name: "datetime" };
const STRING: TypeIR = { kind: "primitive", name: "string" };
const ENTRY: TypeIR = { kind: "valueobject", name: "Entry" };

const arr = (element: TypeIR): TypeIR => ({ kind: "array", element });

const field = (name: string): ExprIR => ({ kind: "ref", name, refKind: "this-prop" });

/** `this.<recv>.<member>(x => x.<prop>)` over a `Entry[]` receiver. */
const projection = (
  member: string,
  prop: string,
  propType: TypeIR,
  extraArgs: ExprIR[] = [],
): ExprIR => ({
  kind: "method-call",
  receiver: field("entries"),
  member,
  args: [
    {
      kind: "lambda",
      param: "e",
      body: {
        kind: "member",
        receiver: { kind: "ref", name: "e", refKind: "lambda-param" },
        member: prop,
        receiverType: ENTRY,
        memberType: propType,
      },
    },
    ...extraArgs,
  ],
  receiverType: arr(ENTRY),
  isCollectionOp: true,
});

const firstOrNull = (element: TypeIR): ExprIR => ({
  kind: "method-call",
  receiver: field("items"),
  member: "firstOrNull",
  args: [],
  receiverType: arr(element),
  isCollectionOp: true,
});

describe("B3 — Elixir sortBy uses the type's compare/2, not term ordering", () => {
  it("passes the DateTime module for a datetime key", () => {
    expect(renderElixirExpr(projection("sortBy", "at", DATETIME))).toBe(
      `Enum.sort_by(record.entries, fn e -> Map.get(e, :at, Map.get(e, "at")) end, DateTime)`,
    );
  });

  it("passes the Decimal module for money and decimal keys", () => {
    expect(renderElixirExpr(projection("sortBy", "amount", MONEY))).toContain(", Decimal)");
    expect(renderElixirExpr(projection("sortBy", "rate", DECIMAL))).toContain(", Decimal)");
  });

  it("pairs the module with :desc on a descending sort", () => {
    const desc: ExprIR = { kind: "literal", lit: "bool", value: "true" };
    expect(renderElixirExpr(projection("sortBy", "amount", MONEY, [desc]))).toContain(
      ", {:desc, Decimal})",
    );
    // A plain-comparable key keeps the bare `:desc` atom.
    expect(renderElixirExpr(projection("sortBy", "n", INT, [desc]))).toContain(", :desc)");
  });

  it("leaves natively-comparable ascending keys on the 2-arity form", () => {
    expect(renderElixirExpr(projection("sortBy", "n", INT))).toBe(
      `Enum.sort_by(record.entries, fn e -> Map.get(e, :n, Map.get(e, "n")) end)`,
    );
    expect(renderElixirExpr(projection("sortBy", "name", STRING))).toBe(
      `Enum.sort_by(record.entries, fn e -> Map.get(e, :name, Map.get(e, "name")) end)`,
    );
  });
});

describe("B4 — Python money sum carries an explicit Decimal(0) start", () => {
  it("seeds a money projection and pulls in the Decimal import", () => {
    const e = projection("sum", "amount", MONEY);
    expect(renderPyExpr(e)).toBe(
      "sum(((lambda e: e.amount)(__x) for __x in self._entries), Decimal(0))",
    );
    expect(collectPyExprImports(e).has("decimal")).toBe(true);
  });

  it("seeds a bare `money[]` sum too", () => {
    const e: ExprIR = {
      kind: "method-call",
      receiver: field("amounts"),
      member: "sum",
      args: [],
      receiverType: arr(MONEY),
      isCollectionOp: true,
    };
    expect(renderPyExpr(e)).toBe("sum(self._amounts, Decimal(0))");
  });

  it("leaves int and decimal sums on the bare form", () => {
    // Loom `decimal` is a Python `float`; `float | Literal[0]` collapses to
    // `float` under mypy's numeric tower, so no start is needed.
    expect(renderPyExpr(projection("sum", "n", INT))).toBe(
      "sum((lambda e: e.n)(__x) for __x in self._entries)",
    );
    expect(renderPyExpr(projection("sum", "rate", DECIMAL))).toBe(
      "sum((lambda e: e.rate)(__x) for __x in self._entries)",
    );
  });
});

describe("C2 — .NET firstOrNull lifts value-type elements to null", () => {
  it("projects to the nullable element type for value types", () => {
    expect(renderCsExpr(firstOrNull(INT))).toBe(
      "(this.Items).Select(__e => (int?)__e).FirstOrDefault()",
    );
    expect(renderCsExpr(firstOrNull(DATETIME))).toContain("(DateTime?)__e");
    expect(renderCsExpr(firstOrNull(MONEY))).toContain("(decimal?)__e");
    expect(renderCsExpr(firstOrNull({ kind: "enum", name: "Status" }))).toContain("(Status?)__e");
    expect(
      renderCsExpr(firstOrNull({ kind: "id", targetName: "Order", valueType: "guid" })),
    ).toContain("(OrderId?)__e");
  });

  it("leaves reference-type elements on the plain call", () => {
    expect(renderCsExpr(firstOrNull(STRING))).toBe("(this.Items).FirstOrDefault()");
    expect(renderCsExpr(firstOrNull(ENTRY))).toBe("(this.Items).FirstOrDefault()");
  });

  it("still renders `first` as the throwing LINQ call", () => {
    const e: ExprIR = {
      kind: "method-call",
      receiver: field("items"),
      member: "first",
      args: [],
      receiverType: arr(INT),
      isCollectionOp: true,
    };
    expect(renderCsExpr(e)).toBe("(this.Items).First()");
  });
});
