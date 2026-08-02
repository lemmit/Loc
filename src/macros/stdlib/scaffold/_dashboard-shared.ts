// ---------------------------------------------------------------------------
// Shared derivation between the two halves of the dashboard scaffold.
//
// `scaffoldDashboard` (a `context` macro) emits the singleton projections; the
// ui-side scaffold renders a `Stat` card per field.  A macro attaches to
// exactly ONE host (`MacroTarget`, define.ts), so the projection and the page
// cannot come from one macro — the same split `scaffoldPaged` /
// `scaffoldPagedApi` already uses, and the same defence: both sides derive the
// name here, so a card can never bind a projection the other half didn't emit.
// ---------------------------------------------------------------------------

import type { Aggregate, BoundedContext, Projection } from "../../../language/generated/ast.js";
import { isBoundedContext, isProjection, isProperty } from "../../../language/generated/ast.js";

/** The projection name the dashboard scaffold uses for an aggregate.
 *  `Order` → `OrderTotals`. */
export function dashboardProjectionName(aggName: string): string {
  return `${aggName}Totals`;
}

/** The KPI fields a dashboard card row shows for `agg`, or `null` when the
 *  aggregate has no dashboard projection to read.
 *
 *  TWO ways to find one, because macro expansion order is source order
 *  (`streamAllContents`, expander.ts) and therefore not something either half
 *  may rely on:
 *
 *    1. A projection ALREADY PRESENT in the context — always true for a
 *       hand-written one (it is authored source), and true for the scaffolded
 *       one whenever the context precedes the ui, which is the normal layout.
 *       Structural, so a hand-written projection lights up the dashboard too.
 *    2. Failing that, the context carrying `with scaffoldDashboard` — the
 *       clause is in the AST regardless of who has expanded yet, which closes
 *       the ordering hole for a ui declared before its context.
 *
 *  Both paths derive the same name, so the card and the projection agree. */
export function dashboardFieldsFor(
  agg: Aggregate,
): { projection: string; fields: string[] } | null {
  const ctx = agg.$container;
  if (!isBoundedContext(ctx)) return null;
  const name = dashboardProjectionName(agg.name);
  const declared = ctx.members.find((m): m is Projection => isProjection(m) && m.name === name);
  if (declared) {
    // Only a SINGLETON query-time projection returns one row, which is what a
    // KPI card binds.  A keyed one returns a list.
    if (declared.key || !declared.source) return null;
    return { projection: name, fields: declared.members.filter(isProperty).map((p) => p.name) };
  }
  if (!contextScaffoldsDashboard(ctx)) return null;
  // The context will emit it; derive the field list the same way the macro
  // does, from the aggregate itself.
  return { projection: name, fields: scaffoldedFieldNames(agg) };
}

/** Whether the context opted into `with scaffoldDashboard`. */
function contextScaffoldsDashboard(ctx: BoundedContext): boolean {
  return (ctx.withClause?.calls ?? []).some((c) => c.name === "scaffoldDashboard");
}

/** The field names `scaffoldDashboard` emits for an aggregate — the row count
 *  plus one sum per summable field.  Kept beside the macro's own derivation so
 *  the two can only drift by an edit that touches this file. */
function scaffoldedFieldNames(agg: Aggregate): string[] {
  return [ROW_COUNT, ...summableFieldNames(agg).map((f) => `${f}Sum`)];
}

/** The row-count field.  Named `rowCount`, not `count`: a field named after the
 *  operator that fills it reads as `select count = count()`, and shadows the
 *  operator name inside the projection's own scope. */
export const ROW_COUNT = "rowCount";

/** The source alias every emitted projection binds — `from <Agg> as o`. */
export const ALIAS = "o";

/** Fields worth summing on a dashboard: the numeric ones.  A `money` total is
 *  the canonical KPI; `int`/`long`/`decimal` are the other honest sums.
 *  Everything else (strings, enums, dates, ids, collections) has no meaningful
 *  whole-table sum, so it contributes no tile rather than a nonsense one. */
export type Summable = "money" | "int" | "long" | "decimal";
const SUMMABLE: ReadonlySet<string> = new Set<Summable>(["money", "int", "long", "decimal"]);

export function summableFields(agg: Aggregate): Array<{ name: string; primitive: Summable }> {
  const out: Array<{ name: string; primitive: Summable }> = [];
  for (const m of agg.members) {
    if (!isProperty(m)) continue;
    const t = m.type;
    // A `TypeRef` wraps the atom: `array`/`optional` live on the ref, the
    // primitive name on its `base`.  Only a BARE primitive sums.
    //
    // The optional exclusion is deliberate, not an oversight: SQL `SUM` skips
    // NULLs, so a nullable column's tile would silently describe a subset of
    // the rows the `rowCount` beside it reports — two numbers on one card that
    // quietly disagree about which rows they cover.
    if (!t || t.array || t.optional) continue;
    const base = t.base;
    if (base?.$type !== "PrimitiveType") continue;
    if (!SUMMABLE.has(base.name)) continue;
    out.push({ name: m.name, primitive: base.name as Summable });
  }
  return out;
}

function summableFieldNames(agg: Aggregate): string[] {
  return summableFields(agg).map((f) => f.name);
}
