// M-T1.1 — client-side filterable Table on Vue (slice 7).
//
// A `Table` carrying a `filter:` page-state ref renders a `v-model` search box
// above the table and narrows the bound rows via the shared `filterRows`
// helper (Vue's strict template can't carry the inline `Object.values` cast).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function genPage(body: string, state = `state { q: string = "" }`) {
  const files = await generateSystemFiles(`
    system S {
      subdomain Sales { context Orders {
        aggregate Customer { name: string  tier: int }
        repository Customers for Customer { } } }
      api SalesApi from Sales
      storage pg { type: postgres }
      ui WebApp {
        framework: vue
        api Sales: SalesApi
        page X { route: "/x"  ${state}  body: ${body} }
      }
      deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
    }
  `);
  return files;
}

describe("Table client-side filter (Vue)", () => {
  it("a `filter:` ref emits a v-model search box + a filterRows() call + the helper import", async () => {
    const files = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows, filter: q) }`,
    );
    const content = files.get("web/src/pages/x.vue")!;
    expect(content).toContain(`<input type="search" v-model="q" placeholder="Filter…"`);
    expect(content).toContain('data-testid="table-filter"');
    // Rows filtered via the shared helper (ref auto-unwraps in the template).
    expect(content).toContain("filterRows(customerAll.data.items, q)");
    // The helper module is emitted and imported.
    expect(content).toContain(`import { filterRows } from "../lib/table-sort";`);
    expect(files.get("web/src/lib/table-sort.ts")).toContain("export function filterRows");
  });

  it("a Table without `filter:` is unaffected (no search box, no helper import)", async () => {
    const files = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows) }`,
      `state { }`,
    );
    const content = files.get("web/src/pages/x.vue")!;
    expect(content).not.toContain('data-testid="table-filter"');
    expect(content).not.toContain("filterRows(");
  });
});
