// M-T1.1 — client-side filterable Table on Angular (slice 7).
//
// A `Table` carrying a `filter:` page-state ref renders a `[value]`/`(input)`
// search box above the table and narrows the bound rows via the shared
// `filterRows` helper, which the page-shell re-exposes as a component member
// (Angular templates can only call members, not free imports).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function genFiles(body: string, state = `state { q: string = "" }`) {
  const files = await generateSystemFiles(`
    system S {
      subdomain Sales { context Orders {
        aggregate Customer { name: string  tier: int }
        repository Customers for Customer { } } }
      api SalesApi from Sales
      storage pg { type: postgres }
      ui WebApp {
        framework: angular
        api Sales: SalesApi
        page X { route: "/x"  ${state}  body: ${body} }
      }
      deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
    }
  `);
  for (const [k, v] of files) if (k.endsWith("x.component.ts")) return { content: v, files };
  throw new Error("no x.component.ts emitted");
}

describe("Table client-side filter (Angular)", () => {
  it("a `filter:` ref emits a [value]/(input) search box + a filterRows() member call", async () => {
    const { content, files } = await genFiles(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows, filter: q) }`,
    );
    expect(content).toContain(
      `<input type="search" [value]="q()" (input)="q.set($any($event.target).value)"`,
    );
    expect(content).toContain('data-testid="table-filter"');
    // Signals read with `()`; the helper is re-exposed + imported.
    expect(content).toContain("filterRows(customerAll.data()!.items, q())");
    expect(content).toContain(`import { filterRows } from "../../lib/table-sort";`);
    expect(content).toContain("protected readonly filterRows = filterRows;");
    expect(files.get("web/src/lib/table-sort.ts")).toContain("export function filterRows");
  });

  it("a Table without `filter:` is unaffected (no search box, no helper member)", async () => {
    const { content } = await genFiles(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows) }`,
      `state { }`,
    );
    expect(content).not.toContain('data-testid="table-filter"');
    expect(content).not.toContain("filterRows(");
  });
});
