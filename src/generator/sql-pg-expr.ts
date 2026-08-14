import type { ExprIR, TypeIR } from "../ir/types/loom-ir.js";
import { sqlRenderableExpr } from "../ir/util/sql-renderable-expr.js";
import { type BinaryExpr, isIntDivWidenedToDecimal } from "./_expr/target.js";
import { qIdent, sqlStr } from "./sql-pg.js";

export { sqlRenderableExpr };

// ---------------------------------------------------------------------------
// ExprIR → Postgres scalar-SQL renderer (M-T2.3 data-migration surface).
//
// Renders a `migration`-block backfill expression (`Order.status = <expr>`)
// to the SQL text carried on a `backfillColumn` step's `valueSql`.  This is
// deliberately NOT an `ExprTarget` implementation: that contract exists for
// full-language backends; this is a small validated subset where most of the
// ExprIR kinds are *rejected up front* by `sqlRenderableExpr` (the honest
// gate backing `loom.migration-expr-unsupported`) rather than rendered.
//
// Supported: literals (string/int/long/decimal/money/bool/null/now), enum
// values (their stored text), sibling-field refs (`this-prop` → the quoted
// snake-cased column), parens, unary -/!, the closed BinOp set, and the
// ternary (→ CASE WHEN).  Sibling refs are restricted to scalar fields —
// value-object leaves are excluded (Phoenix stores a VO as one `:map`
// column, so a leaf-column UPDATE would not be portable across backends).
//
// The renderer and the predicate MUST stay in lockstep: everything
// `sqlRenderableExpr` admits, `renderSqlScalarExpr` renders; the renderer
// throws on anything the predicate would have rejected (a pipeline bug, not
// a user error — user errors are caught at validate time).
// ---------------------------------------------------------------------------

export interface SqlExprContext {
  /** Resolve a sibling-field reference to its physical column name (already
   *  snake-cased), or undefined when the field has no single scalar column
   *  (unknown name, value-object field, containment, …). */
  columnFor(fieldName: string): string | undefined;
}

/** Render an admitted expression to Postgres scalar SQL.  Throws on a kind
 *  `sqlRenderableExpr` rejects — callers validate first. */
export function renderSqlScalarExpr(e: ExprIR, ctx: SqlExprContext): string {
  switch (e.kind) {
    case "literal":
      switch (e.lit) {
        case "string":
          return sqlStr(e.value);
        case "int":
        case "long":
        case "decimal":
        case "money":
          return e.value;
        case "bool":
          return e.value === "true" ? "TRUE" : "FALSE";
        case "null":
          return "NULL";
        case "now":
          return "now()";
      }
      // Exhaustive over LiteralKind; keep the compiler honest if it grows.
      throw new Error(`renderSqlScalarExpr: unhandled literal kind '${e.lit}'`);
    case "ref": {
      if (e.refKind === "enum-value") return sqlStr(e.name);
      if (e.refKind === "this-prop") {
        const col = ctx.columnFor(e.name);
        if (!col) {
          throw new Error(
            `renderSqlScalarExpr: field '${e.name}' has no single scalar column (validator should have rejected this)`,
          );
        }
        return qIdent(col);
      }
      throw new Error(`renderSqlScalarExpr: unsupported ref kind '${e.refKind}'`);
    }
    case "paren":
      return `(${renderSqlScalarExpr(e.inner, ctx)})`;
    case "unary":
      return e.op === "!"
        ? `(NOT ${renderSqlScalarExpr(e.operand, ctx)})`
        : `(-${renderSqlScalarExpr(e.operand, ctx)})`;
    case "binary": {
      const nullTest = renderNullTest(e, ctx);
      if (nullTest) return nullTest;
      const l = renderSqlScalarExpr(e.left, ctx);
      const r = renderSqlScalarExpr(e.right, ctx);
      // `int / int` widens to `decimal` in Loom's type system (5 / 2 = 2.5),
      // but Postgres integer `/` truncates — cast both operands so a backfill
      // computes the same value every backend does.
      if (isIntDivWidenedToDecimal(e)) return `((${l})::numeric / (${r})::numeric)`;
      return `(${l} ${sqlBinOp(e.op, e.leftType)} ${r})`;
    }
    case "ternary": {
      const c = renderSqlScalarExpr(e.cond, ctx);
      const t = renderSqlScalarExpr(e.then, ctx);
      const o = renderSqlScalarExpr(e.otherwise, ctx);
      return `(CASE WHEN ${c} THEN ${t} ELSE ${o} END)`;
    }
    default:
      throw new Error(
        `renderSqlScalarExpr: unsupported expression kind '${e.kind}' (validator should have rejected this)`,
      );
  }
}

/** Render `x == null` / `x != null` (either operand order) as SQL's
 *  `IS NULL` / `IS NOT NULL`.  Loom's `== null` is a presence test on every
 *  backend; Postgres `= NULL` is three-valued and never TRUE, so the plain
 *  operator spelling would send every row down the wrong branch.  Returns
 *  undefined when neither operand is a null literal. */
function renderNullTest(e: BinaryExpr, ctx: SqlExprContext): string | undefined {
  if (e.op !== "==" && e.op !== "!=") return undefined;
  const rightIsNull = isNullLit(e.right);
  const leftIsNull = isNullLit(e.left);
  if (!rightIsNull && !leftIsNull) return undefined;
  const other = renderSqlScalarExpr(rightIsNull ? e.left : e.right, ctx);
  return `(${other} IS${e.op === "!=" ? " NOT" : ""} NULL)`;
}

function isNullLit(e: ExprIR): boolean {
  return e.kind === "literal" && e.lit === "null";
}

/** Map a Loom BinOp to its Postgres spelling.  String `+` is concatenation
 *  (`||`), dispatched on the lowered `leftType` exactly as the backend
 *  expression renderers dispatch money arithmetic. */
function sqlBinOp(op: string, leftType: TypeIR | undefined): string {
  switch (op) {
    case "+":
      return isStringType(leftType) ? "||" : "+";
    case "==":
      return "=";
    case "!=":
      return "<>";
    case "&&":
      return "AND";
    case "||":
      return "OR";
    default:
      return op; // - * / % < <= > >= are spelled identically
  }
}

function isStringType(t: TypeIR | undefined): boolean {
  if (!t) return false;
  if (t.kind === "optional") return isStringType(t.inner);
  return t.kind === "primitive" && t.name === "string";
}
