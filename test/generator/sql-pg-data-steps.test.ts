import { describe, expect, it } from "vitest";
import { renderEctoStep } from "../../src/generator/elixir/migrations-emit.js";
import { renderBackfillSql, renderPgStep } from "../../src/generator/sql-pg.js";
import { renderSqlScalarExpr, sqlRenderableExpr } from "../../src/generator/sql-pg-expr.js";
import type { ExprIR, LiteralKind, TypeIR } from "../../src/ir/types/loom-ir.js";
import type { MigrationStep } from "../../src/ir/types/migrations-ir.js";

// M-T2.3 S1 — the data-step vocabulary (`backfillColumn` / `sqlExec`) and the
// scalar-expression renderer, at the renderer level.  No producer exists in
// this slice; the builder starts emitting these steps in S3.

const backfill: MigrationStep = {
  op: "backfillColumn",
  table: "orders",
  schema: "sales",
  column: "status",
  valueSql: "'pending'",
  onlyNull: true,
};

describe("renderPgStep — data steps (M-T2.3)", () => {
  it("renders backfillColumn as a null-guarded UPDATE", () => {
    expect(renderPgStep(backfill)).toBe(
      `UPDATE "sales"."orders" SET "status" = 'pending' WHERE "status" IS NULL;`,
    );
  });

  it("renders an unconditional backfill without the null guard or schema", () => {
    expect(
      renderPgStep({
        op: "backfillColumn",
        table: "orders",
        column: "note",
        valueSql: "''",
        onlyNull: false,
      }),
    ).toBe(`UPDATE "orders" SET "note" = '';`);
  });

  it("renders sqlExec verbatim, normalising the trailing semicolon", () => {
    const sql = "UPDATE sales.orders SET note = '' WHERE note IS NULL";
    expect(renderPgStep({ op: "sqlExec", sql })).toBe(`${sql};`);
    expect(renderPgStep({ op: "sqlExec", sql: `${sql};` })).toBe(`${sql};`);
    expect(renderPgStep({ op: "sqlExec", sql: `${sql};  ` })).toBe(`${sql};`);
  });
});

describe("renderEctoStep — data steps (M-T2.3)", () => {
  it("wraps the SHARED backfill UPDATE in execute/1 (bit-identical DML)", () => {
    expect(renderEctoStep(backfill)).toEqual([
      `execute("${renderBackfillSql(backfill).replace(/"/g, '\\"')}")`,
    ]);
  });

  it("wraps sqlExec in execute/1, stripping the trailing semicolon", () => {
    expect(renderEctoStep({ op: "sqlExec", sql: "UPDATE t SET a = 1;" })).toEqual([
      `execute("UPDATE t SET a = 1")`,
    ]);
  });

  it("escapes quotes and #{} interpolation in user SQL", () => {
    const step: MigrationStep = { op: "sqlExec", sql: `UPDATE t SET a = '#{x}' WHERE b = "q"` };
    expect(renderEctoStep(step)).toEqual([
      `execute("UPDATE t SET a = '\\#{x}' WHERE b = \\"q\\"")`,
    ]);
  });
});

// -- expression renderer ----------------------------------------------------

const STRING: TypeIR = { kind: "primitive", name: "string" };
const lit = (l: LiteralKind, value: string): ExprIR => ({ kind: "literal", lit: l, value });
const prop = (name: string): ExprIR => ({ kind: "ref", name, refKind: "this-prop" });
const ctx = {
  columnFor: (f: string) => ({ firstName: "first_name", lastName: "last_name", qty: "qty" })[f],
};

