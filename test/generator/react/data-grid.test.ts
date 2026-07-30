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

async function genPage(body: string, state = ""): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      ${DOMAIN}
      ui WebApp {
        api Sales: SalesApi
        page X { route: "/x"  ${state}  body: ${body} }
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

  it("falls back to a sequence when the derived name collides with the page", async () => {
    // REGRESSION: `page ProjectsGrid` + `testid: "projects-grid"` both derive
    // `ProjectsGrid`, and React hoists the child into the page's OWN file — so
    // the file declared the name twice (`Duplicate function implementation`).
    // Found by putting a DataGrid in `showcase.ddd` and compiling it.
    const files = await generateSystemFiles(`
      system S {
        ${DOMAIN}
        ui WebApp {
          api Sales: SalesApi
          page CustomersGrid { route: "/g"  body: ${GRID} }
        }
        deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
      }
    `);
    const page = files.get("web/src/pages/customers_grid.tsx")!;
    expect(page).toContain("export default function CustomersGrid()");
    // The child took the sequence name instead of colliding.
    expect(page).toContain("function LoomGrid1<T extends object>");
    expect(page).toContain("<LoomGrid1 rows={customerAll.data.items} />");
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

  it("binds the row into a computed cell, and casts it once", async () => {
    // REGRESSION: the first cut emitted `cell: () => <Badge>{row.name}</Badge>`
    // with `row` UNBOUND, so any grid with a formatting accessor failed `tsc`.
    // It shipped because the sort/filter assertions below never compiled the
    // emitted file — the generated-project `tsc` gate has no computed-cell grid.
    const page = await genPage(
      `QueryView { of: Sales.Customer.all, data: rows => DataGrid(
        Column("Name", o => Badge(o.name)),
        Column("Tier", o => o.tier, sortable: true),
        rows: rows, testid: "computed-grid") }`,
    );
    expect(page).toContain(
      "cell: ({ row }) => { const __loomRow = row.original as CellRow; " +
        "return <Badge>{__loomRow.name}</Badge>; }",
    );
    // The cast type is declared once per grid, and only when a cell needs it.
    expect(page).toContain("type CellRow = Record<string, any>;");
    const plain = await genPage(GRID);
    expect(plain).not.toContain("CellRow");
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

// -------------------------------------------------------------------------
// Row selection — `selection: <string[] state field>`.
//
// Selection is the ONE piece of grid view-state the page can read (a sibling
// "Delete selected (3)" has a real need for it; sort/filter/visibility are
// opaque).  The wiring crosses the module boundary: TanStack's selection MAP
// lives in the hoisted child, the id LIST lives in the page's `useState`, and
// a `useEffect` bridges them via the setter threaded in as a prop.
// -------------------------------------------------------------------------

const SEL_STATE = "state { picked: string[] }";

const SEL_GRID = `Stack(
  Text("count: {picked.length}"),
  QueryView { of: Sales.Customer.all, data: rows => DataGrid(
    Column("Name", o => o.name, sortable: true),
    rows: rows, selection: picked, testid: "sel-grid") })`;

describe("DataGrid — row selection", () => {
  it("threads the page's state setter in as a prop", async () => {
    const page = await genPage(SEL_GRID, SEL_STATE);
    expect(page).toContain(
      "function SelGrid<T extends object>({ rows, onSelectionChange }: " +
        "{ rows: readonly T[]; onSelectionChange: (ids: string[]) => void }) {",
    );
    expect(page).toContain(
      "<SelGrid rows={customerAll.data.items} onSelectionChange={setPicked} />",
    );
    // The page still owns the id list.
    expect(page).toContain("const [picked, setPicked] = useState<string[]>([]);");
  });

  it("owns TanStack's selection map in the child and enables row selection", async () => {
    const page = await genPage(SEL_GRID, SEL_STATE);
    expect(page).toContain(
      "const [rowSelection, setRowSelection] = useState<RowSelectionState>({});",
    );
    expect(page).toContain("onRowSelectionChange: setRowSelection,");
    expect(page).toContain("enableRowSelection: true,");
    expect(page).toContain("type RowSelectionState");
  });

  it("emits a leading checkbox column, walker-rendered so no pack template is needed", async () => {
    const page = await genPage(SEL_GRID, SEL_STATE);
    expect(page).toContain(`id: "loom-select",`);
    // Plain <input>, not a pack component — this is the one cell whose
    // BEHAVIOUR (not appearance) is load-bearing, and keeping it out of the
    // pack means selection ports to every pack and framework unchanged.
    expect(page).toContain('type="checkbox"');
    expect(page).toContain("t.getToggleAllPageRowsSelectedHandler()");
    expect(page).toContain("row.getToggleSelectedHandler()");
    // The select column is never sortable or filterable.
    expect(page).toContain("enableSorting: false");
    // …and it leads the column list.
    expect(page.indexOf(`id: "loom-select"`)).toBeLessThan(page.indexOf(`id: "name"`));
  });

  it("syncs selected row ids back to the page on every selection change", async () => {
    const page = await genPage(SEL_GRID, SEL_STATE);
    expect(page).toContain("onSelectionChange(");
    expect(page).toContain(
      ".rows.map((r) => String((r.original as { id?: unknown }).id ?? r.index)),",
    );
    // Keyed on the selection map only, so it fires once per selection change.
    expect(page).toContain("}, [rowSelection]);");
  });

  it("emits ONE react import line when the page has state and the grid has hooks", async () => {
    // The shell builds its own react import; the hoisted child registers
    // useMemo/useState/useEffect through `addImport`.  Two lines would be a
    // duplicate-identifier error.
    const page = await genPage(SEL_GRID, SEL_STATE);
    const reactImports = page.split("\n").filter((l) => l.endsWith(`from "react";`));
    // The shell's own order comes first (it is load-bearing for existing
    // output bytes); body specifiers append.
    expect(reactImports).toEqual(['import { useState, useEffect, useMemo } from "react";']);
  });

  it("emits no selection wiring when `selection:` is absent", async () => {
    const page = await genPage(GRID);
    expect(page).not.toContain("RowSelectionState");
    expect(page).not.toContain("loom-select");
    expect(page).not.toContain("onSelectionChange");
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
