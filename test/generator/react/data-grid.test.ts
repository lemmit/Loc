// DataGrid — the TanStack-Table-backed grid primitive (React).
//
// The load-bearing structural fact is that DataGrid emits a CHILD COMPONENT at
// module scope rather than markup inline.  `useReactTable` is a hook, and a
// DataGrid almost always sits inside a `QueryView`'s `data:` slot, which the
// walker emits as a conditional expression — a hook cannot run there.  Nor can
// the hook be hoisted to the page component: it needs `rows`, which only exists
// inside the QueryView lambda.  And a component declared *inside* the page
// would get a fresh identity every render, remounting the grid and losing its
// sort state.
//
// The emitted shape is separately verified against the REAL compiler: generate
// the project, `npm i`, `tsc --noEmit` — clean.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const DOMAIN = `
  subdomain Sales {
    context Orders {
      aggregate Customer { name: string  tier: int }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
`;

const GRID = `QueryView { of: Sales.Customer.all, data: rows => DataGrid(
  Column("Name", o => o.name, sortable: true, filterable: true),
  Column("Tier", o => o.tier, sortable: true),
  rows: rows, multiSort: true, columnVisibility: true, pageSize: 25,
  testid: "customers-grid") }`;

async function genPage(body: string): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      ${DOMAIN}
      ui WebApp {
        api Sales: SalesApi
        page X { route: "/x"  body: ${body} }
      }
      deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
    }
  `);
  return files.get("web/src/pages/x.tsx")!;
}

describe("DataGrid — child-component emission", () => {
  it("hoists a generic child component to module scope, above the page", async () => {
    const page = await genPage(GRID);
    expect(page).toContain(
      "function CustomersGrid<T extends object>({ rows }: { rows: readonly T[] }) {",
    );
    // Module scope, not nested inside the page component.
    expect(page.indexOf("function CustomersGrid")).toBeLessThan(
      page.indexOf("export default function X()"),
    );
  });

  it("renders the child at the call site, inside the QueryView slot", async () => {
    const page = await genPage(GRID);
    expect(page).toContain("<CustomersGrid rows={customerAll.data.items} />");
  });

  it("names the component off `testid:` without stuttering", async () => {
    const page = await genPage(GRID);
    // `customers-grid` → `CustomersGrid`, never `CustomersGridGrid`.
    expect(page).not.toContain("CustomersGridGrid");
  });
});

describe("DataGrid — TanStack wiring", () => {
  it("builds column defs with accessorKey from simple accessors", async () => {
    const page = await genPage(GRID);
    expect(page).toContain(
      `{ id: "name", accessorKey: "name", header: "Name", enableSorting: true, enableColumnFilter: true },`,
    );
    // `sortable:` without `filterable:` must not enable filtering.
    expect(page).toContain(
      `{ id: "tier", accessorKey: "tier", header: "Tier", enableSorting: true, enableColumnFilter: false },`,
    );
  });

  it("wires multi-sort, page size and the row models", async () => {
    const page = await genPage(GRID);
    expect(page).toContain("enableMultiSort: true");
    expect(page).toContain("initialState: { pagination: { pageSize: 25 } }");
    expect(page).toContain("getSortedRowModel: getSortedRowModel(),");
    expect(page).toContain("getFilteredRowModel: getFilteredRowModel(),");
    // `rows` binds as readonly; TanStack's `data` is mutable.
    expect(page).toContain("data: (rows ?? []) as T[]");
  });

  it("imports from @tanstack/react-table", async () => {
    const page = await genPage(GRID);
    expect(page).toContain('from "@tanstack/react-table"');
    expect(page).toContain("useReactTable");
    expect(page).toContain("flexRender");
  });
});

describe("DataGrid — feature gating", () => {
  it("omits filter state and the filtered row model when no column is filterable", async () => {
    const page = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => DataGrid(
        Column("Name", o => o.name, sortable: true),
        rows: rows, testid: "plain-grid") }`,
    );
    expect(page).not.toContain("getFilteredRowModel");
    expect(page).not.toContain("ColumnFiltersState");
    // …and no dead visibility state either.
    expect(page).not.toContain("VisibilityState");
  });

  it("forces sort/filter off for a column whose field can't be resolved", async () => {
    // A formatting call has no simple member accessor, so there is no
    // accessorKey to sort or filter BY VALUE — the flags must not be emitted
    // as `true` and then silently ignored by TanStack.
    const page = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => DataGrid(
        Column("Name", o => Badge(o.name), sortable: true, filterable: true),
        rows: rows, testid: "computed-grid") }`,
    );
    expect(page).toContain("enableSorting: false");
    expect(page).toContain("enableColumnFilter: false");
  });
});

describe("DataGrid — Table is untouched", () => {
  it("a plain Table still renders inline, with no child component", async () => {
    const page = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => Table(
        Column("Name", o => o.name), rows: rows) }`,
    );
    expect(page).not.toContain("useReactTable");
    expect(page).not.toContain("@tanstack/react-table");
  });
});
