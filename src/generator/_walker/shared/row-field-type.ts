// Row-field TYPE lookups shared by the row-rendering primitives (`DataGrid`,
// `Table`).
//
// A page body carries no `receiverType`: inside a `data: rows => …` lambda every
// member read (`o.amount`) types as `string`, money and decimal included.  So a
// primitive that needs to know what a COLUMN really holds cannot ask the
// expression — it asks the ROW AGGREGATE the enclosing `QueryView` recorded
// (`ctx.listRowAggregates`), whose declared fields carry the real types.
//
// Both call sites need the identical answer for the identical reason (money and
// decimal are not plain comparables on any frontend — a `Decimal` object on the
// JS targets, the wire STRING on Flutter — so the default `a < b` comparator
// orders them wrongly), which is why the predicate lives here rather than twice.

import type { WalkContext } from "../walker-core.js";

/** The PRIMITIVE a row column reads, or undefined when it cannot be resolved
 *  (no recorded row aggregate, an unknown field, a non-primitive field).  The
 *  single resolution both predicates below are built on. */
export function rowFieldPrimitive(
  field: string | undefined,
  rowAggregate: string | undefined,
  ctx: WalkContext,
): string | undefined {
  if (!field || !rowAggregate) return undefined;
  const agg = ctx.aggregatesByName.get(rowAggregate);
  const t = agg?.fields.find((x) => x.name === field)?.type;
  const base = t?.kind === "optional" ? t.inner : t;
  return base?.kind === "primitive" ? base.name : undefined;
}

/** True when a column reads a `money`/`decimal` field — the two primitives the
 *  JS frontends hold as a decimal OBJECT whose `valueOf()` is a string, so the
 *  default `a < b` comparator orders them lexicographically.
 *
 *  Unresolvable → false, which keeps whatever the target's default comparator
 *  already did. */
export function isDecimalLikeField(
  field: string | undefined,
  rowAggregate: string | undefined,
  ctx: WalkContext,
): boolean {
  const p = rowFieldPrimitive(field, rowAggregate, ctx);
  return p === "money" || p === "decimal";
}

/** True when a column reads a `money` field specifically.
 *
 *  Narrower than `isDecimalLikeField` on purpose: on a target where `decimal`
 *  IS the host's numeric type but `money` is not (Flutter — `double` vs the
 *  wire String), only money needs the special comparator, and routing decimal
 *  through a money helper would re-quantize it to the money scale. */
export function isMoneyField(
  field: string | undefined,
  rowAggregate: string | undefined,
  ctx: WalkContext,
): boolean {
  return rowFieldPrimitive(field, rowAggregate, ctx) === "money";
}
