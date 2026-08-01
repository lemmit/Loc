// DataGrid on Vue — the sibling-SFC half of the `renderDataGridChild` seam.
//
// The load-bearing structural fact is the one that forced the seam: React puts
// the grid's child component at module scope in the page's own file, and a Vue
// SFC cannot — `<script setup>` compiles to exactly ONE component per file.  So
// the Vue target emits a whole `src/components/<Name>.vue` through the walker's
// `hoistedComponentFiles` channel and imports it like any other component.
//
// The second divergence is the cells.  React's column defs carry `cell: () =>
// <JSX/>`; a Vue `cell` function would have to return VNodes, and the walker
// produces template markup — so a column with a non-trivial accessor keeps its
// markup in the template, selected by column id.
//
// Verified end-to-end against the real toolchain on a generated project:
// `vue-tsc --noEmit` + `vite build` green on BOTH Vue packs (vuetify,
// shadcnVue).

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
        framework: vue
        api Sales: SalesApi
        page X { route: "/x"  ${state}  body: ${body} }
      }
      deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp { Sales: api }${design}, port: 3001 }
    }
  `);
}

describe("DataGrid on Vue — sibling-SFC emission", () => {
  it("emits the child as its own SFC, not a declaration in the page", async () => {
    const files = await gen(GRID);
    const sfc = files.get("web/src/components/CustomersGrid.vue");
    expect(sfc, "expected a sibling SFC for the grid child").toBeDefined();
    expect(sfc).toContain(`<script setup lang="ts" generic="T extends object">`);
    expect(sfc).toContain(`const props = defineProps<{ rows: readonly T[] }>();`);
    // Nothing grid-shaped leaks into the page's own script block.
    const page = files.get("web/src/pages/x.vue")!;
    expect(page).not.toContain("useVueTable");
  });

  it("imports the child through the page's normal component-import channel", async () => {
    const page = (await gen(GRID)).get("web/src/pages/x.vue")!;
    expect(page).toContain(`import CustomersGrid from "../components/CustomersGrid.vue";`);
    expect(page).toContain(`<CustomersGrid :rows="customerAll.data.items" />`);
  });

  it("wires useVueTable through get-accessors, the Vue adapter's reactivity idiom", async () => {
    const sfc = (await gen(GRID)).get("web/src/components/CustomersGrid.vue")!;
    expect(sfc).toContain(`from "@tanstack/vue-table"`);
    expect(sfc).toContain("const table = useVueTable({");
    // Reactivity flows through getters, not plain values.
    expect(sfc).toContain("  get data() {");
    expect(sfc).toContain("    return (props.rows ?? []) as T[];");
    expect(sfc).toContain("    get sorting() {");
    // TanStack passes updater-or-value; one shared helper resolves the union.
    expect(sfc).toContain("function applyUpdater<S>(updater: Updater<S>, current: S): S {");
    expect(sfc).toContain("    sorting.value = applyUpdater(updater, sorting.value);");
    expect(sfc).toContain("enableMultiSort: true,");
    expect(sfc).toContain("initialState: { pagination: { pageSize: 25 } },");
  });

  it("gates filter and visibility state on whether the grid asked for them", async () => {
    const plain = (
      await gen(`QueryView { of: Sales.Customer.all, data: rows => DataGrid(
        Column("Name", o => o.name, sortable: true),
        rows: rows, testid: "plain-grid") }`)
    ).get("web/src/components/PlainGrid.vue")!;
    expect(plain).not.toContain("getFilteredRowModel");
    expect(plain).not.toContain("ColumnFiltersState");
    expect(plain).not.toContain("VisibilityState");
  });

  it("puts the pack's components in the SFC, never on the page", async () => {
    // A page importing chrome it doesn't render would fail `vue-tsc` under
    // `noUnusedLocals` — the reason pack imports are placed by the target.
    const files = await gen(GRID, "", ", design: shadcnVue");
    const sfc = files.get("web/src/components/CustomersGrid.vue")!;
    expect(sfc).toContain(`from "@/components/ui";`);
    expect(sfc).toContain("Table");
    const page = files.get("web/src/pages/x.vue")!;
    expect(page).not.toContain("TableHeader");
  });
});

describe("DataGrid on Vue — row selection", () => {
  it("emits a typed emit and writes the ids into the page's ref", async () => {
    const files = await gen(SEL_GRID, SEL_STATE);
    const sfc = files.get("web/src/components/SelGrid.vue")!;
    expect(sfc).toContain(`const emit = defineEmits<{ selectionChange: [ids: string[]] }>();`);
    expect(sfc).toContain("const rowSelection = ref<RowSelectionState>({});");
    expect(sfc).toContain("enableRowSelection: true,");
    expect(sfc).toContain("watch(rowSelection, () => {");
    expect(sfc).toContain(
      `.rows.map((r) => String((r.original as { id?: unknown }).id ?? r.index)),`,
    );

    const page = files.get("web/src/pages/x.vue")!;
    // The page owns the id list, typed — `ref([])` would infer `never[]`.
    expect(page).toContain("const picked = ref<string[]>([]);");
    expect(page).toContain(`@selection-change="picked = $event"`);
  });

  it("renders both checkboxes in the template, so no pack template changes", async () => {
    const sfc = (await gen(SEL_GRID, SEL_STATE)).get("web/src/components/SelGrid.vue")!;
    expect(sfc).toContain(`v-if="h.column.id === 'loom-select'"`);
    expect(sfc).toContain(`:checked="table.getIsAllPageRowsSelected()"`);
    expect(sfc).toContain(`v-if="c.column.id === 'loom-select'"`);
    expect(sfc).toContain(`@change="c.row.toggleSelected()"`);
    // The select column leads, and is never sortable or filterable.
    expect(sfc).toContain(
      `{ id: "loom-select", header: "", enableSorting: false, enableColumnFilter: false },`,
    );
  });

  it("emits no selection wiring when `selection:` is absent", async () => {
    const sfc = (await gen(GRID)).get("web/src/components/CustomersGrid.vue")!;
    expect(sfc).not.toContain("RowSelectionState");
    expect(sfc).not.toContain("loom-select");
    expect(sfc).not.toContain("defineEmits");
  });
});

describe("DataGrid on Vue — computed cells", () => {
  it("renders a non-trivial accessor in the template, keyed by column id", async () => {
    // A `cell` function would have to return VNodes; the walker produces
    // markup, so the branch lives in the template instead.
    const sfc = (
      await gen(`QueryView { of: Sales.Customer.all, data: rows => DataGrid(
        Column("Name", o => Badge(o.name)),
        Column("Tier", o => o.tier, sortable: true),
        rows: rows, testid: "computed-grid") }`)
    ).get("web/src/components/ComputedGrid.vue")!;
    // Single-quoted: the guard sits inside a double-quoted HTML attribute.
    expect(sfc).toContain(`<template v-if="c.column.id === 'col1'">`);
    // The row reaches the cell through a script-declared cast helper — the SFC
    // is generic over the row type, so raw property access wouldn't typecheck.
    expect(sfc).toContain("const asRow = (v: T): CellRow => v as CellRow;");
    expect(sfc).toContain("asRow(c.row.original).name");
    // …and the simple column still falls through to FlexRender.
    expect(sfc).toContain(`<FlexRender v-else :render="c.column.columnDef.cell"`);
  });
});

describe("DataGrid on Vue — what the hoisted SFC has to import", () => {
  it("carries the computed cells' imports and the format helpers", async () => {
    // Both halves land in the SFC because the CELL MARKUP does.  The walk parks
    // a cell's pack imports on the PAGE, and the format helpers are imported by
    // the page shell unconditionally with no registration channel at all — so a
    // `DateDisplay` column called `formatDateTime(...)` against nothing here.
    const files = await gen(
      `QueryView { of: Sales.Customer.all, data: rows => DataGrid(
        Column("Name", o => Badge(o.name)),
        Column("Joined", o => DateDisplay { o.joinedAt }),
        rows: rows, testid: "cellimp-grid") }`,
      "",
      ", design: shadcnVue",
    );
    const child = files.get("web/src/components/CellimpGrid.vue")!;
    expect(child).toContain(`from "../lib/format";`);
    expect(child).toContain("formatDateTime");
    // shadcnVue's components are real imports (unlike Vuetify's globals), which
    // is what makes the cell-import half observable here.
    expect(child).toMatch(/import \{[^}]*Badge[^}]*\} from "@\/components\/ui";/);
  });
});
