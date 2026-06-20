import { upperFirst } from "../../util/naming.js";
import type { PageIR } from "../types/loom-ir.js";

/** The proper, aggregate-qualified identifier a page emits as in generated
 *  *target* code — the React/Vue/Angular component name, the Phoenix LiveView
 *  module / file stem, the Playwright page-object class, the smoke-test title,
 *  the router import.
 *
 *  Scaffold aggregate pages are named by *role* in the DSL (`page List` inside
 *  `area Orders`) so the file lands at its area path (`pages/orders/list.tsx`)
 *  and the unfolded source reads cleanly.  But the role name (`List`) is not
 *  unique across aggregates and reads poorly as a component identifier, so the
 *  emitted name stays the aggregate-qualified `OrderList` form it has always
 *  had — reconstructed here from the page's `origin`.  This keeps generated
 *  output byte-identical and matches the origin-bound router imports
 *  (`<OrderList />` from `./pages/orders/list`).
 *
 *  Non-aggregate scaffold pages (workflow / view / index singletons) and
 *  hand-written pages are not role-renamed, so they keep their declared name. */
export function pageEmitName(page: PageIR): string {
  const o = page.origin;
  if (o) {
    if (o.kind === "aggregate-list") return `${upperFirst(o.aggregateName)}List`;
    if (o.kind === "aggregate-new") return `${upperFirst(o.aggregateName)}New`;
    if (o.kind === "aggregate-detail") return `${upperFirst(o.aggregateName)}Detail`;
  }
  return page.name;
}
