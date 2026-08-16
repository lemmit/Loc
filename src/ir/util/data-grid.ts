// `DataGrid` presence in a page body — one predicate, two consumers.
//
// The IR validator gates `DataGrid` on frontends without a
// `renderDataGridChild` seam (`loom.datagrid-unsupported-target`), and the
// Feliz emitter needs the same answer BEFORE walking a body, to decide whether
// the emitted `package.json` carries `@tanstack/table-core`.  Two copies of a
// "does this page use a grid" scan is one too many, so it lives here — in
// `ir/util`, which both the validator and the generators sit above.

import type { ExprIR, UiIR } from "../types/loom-ir.js";
import { walkExprDeep } from "./walk.js";

/** True when a page body contains a `DataGrid(...)` primitive call anywhere. */
export function bodyUsesDataGrid(body: ExprIR | undefined): boolean {
  let found = false;
  walkExprDeep(body, (e) => {
    if (e.kind === "call" && e.name === "DataGrid") found = true;
  });
  return found;
}

/** The ui's `DataGrid`-bearing hosts, labelled for a diagnostic —
 *  `page 'X'` / `component 'Y'`.
 *
 *  Components render INTO pages, so a grid moved into one is exactly as
 *  unrenderable on a target without the seam as a grid written inline; a
 *  page-only scan let it through silently (flutter emitted
 *  `SizedBox.shrink()`, heex an unsupported-primitive comment).  Same body
 *  coverage as `validateChartSupport` / `validateUiProjectionReadFramework`. */
export function dataGridHosts(ui: UiIR): string[] {
  return [
    ...ui.pages.filter((p) => bodyUsesDataGrid(p.body)).map((p) => `page '${p.name}'`),
    ...ui.components.filter((c) => bodyUsesDataGrid(c.body)).map((c) => `component '${c.name}'`),
  ];
}

/** True when ANY page OR component of a ui uses `DataGrid`. */
export function uiUsesDataGrid(ui: UiIR): boolean {
  return dataGridHosts(ui).length > 0;
}
