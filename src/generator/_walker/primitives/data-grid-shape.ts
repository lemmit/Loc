// The ctx-free SHAPE questions about a `DataGrid(...)` call node — what a
// `Column`'s accessor key is, and whether any column asked to be filtered.
//
// WHY THIS IS ITS OWN LEAF
// ------------------------
// Two passes need the same answer and must not drift:
//
//   - the EMITTER (`data-grid.ts` → `resolveColumn`) turns `filterable:` into
//     TanStack's `enableColumnFilter` and the grid-wide `hasFilters` flag the
//     pack templates gate their per-column filter input on;
//   - the i18n EXTRACTOR (`i18n-chrome.ts` → `CHROME_BY_PRIMITIVE.DataGrid`)
//     decides whether this grid contributes the `chrome.filter` placeholder
//     entry to the message catalog.
//
// If those disagreed the app would emit a `t("chrome.filter", …)` binding with
// no catalog entry (untranslatable in every locale) or carry a catalog key
// nothing renders (a phantom string for translators).  Neither is visible to a
// structural test, so the predicate lives in ONE place both import.
//
// Deliberately ctx-free — the extractor walks raw `ExprIR` with no
// `WalkContext` — which is also why the richer column facts that DO need one
// (`numericSort`'s money/decimal lookup, a computed cell's markup) stay in
// `data-grid.ts`.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { boolNamed, positionalArgs, stringNamed } from "../shared/args.js";

/** `o => o.sku` → `"sku"`.  Undefined for anything more complex. */
export function simpleAccessorField(accessor: ExprIR | undefined): string | undefined {
  if (accessor?.kind !== "lambda") return undefined;
  const body = accessor.body;
  if (body?.kind === "member" && body.receiver.kind === "ref") return body.member;
  return undefined;
}

/** The TanStack `accessorKey` for one `Column("Header", accessor, field:)` —
 *  the explicit `field:` when given, else the field a simple member accessor
 *  reads.  Undefined for a computed cell, which has no value to sort or filter
 *  BY, so both flags are forced off against it. */
export function columnAccessorKey(column: ExprIR & { kind: "call" }): string | undefined {
  return stringNamed(column, "field") ?? simpleAccessorField(positionalArgs(column)[1]);
}

/** True when this `Column(...)` renders a per-column filter input: it asked for
 *  `filterable: true` AND resolves to a value the filter can read. */
export function columnIsFilterable(column: ExprIR & { kind: "call" }): boolean {
  return boolNamed(column, "filterable") && columnAccessorKey(column) !== undefined;
}

/** True when this `Column(...)` renders a clickable SORT header: it asked for
 *  `sortable: true` AND resolves to a value TanStack can order by.  Mirrors
 *  `resolveColumn`'s own `sortable` exactly — a column with no resolvable field
 *  has the flag forced off rather than emitted and silently ignored. */
export function columnIsSortable(column: ExprIR & { kind: "call" }): boolean {
  return boolNamed(column, "sortable") && columnAccessorKey(column) !== undefined;
}

/** The `Column(...)` positional args of a `DataGrid(...)` call. */
export function gridColumns(grid: ExprIR & { kind: "call" }): (ExprIR & { kind: "call" })[] {
  return positionalArgs(grid).filter(
    (a): a is ExprIR & { kind: "call" } => a.kind === "call" && a.name === "Column",
  );
}

/** True when ANY column of this grid is filterable — the grid-wide switch that
 *  turns the pack's per-column filter row (and its "Filter" placeholder) on. */
export function gridHasFilterableColumn(grid: ExprIR & { kind: "call" }): boolean {
  return gridColumns(grid).some(columnIsFilterable);
}

/** True when ANY column of this grid is sortable — the grid-wide switch behind
 *  the pack's sort BUTTON, and therefore behind its "Sort by {column}" name. */
export function gridHasSortableColumn(grid: ExprIR & { kind: "call" }): boolean {
  return gridColumns(grid).some(columnIsSortable);
}
