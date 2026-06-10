import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
} from "../../ir/types/loom-ir.js";
import { snake } from "../../util/naming.js";
import { joinRowClassName, rowClassName } from "./py-columns.js";
import { renderPyExpr } from "./render-expr.js";

// ---------------------------------------------------------------------------
// `where` predicate lowering — typed find-filter ExprIR → a SQLAlchemy
// boolean expression over the aggregate's Row class.  Covers exactly
// the queryable subset the IR validator (`firstNonQueryableNode`)
// admits: comparisons, &&/||/!, bare boolean columns, value-object
// sub-columns, enum values, parameters, literals, and
// `<refColl>.contains(x)` join-table membership (correlated EXISTS).
//
// The Python mirror of `lowerToDrizzle` / the .NET LINQ lowering —
// lowering never silently drops a predicate because the validator
// gated the expression shape first.
// ---------------------------------------------------------------------------

export interface PyPredicate {
  expr: string;
  /** sqlalchemy helpers the expression calls (`and_`, `or_`, `not_`,
   *  `select` for membership subqueries). */
  ops: Set<string>;
}

export function lowerToSqlAlchemy(
  e: ExprIR,
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
): PyPredicate | null {
  const ops = new Set<string>();
  const expr = lower(e, agg, ctx, ops);
  if (expr == null) return null;
  return { expr, ops };
}

function lower(
  e: ExprIR,
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  ops: Set<string>,
): string | null {
  const row = rowClassName(agg.name);
  switch (e.kind) {
    case "binary": {
      const l = lower(e.left, agg, ctx, ops);
      const r = lower(e.right, agg, ctx, ops);
      if (l == null || r == null) return null;
      if (e.op === "&&") {
        ops.add("and_");
        return `and_(${l}, ${r})`;
      }
      if (e.op === "||") {
        ops.add("or_");
        return `or_(${l}, ${r})`;
      }
      return `(${l} ${e.op} ${r})`;
    }
    case "unary": {
      const inner = lower(e.operand, agg, ctx, ops);
      if (inner == null) return null;
      if (e.op === "!") {
        ops.add("not_");
        return `not_(${inner})`;
      }
      return `${e.op}${inner}`;
    }
    case "paren":
      return lower(e.inner, agg, ctx, ops);
    case "ref":
      // `this.<col>` → the row column; everything else (params, lets,
      // enum values, currentUser) renders as a plain bind value.
      if (e.refKind === "this-prop" || e.refKind === "this-vo-prop") {
        return `${row}.${snake(e.name)}`;
      }
      return renderPyExpr(e);
    case "member": {
      // `this.<col>` and `this.<vo>.<sub>` (flattened VO column).
      if (e.receiver.kind === "this") {
        return `${row}.${snake(e.member)}`;
      }
      if (e.receiver.kind === "member" && e.receiver.receiver.kind === "this") {
        return `${row}.${snake(`${e.receiver.member}_${e.member}`)}`;
      }
      // Param member access (e.g. a VO param's field) — plain value.
      return renderPyExpr(e);
    }
    case "method-call": {
      // `this.<refColl>.contains(x)` → correlated EXISTS against the
      // field's join table.
      if (
        e.member === "contains" &&
        e.receiverType.kind === "array" &&
        e.receiverType.element.kind === "id" &&
        e.args.length === 1
      ) {
        const fieldName =
          e.receiver.kind === "ref"
            ? e.receiver.name
            : e.receiver.kind === "member" && e.receiver.receiver.kind === "this"
              ? e.receiver.member
              : null;
        const assoc = fieldName
          ? (agg.associations ?? []).find((a) => a.fieldName === fieldName)
          : undefined;
        const arg = lower(e.args[0]!, agg, ctx, ops);
        if (assoc && arg != null) {
          const join = joinRowClassName(assoc);
          ops.add("select");
          return `select(${join}).where(${join}.${assoc.ownerFk} == ${row}.id, ${join}.${assoc.targetFk} == ${arg}).exists()`;
        }
      }
      return null;
    }
    case "literal":
      return renderPyExpr(e);
    default:
      return null;
  }
}
