// M-T1.1 — client-side sortable Table columns on Vue.
//
// Vue's strict template can't carry React's inline `as`-cast comparator, so
// `renderSortedRows` calls the shared `sortRows` helper (emitted as
// `src/lib/table-sort.ts`) and the page imports it. Headers bind `@click`
// with in-place state writes; the indicator is a `{{ }}` interpolation.
// Verified end-to-end: `vue-tsc --noEmit` + `vite build` both pass on the
// generated project (the LOOM_VUE_BUILD gate covers the compile tier).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function genPage(
  body: string,
  state = `state { sortKey: string = ""  sortDir: string = "asc" }`,
) {
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

describe("Table client-side sort (Vue)", () => {
  it("sortable columns emit @click headers + a sortRows() call + the helper import", async () => {
    const files = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name, sortable: true),
        Column("Tier", o => o.tier, sortable: true),
        rows: rows, sortKey: sortKey, sortDir: sortDir) }`,
    );
    const content = files.get("web/src/pages/x.vue")!;
    // @click header with in-place state writes.
    expect(content).toContain(
      `@click="sortKey === 'name' ? (sortDir = sortDir === 'asc' ? 'desc' : 'asc') : (sortKey = 'name', sortDir = 'asc')"`,
    );
    // {{ }} indicator.
    expect(content).toContain(`{{ sortKey === 'name' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '' }}`);
    // v-for over the shared helper (no inline dynamic-index — strict vue-tsc).
    expect(content).toMatch(
      /v-for="\(row\) in sortRows\(customerAll\.data\.items, sortKey, sortDir\)"/,
    );
    // Helper imported.
    expect(content).toContain(`import { sortRows } from "../lib/table-sort";`);
    // Helper module emitted.
    expect(files.get("web/src/lib/table-sort.ts")).toContain("export function sortRows");
  });

  it("a Table without sort args imports no helper and renders a plain header", async () => {
    const files = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows) }`,
      `state { }`,
    );
    const content = files.get("web/src/pages/x.vue")!;
    expect(content).not.toContain("sortRows(");
    expect(content).not.toContain("table-sort");
    expect(content).toMatch(/>Name</);
  });
});
