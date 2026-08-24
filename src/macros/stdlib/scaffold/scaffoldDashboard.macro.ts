import type { ContextMember, Expression, Property } from "../../../language/generated/ast.js";
import { isAggregate } from "../../../language/generated/ast.js";
import type { Aggregate, BoundedContext } from "../../api/index.js";
import {
  callExpr,
  defineMacro,
  field,
  memberAccess,
  nameRefExpr,
  primType,
  singletonProjection,
} from "../../api/index.js";
import {
  ALIAS,
  dashboardProjectionName,
  dashboardSeriesName,
  hasDashboardTable,
  ROW_COUNT,
  SERIES_COUNT,
  SERIES_DAY,
  seriesDateField,
  summableFields,
} from "./_dashboard-shared.js";

/** Emit the read model a DASHBOARD reads: one SINGLETON query-time
 * `projection` per aggregate, aggregating the whole table in SQL.
 *
 *   context Sales with scaffoldDashboard {
 *     aggregate Order { code: string  total: money  lineCount: int  … }
 *   }
 *
 *   ↓ Sales gains
 *
 *   projection OrderTotals {
 *     count: int
 *     totalSum: money
 *     lineCountSum: int
 *     from Order as o
 *     select count = count, totalSum = sum(o.total), lineCountSum = sum(o.lineCount)
 *   }
 *
 * Why a projection and not a page-side fold: `.all` is paged by default
 * (M-T2.6), so counting rows in the browser counts ONE PAGE — and the numbers
 * belong in the database anyway.  A whole-table aggregation is one `SELECT`
 * with `COUNT(*)`/`SUM(...)` and no rows materialised (M-T1.3 Phase 0).
 *
 * ONE PROJECTION PER AGGREGATE, not one per context: a query-time projection
 * has a single `from` source, so a per-context row would have nothing to
 * aggregate over.
 *
 * Pairs with the ui-side scaffold, which renders a `Stat` card per field from
 * the SAME derivation (`_dashboard-shared.ts`) — so a card can never bind a
 * projection this macro didn't emit.  The ui side detects the projection
 * STRUCTURALLY (a singleton query-time projection over the aggregate) rather
 * than by trusting this macro ran, so a hand-written one lights up the
 * dashboard too. */
export default defineMacro({
  name: "scaffoldDashboard",
  target: "context",
  apiVersion: 1,
  description:
    "Emits one singleton query-time projection per aggregate — a row count plus " +
    "a sum per numeric/money field — aggregated in SQL, for a dashboard to read.",
  params: {},
  expand({ target }) {
    const ctx = target as BoundedContext;
    const out: ContextMember[] = [];
    for (const decl of ctx.members) {
      if (!isAggregate(decl)) continue;
      const agg = decl as Aggregate;
      // Nothing this macro may aggregate over — an abstract base
      // (aggregate-inheritance.md: its concretes carry their own projections),
      // an event-sourced stream, or a `shape: document` blob whose only
      // nameable column is `id`.  Every tile here is a direct-table
      // aggregation, so each of those would be refused downstream
      // (`loom.projection-columnless-source`, or — for a filtered document
      // source — `loom.projection-document-source-capability-filtered`, or on
      // java `loom.projection-whole-table-aggregation-unsupported#document`).
      // Shared with the ui half (`dashboardFieldsFor`) so a card can never bind
      // a projection this macro skipped.
      if (!hasDashboardTable(agg)) continue;
      const projName = dashboardProjectionName(agg.name);
      // Skip when the context already declares that name: a hand-written
      // projection wins over the scaffold, and re-emitting would be a
      // duplicate-declaration error rather than a merge.
      if (ctx.members.some((d) => "name" in d && d.name === projName)) continue;

      const members: Property[] = [field(ROW_COUNT, primType("int"))];
      const selects: Array<{ field: string; expr: Expression }> = [
        // `count()` — the row count, `COUNT(*)`, no column.  Written in CALL
        // form rather than as a bare `count` ref for two reasons: it matches
        // the other selects, and a macro-built bare `NameRef` does not lower to
        // the unknown-ref shape a parsed one does, so the aggregation would go
        // unrecognised and the projection would look like a GROUP BY.
        { field: ROW_COUNT, expr: callExpr("count", []) },
      ];
      // `summableFields` is empty for a `shape: document` aggregate — its
      // declared fields live inside the jsonb blob, not as columns.  Belt and
      // braces: `hasDashboardTable` above already skipped that aggregate
      // entirely, so this loop never sees one.
      for (const f of summableFields(agg)) {
        members.push(field(`${f.name}Sum`, primType(f.primitive)));
        selects.push({
          field: `${f.name}Sum`,
          expr: callExpr("sum", [{ value: memberAccess(nameRefExpr(ALIAS), f.name) }]),
        });
      }
      out.push(singletonProjection(projName, agg.name, ALIAS, members, selects));

      // The per-day SERIES beside the totals (M-T1.3 Phase 5): one row per day
      // with that day's count — what a dashboard chart plots.  It rides the
      // GROUPED read model (M-T4.2) with the catalogued
      // `datetime.startOfDay()` key, so buckets are cut by `date_trunc('day',
      // …)` in SQL rather than by loading rows and grouping in the browser.
      //
      // Emitted only when the aggregate HAS a datetime column to group on; the
      // ui side derives the same answer, so it renders no chart tile rather
      // than binding a projection that was never emitted.
      const dateField = seriesDateField(agg);
      if (!dateField) continue;
      const seriesName = dashboardSeriesName(agg.name);
      if (ctx.members.some((d) => "name" in d && d.name === seriesName)) continue;
      // Built TWICE rather than shared: an AST node has one container, and the
      // `group by` entry and the `select` expression are two positions in the
      // tree — reusing one node would re-parent it.  The select↔group-by match
      // compares structure, so two identical trees are the same key.
      const dayBucket = () =>
        memberAccess(memberAccess(nameRefExpr(ALIAS), dateField), "startOfDay", { call: true });
      out.push(
        singletonProjection(
          seriesName,
          agg.name,
          ALIAS,
          [field(SERIES_DAY, primType("datetime")), field(SERIES_COUNT, primType("int"))],
          [
            { field: SERIES_DAY, expr: dayBucket() },
            { field: SERIES_COUNT, expr: callExpr("count", []) },
          ],
          { groupBys: [dayBucket()] },
        ),
      );
    }
    return out;
  },
});
