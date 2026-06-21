import {
  type AssociationIR,
  type EnrichedAggregateIR,
  type EnrichedBoundedContextIR,
  type ExprIR,
  exprUsesCurrentUser,
  type WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { tableOwnerName } from "../../ir/util/inheritance.js";
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
  // TPH concretes query the base's shared table.
  return lowerOver(e, rowClassName(tableOwnerName(agg, ctx.aggregates)), agg.associations ?? []);
}

/** Lower a workflow-sourced view's shorthand filter (workflow-instance-views.md)
 *  to a predicate over the saga-state `<Wf>Row`.  `this.<stateField>` refs bind
 *  to the row's columns exactly as an aggregate filter binds to its row; saga
 *  rows carry no reference collections, so the join-table `contains` arm never
 *  fires here. */
export function lowerWorkflowFilterToSqlAlchemy(e: ExprIR, wf: WorkflowIR): PyPredicate | null {
  return lowerOver(e, rowClassName(wf.name), []);
}

function lowerOver(e: ExprIR, row: string, associations: AssociationIR[]): PyPredicate | null {
  const ops = new Set<string>();
  const expr = lower(e, row, associations, ops);
  if (expr == null) return null;
  return { expr, ops };
}

function lower(
  e: ExprIR,
  row: string,
  associations: AssociationIR[],
  ops: Set<string>,
): string | null {
  switch (e.kind) {
    case "binary": {
      const l = lower(e.left, row, associations, ops);
      const r = lower(e.right, row, associations, ops);
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
      const inner = lower(e.operand, row, associations, ops);
      if (inner == null) return null;
      if (e.op === "!") {
        ops.add("not_");
        return `not_(${inner})`;
      }
      return `${e.op}${inner}`;
    }
    case "paren":
      return lower(e.inner, row, associations, ops);
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
        const assoc = fieldName ? associations.find((a) => a.fieldName === fieldName) : undefined;
        const arg = lower(e.args[0]!, row, associations, ops);
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

// ---------------------------------------------------------------------------
// Capability filters (`filter <expr>` → AggregateIR.contextFilters).
//
// SQLAlchemy has no global query filter (the EF Core `HasQueryFilter`
// analogue), so the generated repository must AND each predicate into every
// root-table read site (find_by_id / find_many_by_ids / all / find* / view
// finds / retrievals).  W1a wires only the NON-principal relational case
// (e.g. `filter !this.isDeleted`); principal-referencing filters
// (`currentUser.<field>`, tenancy) stay gated by the IR validator
// (`validateContextFilterSupport`) on python, so they never reach codegen
// here — they're filtered out below.
// ---------------------------------------------------------------------------

/** Lower an aggregate's NON-principal capability filters to a single
 *  SQLAlchemy predicate (conjoined with `and_(...)` when there is more than
 *  one), or null when the aggregate has no non-principal filter.  Mirrors
 *  node's `contextFilterPredicate`.  The principal-referencing subset is
 *  dropped (W1b) — what remains always lowers to a closed expression because
 *  the IR validator gated the queryable shape first; returns null (rather
 *  than throwing) on a non-lowerable predicate, which is unreachable for
 *  valid models. */
export function contextFilterPredicate(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
): PyPredicate | null {
  const nonPrincipal = (agg.contextFilters ?? []).filter((p) => !exprUsesCurrentUser(p));
  if (nonPrincipal.length === 0) return null;
  const ops = new Set<string>();
  const lowered: string[] = [];
  for (const p of nonPrincipal) {
    const l = lowerToSqlAlchemy(p, agg, ctx);
    if (!l) return null;
    for (const op of l.ops) ops.add(op);
    lowered.push(l.expr);
  }
  if (lowered.length === 1) return { expr: lowered[0]!, ops };
  ops.add("and_");
  return { expr: `and_(${lowered.join(", ")})`, ops };
}
