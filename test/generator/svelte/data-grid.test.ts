// DataGrid on Svelte — the third `renderDataGridChild` target, and the one that
// forced the seam down a layer.
//
// `@tanstack/svelte-table` (the official adapter, stable at 8.21) peers on
// `svelte: ^4 || ^3.49` — it predates runes, and the generated stack is Svelte
// 5.  Svelte 5 support exists only in `9.0.0-beta`, whose API is different
// (`createTable` + a `_features` array, no row-model functions), which would
// make the Svelte grid behave differently from React's and Vue's.
//
// So this target uses `@tanstack/table-core` DIRECTLY: the framework-agnostic
// package every official adapter wraps, on the same v8 API React and Vue use,
// with no framework peer at all.  Runes supply the reactivity the adapter would
// have — which is exactly what the adapter's own code does with a store.
//
// Verified end-to-end against the real toolchain on generated projects:
// `svelte-check --fail-on-warnings` 0/0 + `vite build` green on BOTH Svelte
// packs (flowbite, shadcnSvelte) and on the computed-cell case.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const GRID = `QueryView { of: Sales.Customer.all, data: rows => DataGrid(
  Column("Name", o => o.name, sortable: true, filterable: true),
  Column("Tier", o => o.tier, sortable: true),
  rows: rows, multiSort: true, columnVisibility: true, pageSize: 25,
  testid: "customers-grid") }`;

const SEL_STATE = "state { picked: string[] }";

const SEL_GRID = `Stack(
  Text("count"),
  QueryView { of: Sales.Customer.all, data: rows => DataGrid(
    Column("Name", o => o.name, sortable: true),
    rows: rows, selection: picked, testid: "sel-grid") })`;

async function gen(body: string, state = "", design = "") {
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
      resource ordersState { for: Orders, kind: state, use: pg }
      deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], serves: SalesApi, port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp { Sales: api }${design}, port: 3001 }
    }
  `);
}

const PAGE = "web/src/routes/(app)/x/+page.svelte";
const grid = (name: string) => `web/src/lib/components/${name}.svelte`;

describe("DataGrid on Svelte — sibling-component emission", () => {
  it("emits the child as its own .svelte file, not a declaration in the page", async () => {
    const files = await gen(GRID);
    const child = files.get(grid("CustomersGrid"));
    expect(child, "expected a sibling .svelte file for the grid child").toBeDefined();
    expect(child).toContain(`<script lang="ts" generics="T extends object">`);
    expect(child).toContain(`let { rows }: { rows: readonly T[] } = $props();`);
    // Nothing grid-shaped leaks into the page.
    expect(files.get(PAGE)!).not.toContain("createTable");
  });

  it("imports the child through the page's normal component-import channel", async () => {
    const page = (await gen(GRID)).get(PAGE)!;
    expect(page).toContain(`import CustomersGrid from "$lib/components/CustomersGrid.svelte";`);
    expect(page).toContain(`<CustomersGrid rows={customerAll.data.items} />`);
  });
});

describe("DataGrid on Svelte — table-core, not the Svelte 3/4 adapter", () => {
  it("drives @tanstack/table-core directly", async () => {
    const child = (await gen(GRID)).get(grid("CustomersGrid"))!;
    expect(child).toContain(`from "@tanstack/table-core";`);
    expect(child).toContain("createTable");
    // The adapter package must NOT appear — it peers on Svelte 3/4.
    expect(child).not.toContain("@tanstack/svelte-table");
    expect(child).not.toContain("useSvelteTable");
  });

  it("controls EVERY state slice, including pagination", async () => {
    // This is what makes rebuilding the table in `$derived.by` correct: with an
    // uncontrolled `pageIndex`, the rebuild would silently reset the page to 0
    // on every sort click.
    const child = (await gen(GRID)).get(grid("CustomersGrid"))!;
    expect(child).toContain(
      "let pagination = $state<PaginationState>({ pageIndex: 0, pageSize: 25 });",
    );
    // No `selection:` on this grid, so `rowSelection` is absent — the slice
    // list is exactly what the grid asked for, plus pagination.
    // `defaultState` is spread in FIRST: `table-core` returns the raw `state`
    // option from `getState()` and does not merge its own defaults, so a state
    // carrying only our slices throws inside `getHeaderGroups()`.
    expect(child).toContain(
      "state: { ...defaultState, sorting, columnFilters, columnVisibility, pagination },",
    );
    expect(child).toContain(
      "onPaginationChange: (u) => { pagination = applyUpdater(u, pagination); },",
    );
    // …and no slice is seeded through the `initialState` OPTION, which would be
    // the uncontrolled route.  Reading `.initialState` off a throwaway instance
    // for the defaults above is the opposite thing and must not be confused
    // with it — hence matching the option key, not the bare identifier.
    expect(child).not.toContain("initialState:");
  });

  it("supplies the resolved-options fields table-core requires", async () => {
    const child = (await gen(GRID)).get(grid("CustomersGrid"))!;
    // `TableOptionsResolved` demands both; the adapters normally fill them in.
    expect(child).toContain("onStateChange: () => {},");
    expect(child).toContain("renderFallbackValue: null,");
    // `Table` is ALIASED — several Svelte packs import a component of that name
    // (flowbite-svelte does), and the two declarations collide in the Svelte
    // preprocessor.
    expect(child).toContain("const table: TanstackTable<T> = $derived.by(() => {");
    expect(child).toContain("enableMultiSort: true,");
  });

  it("gates filter and visibility state on whether the grid asked for them", async () => {
    const plain = (
      await gen(`QueryView { of: Sales.Customer.all, data: rows => DataGrid(
        Column("Name", o => o.name, sortable: true),
        rows: rows, testid: "plain-grid") }`)
    ).get(grid("PlainGrid"))!;
    expect(plain).not.toContain("getFilteredRowModel");
    expect(plain).not.toContain("ColumnFiltersState");
    expect(plain).not.toContain("VisibilityState");
    // Pagination is never optional — it is always controlled.
    expect(plain).toContain("PaginationState");
  });
});

