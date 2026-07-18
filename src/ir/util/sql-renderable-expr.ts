import type { ExprIR } from "../types/loom-ir.js";

// ---------------------------------------------------------------------------
// The SQL-renderable expression subset (M-T2.3 data-migration surface).
//
// Pure predicate over ExprIR — the honest gate backing
// `loom.migration-expr-unsupported`.  Lives in `ir/util` (not next to the
// renderer in `generator/`) because the IR validator consumes it and
// `ir → generator` is a forbidden backward edge; the renderer
// (`src/generator/sql-pg-expr.ts`) imports it forward and MUST stay in
// lockstep: everything this admits, the renderer renders.
// ---------------------------------------------------------------------------

/** Is `e` inside the SQL-renderable subset a backfill expression may use?
 *  `true`, or the reason it is not — surfaced verbatim by the
 *  `loom.migration-expr-unsupported` validator so the user sees *why* the
 *  expression can't backfill.
 *
 *  Supported: literals, enum values, sibling-field refs (`this-prop`),
 *  parens, unary, the closed BinOp set, ternary.  Value-object leaves are
 *  excluded — Phoenix stores a VO as one `:map` column, so a leaf-column
 *  reference would not be portable across backends. */
export function sqlRenderableExpr(e: ExprIR): true | { reason: string } {
  switch (e.kind) {
    case "literal":
      return true;
    case "ref":
      if (e.refKind === "enum-value") return true;
      if (e.refKind === "this-prop") return true;
      if (e.refKind === "this-vo-prop") {
        return {
          reason:
            "value-object fields cannot be referenced in a backfill (Phoenix stores a value object as a single map column, so a leaf-column reference is not portable)",
        };
      }
      return { reason: `'${e.name}' does not resolve to a sibling field of the aggregate` };
    case "paren":
      return sqlRenderableExpr(e.inner);
    case "unary":
      return sqlRenderableExpr(e.operand);
    case "binary": {
      const l = sqlRenderableExpr(e.left);
      if (l !== true) return l;
      return sqlRenderableExpr(e.right);
    }
    case "ternary": {
      const c = sqlRenderableExpr(e.cond);
      if (c !== true) return c;
      const t = sqlRenderableExpr(e.then);
      if (t !== true) return t;
      return sqlRenderableExpr(e.otherwise);
    }
    default:
      return {
        reason: `'${e.kind}' expressions are not supported in a backfill — use literals, sibling fields, arithmetic/comparison operators, or a raw sql step`,
      };
  }
}
