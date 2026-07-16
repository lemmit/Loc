// M-T1.1 — client-side filterable Table on Svelte (slice 7).
//
// A `Table` carrying a `filter:` page-state ref renders a `bind:value` search
// box above the table and narrows the bound rows via the shared `filterRows`
// helper (svelte-check can't carry the inline `Object.values` cast).

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
        framework: svelte
        api Sales: SalesApi
        page X { route: "/x"  ${state}  body: ${body} }
      }
      deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
    }
  `);
  return files;
}

function pageOf(files: Map<string, string>): string {
  for (const [k, v] of files) if (k.endsWith("+page.svelte") && k.includes("/x")) return v;
  for (const [k, v] of files) if (k.endsWith("+page.svelte")) return v;
  throw new Error("no +page.svelte emitted");
}

describe("Table client-side filter (Svelte)", () => {
  it("a `filter:` ref emits a bind:value search box + a filterRows() call + the helper import", async () => {
    const files = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows, filter: q) }`,
    );
    const content = pageOf(files);
    expect(content).toContain(`<input type="search" bind:value={q} placeholder="Filter…"`);
    expect(content).toContain('data-testid="table-filter"');
    expect(content).toContain("filterRows(customerAll.data.items, q)");
    expect(content).toContain(`import { filterRows } from "$lib/table-sort";`);
    expect(files.get("web/src/lib/table-sort.ts")).toContain("export function filterRows");
  });

  it("a Table without `filter:` is unaffected (no search box, no helper import)", async () => {
    const files = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows) }`,
      `state { }`,
    );
    const content = pageOf(files);
    expect(content).not.toContain('data-testid="table-filter"');
    expect(content).not.toContain("filterRows(");
  });
});