describe("renderSqlScalarExpr (M-T2.3)", () => {
  it("renders literals", () => {
    expect(renderSqlScalarExpr(lit("string", "pen'ding"), ctx)).toBe(`'pen''ding'`);
    expect(renderSqlScalarExpr(lit("int", "42"), ctx)).toBe("42");
    expect(renderSqlScalarExpr(lit("bool", "true"), ctx)).toBe("TRUE");
    expect(renderSqlScalarExpr(lit("null", "null"), ctx)).toBe("NULL");
    expect(renderSqlScalarExpr(lit("now", "now"), ctx)).toBe("now()");
  });

  it("renders enum values as their stored text", () => {
    expect(
      renderSqlScalarExpr({ kind: "ref", name: "Confirmed", refKind: "enum-value" }, ctx),
    ).toBe(`'Confirmed'`);
  });

  it("renders sibling-field refs as quoted columns", () => {
    expect(renderSqlScalarExpr(prop("firstName"), ctx)).toBe(`"first_name"`);
  });

  it("dispatches string + to || on leftType, numeric + stays +", () => {
    const concat: ExprIR = {
      kind: "binary",
      op: "+",
      left: prop("firstName"),
      right: lit("string", " "),
      leftType: STRING,
    };
    expect(renderSqlScalarExpr(concat, ctx)).toBe(`("first_name" || ' ')`);
    const sum: ExprIR = { kind: "binary", op: "+", left: prop("qty"), right: lit("int", "1") };
    expect(renderSqlScalarExpr(sum, ctx)).toBe(`("qty" + 1)`);
  });

  it("spells ==, !=, &&, || and the ternary in SQL", () => {
    const cmp: ExprIR = { kind: "binary", op: "==", left: prop("qty"), right: lit("int", "0") };
    expect(renderSqlScalarExpr(cmp, ctx)).toBe(`("qty" = 0)`);
    const ne: ExprIR = { kind: "binary", op: "!=", left: prop("qty"), right: lit("int", "0") };
    expect(renderSqlScalarExpr(ne, ctx)).toBe(`("qty" <> 0)`);
    const and: ExprIR = { kind: "binary", op: "&&", left: cmp, right: ne };
    expect(renderSqlScalarExpr(and, ctx)).toBe(`(("qty" = 0) AND ("qty" <> 0))`);
    const tern: ExprIR = {
      kind: "ternary",
      cond: cmp,
      // biome-ignore lint/suspicious/noThenProperty: the ternary IR node's branch field is named `then` across the IR
      then: lit("int", "1"),
      otherwise: prop("qty"),
    };
    expect(renderSqlScalarExpr(tern, ctx)).toBe(`(CASE WHEN ("qty" = 0) THEN 1 ELSE "qty" END)`);
  });

  it("renders unary ! as NOT and - as negation", () => {
    expect(renderSqlScalarExpr({ kind: "unary", op: "!", operand: prop("qty") }, ctx)).toBe(
      `(NOT "qty")`,
    );
    expect(renderSqlScalarExpr({ kind: "unary", op: "-", operand: lit("int", "1") }, ctx)).toBe(
      `(-1)`,
    );
  });
});

describe("sqlRenderableExpr (M-T2.3 honest gate)", () => {
  it("admits the supported subset", () => {
    expect(sqlRenderableExpr(lit("string", "x"))).toBe(true);
    expect(sqlRenderableExpr(prop("qty"))).toBe(true);
    expect(
      sqlRenderableExpr({ kind: "binary", op: "+", left: prop("qty"), right: lit("int", "1") }),
    ).toBe(true);
  });

  it("rejects value-object leaves with the portability reason", () => {
    const r = sqlRenderableExpr({ kind: "ref", name: "amount", refKind: "this-vo-prop" });
    expect(r).not.toBe(true);
    expect((r as { reason: string }).reason).toMatch(/value-object/);
  });

  it("rejects calls, and the rejection propagates out of nesting", () => {
    const call: ExprIR = { kind: "call", callKind: "free", name: "compute", args: [] };
    expect(sqlRenderableExpr(call)).not.toBe(true);
    const nested: ExprIR = { kind: "binary", op: "+", left: prop("qty"), right: call };
    const r = sqlRenderableExpr(nested);
    expect(r).not.toBe(true);
    expect((r as { reason: string }).reason).toMatch(/'call'/);
  });
});
