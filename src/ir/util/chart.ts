// `Chart` presence in a page/component body — one predicate, two consumers.
//
// The IR validator gates `Chart` on targets without the mantine@v9 template
// (`loom.chart-unsupported-target`), and the React emitter needs the same
// answer to decide whether the emitted `package.json` carries the chart
// dependency (`@mantine/charts` + its recharts peer — the `usesChart`
// template flag, mirroring `usesMoney`).  Two copies of a "does this ui use
// a chart" scan is one too many, so it lives here — in `ir/util`, which both
// the validator and the generators sit above.  Sibling of `data-grid.ts`,
// which plays the same role for `DataGrid`.

import type { ExprIR, UiIR } from "../types/loom-ir.js";
import { walkExprDeep } from "./walk.js";

/** True when a page/component body contains a `Chart(...)` primitive call
 *  anywhere. */
export function bodyUsesChart(body: ExprIR | undefined): boolean {
  let found = false;
  walkExprDeep(body, (e) => {
    if (e.kind === "call" && e.name === "Chart") found = true;
  });
  return found;
}

/** True when ANY page or ui-scoped component of a ui uses `Chart`. */
export function uiUsesChart(ui: UiIR): boolean {
  return (
    ui.pages.some((p) => bodyUsesChart(p.body)) || ui.components.some((c) => bodyUsesChart(c.body))
  );
}
