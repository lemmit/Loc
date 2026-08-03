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

/** True when ANY page of a ui uses `DataGrid`. */
export function uiUsesDataGrid(ui: UiIR): boolean {
  return ui.pages.some((p) => bodyUsesDataGrid(p.body));
}
