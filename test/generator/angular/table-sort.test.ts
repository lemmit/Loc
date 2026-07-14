// M-T1.1 — client-side sortable Table columns on Angular.
//
// Angular templates can only call component members (not free imports), so the
// shared `sortRows` helper is imported and re-exposed as a `protected readonly`
// field (the same lift the format helpers use). Signals read as `sortKey()` and
// write as `sortKey.set(…)`; the `(click)` header sets the direction (reading
// the old sortKey) then the column. Verified end-to-end: `ng build` passes on
// the generated project (strict template typecheck + bundle).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function genComponent(
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

describe("Table client-side sort (Angular)", () => {
  it("sortable columns emit (click) headers + a sortRows() call re-exposed as a member", async () => {
    const { content, files } = await genComponent(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name, sortable: true),
        Column("Tier", o => o.tier, sortable: true),
        rows: rows, sortKey: sortKey, sortDir: sortDir) }`,
    );
    // (click) two-statement toggle with signal set().
    expect(content).toContain(
      `(click)="sortDir.set(sortKey() === 'name' ? (sortDir() === 'asc' ? 'desc' : 'asc') : 'asc'); sortKey.set('name')"`,
    );
    // {{ }} indicator with signal reads.
    expect(content).toContain(
      `{{ sortKey() === 'name' ? (sortDir() === 'asc' ? ' ↑' : ' ↓') : '' }}`,
    );
    // @for over the helper (signals read with ()).
    expect(content).toContain("sortRows(");
    expect(content).toContain("sortKey(), sortDir())");
    // Helper imported + re-exposed as a member.
    expect(content).toContain(`import { sortRows } from "../../lib/table-sort";`);
    expect(content).toContain("protected readonly sortRows = sortRows;");
    expect(files.get("web/src/lib/table-sort.ts")).toContain("export function sortRows");
  });

  it("a Table without sort args re-exposes no helper", async () => {
    const { content } = await genComponent(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name),
        rows: rows) }`,
      `state { }`,
    );
    expect(content).not.toContain("sortRows");
    expect(content).not.toContain("table-sort");
  });
});