describe("DataGrid on Svelte — row selection", () => {
  it("passes a callback prop and writes the ids into the page's rune", async () => {
    const files = await gen(SEL_GRID, SEL_STATE);
    const child = files.get(grid("SelGrid"))!;
    expect(child).toContain("onSelectionChange: (ids: string[]) => void;");
    expect(child).toContain("let rowSelection = $state<RowSelectionState>({});");
    expect(child).toContain("enableRowSelection: true,");
    // `void rowSelection` is the explicit dependency — the ids come off
    // `table`, so nothing else in the effect body registers that read.
    expect(child).toContain("    void rowSelection;");
    expect(child).toContain(
      `.rows.map((r) => String((r.original as { id?: unknown }).id ?? r.index)),`,
    );

    const page = files.get(PAGE)!;
    expect(page).toContain("let picked = $state<string[]>([]);");
    expect(page).toContain("onSelectionChange={(ids) => { picked = ids; }}");
  });

  it("renders both checkboxes in the markup, so no pack template changes", async () => {
    const child = (await gen(SEL_GRID, SEL_STATE)).get(grid("SelGrid"))!;
    expect(child).toContain(`{#if h.column.id === "loom-select"}`);
    expect(child).toContain("checked={table.getIsAllPageRowsSelected()}");
    expect(child).toContain(`{#if c.column.id === "loom-select"}`);
    expect(child).toContain("onchange={() => c.row.toggleSelected()}");
    expect(child).toContain(
      `{ id: "loom-select", header: "", enableSorting: false, enableColumnFilter: false },`,
    );
  });

  it("emits no selection wiring when `selection:` is absent", async () => {
    const child = (await gen(GRID)).get(grid("CustomersGrid"))!;
    expect(child).not.toContain("RowSelectionState");
    expect(child).not.toContain("loom-select");
    expect(child).not.toContain("onSelectionChange");
  });
});

describe("DataGrid on Svelte — computed cells", () => {
  it("renders a non-trivial accessor in the markup, keyed by column id", async () => {
    const child = (
      await gen(`QueryView { of: Sales.Customer.all, data: rows => DataGrid(
        Column("Name", o => Badge(o.name)),
        Column("Tier", o => o.tier, sortable: true),
        rows: rows, testid: "computed-grid") }`)
    ).get(grid("ComputedGrid"))!;
    expect(child).toContain(`{#if c.column.id === "col1"}`);
    // The row reaches the cell through a cast helper — the component is generic
    // over the row type, so raw property access wouldn't pass `svelte-check`.
    expect(child).toContain("const asRow = (v: T): CellRow => v as CellRow;");
    expect(child).toContain("asRow(c.row.original).name");
    // …and the simple column falls back to the plain cell value.
    expect(child).toContain(`{String(c.getValue() ?? "")}`);
  });

  it("imports what the computed cells need INTO the child, not onto the page", async () => {
    // The walk parks a cell's imports on the PAGE's import map, but the cell
    // markup is hoisted into this file — so the component referenced `Badge`
    // and `formatDateTime` that nothing here imported.  That is a runtime
    // `ReferenceError` on Svelte: the page still looks correct, the build is
    // green, and the grid renders nothing.
    const files = await gen(
      `QueryView { of: Sales.Customer.all, data: rows => DataGrid(
        Column("Name", o => Badge(o.name)),
        Column("Joined", o => DateDisplay { o.joinedAt }),
        rows: rows, testid: "cellimp-grid") }`,
      "",
      // flowbite pins the case sharply: its `Badge` and its grid chrome come
      // from the SAME module, so this also proves the two lists merge.
      " design: flowbite",
    );
    const child = files.get(grid("CellimpGrid"))!;
    // The pack component the `Badge` cell renders…
    expect(child).toMatch(/import \{[^}]*Badge[^}]*\} from "flowbite-svelte";/);
    // …and the format helper the `DateDisplay` cell calls.
    expect(child).toContain(`import { formatDateTime } from "$lib/format";`);
    // Merged per source: the grid chrome imports from `flowbite-svelte` too, and
    // two import lines for one module is a duplicate-declaration parse error.
    expect(child.match(/from "flowbite-svelte";/g)?.length).toBe(1);
  });
});
