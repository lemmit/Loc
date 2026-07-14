// M-T1.1 — client-side sortable Table columns on Svelte.
//
// Like Vue, Svelte's strict `svelte-check` can't index a typed row by a
// dynamic string key inline, so `renderSortedRows` calls the shared `sortRows`
// helper (`$lib/table-sort`). Headers bind `onclick` with in-place `$state`
// writes; the indicator is a `{ }` interpolation. Verified end-to-end:
// `svelte-check` (0 errors) + `vite build` both pass on the generated project.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function genFiles(
  body: string,
  state = `state { sortKey: string = ""  sortDir: string = "asc" }`,
) {
  return generateSystemFiles(`
    system S {
      subdomain Sales { context Orders {
        aggregate Customer { name: string  tier: int }
        repository Customers for Customer { } } }
      api SalesApi from Sales
      storage pg { type: postgres }
      ui WebApp {
        framework: svelte
        api Sales: SalesApi
        page X { route: "/x"  ${state}  body: ${body} }
      }
      deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
    }
  `);
}

function pageOf(files: Map<string, string>): string {
  for (const [k, v] of files) if (k.endsWith("+page.svelte") && k.includes("/x")) return v;
  // route dir is the page's slug ("x")
  for (const [k, v] of files) if (k.endsWith("+page.svelte")) return v;
  throw new Error("no +page.svelte emitted");
}

describe("Table client-side sort (Svelte)", () => {
  it("sortable columns emit onclick headers + a sortRows() call + the helper import", async () => {
    const files = await genFiles(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name, sortable: true),
        Column("Tier", o => o.tier, sortable: true),
        rows: rows, sortKey: sortKey, sortDir: sortDir) }`,
    );
    const content = pageOf(files);
    expect(content).toContain(
      `onclick={() => { if (sortKey === "name") { sortDir = sortDir === "asc" ? "desc" : "asc"; } else { sortKey = "name"; sortDir = "asc"; } }}`,
    );
    expect(content).toContain(`{sortKey === "name" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}`);
    expect(content).toContain("sortRows(customerAll.data.items, sortKey, sortDir)");
    expect(content).toContain(`import { sortRows } from "$lib/table-sort";`);
    expect(files.get("web/src/lib/table-sort.ts")).toContain("export function sortRows");
  });

  it("a Table without sort args imports no helper", async () => {
    const files = await genFiles(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows) }`,
      `state { }`,
    );
    const content = pageOf(files);
    expect(content).not.toContain("sortRows(");
    expect(content).not.toContain("table-sort");
  });
});
