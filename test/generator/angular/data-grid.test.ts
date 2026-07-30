// DataGrid on Angular — the fourth and final JS-frontend target.
//
// Angular rides the stable `@tanstack/angular-table` adapter
// (`createAngularTable`, peers `@angular/core >= 17`), so unlike Svelte there is
// no adapter-availability problem here.  What diverges is everything around it:
//
//   - the child is a decorated CLASS in a sibling
//     `src/app/components/<kebab>.component.ts`, and the page needs BOTH an
//     import line and an `imports: []` entry (threaded through the Angular
//     walker sink, not `usedUserComponents` — that channel is for extern
//     components rendered via `NgComponentOutlet`);
//   - page state is a SIGNAL, so the selection write is `.set($event)` — a bare
//     assignment compiles and silently never updates the view;
//   - templates evaluate against the component instance, so `String`/`Math`/the
//     row cast have to be re-exposed as members;
//   - the row type is concrete (`CellRow`), not generic — `strictTemplates`
//     would otherwise have to infer the parameter at every tag use-site.
//
// Verified end-to-end against a real `ng build` (Angular 22) on generated
// projects: all THREE Angular packs (angularMaterial, primeng, spartanNg) plus
// the computed-cell case.

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
        framework: angular
        api Sales: SalesApi
        page X { route: "/x"  ${state}  body: ${body} }
      }
      deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp { Sales: api }${design}, port: 3001 }
    }
  `);
}

const PAGE = "web/src/app/pages/x.component.ts";
const grid = (kebab: string) => `web/src/app/components/${kebab}.component.ts`;

describe("DataGrid on Angular — sibling-component emission", () => {
  it("emits the child as its own kebab-cased component file", async () => {
    const files = await gen(GRID);
    const child = files.get(grid("customers-grid"));
    expect(child, "expected a sibling component file for the grid child").toBeDefined();
    expect(child).toContain(`selector: "app-customers-grid",`);
    expect(child).toContain("export class CustomersGridComponent {");
    expect(child).toContain("readonly rows = input.required<readonly CellRow[]>();");
    // Nothing grid-shaped leaks into the page.
    expect(files.get(PAGE)!).not.toContain("createAngularTable");
  });

  it("gives the page BOTH an import line and an imports: [] entry", async () => {
    // A standalone component used by tag needs both; the extern-component
    // channel (`NgComponentOutlet`) would be the wrong one here.
    const page = (await gen(GRID)).get(PAGE)!;
    expect(page).toContain(
      `import { CustomersGridComponent } from "../components/customers-grid.component";`,
    );
    expect(page).toContain("imports: [CustomersGridComponent],");
    expect(page).toContain(`<app-customers-grid [rows]="customerAll.data()!.items" />`);
  });
});

describe("DataGrid on Angular — signals wiring", () => {
  it("drives createAngularTable off signals, with pagination controlled", async () => {
    const child = (await gen(GRID)).get(grid("customers-grid"))!;
    expect(child).toContain(`from "@tanstack/angular-table";`);
    expect(child).toContain("protected readonly table = createAngularTable(() => ({");
    expect(child).toContain("private readonly sorting = signal<SortingState>([]);");
    expect(child).toContain(
      "private readonly pagination = signal<PaginationState>({ pageIndex: 0, pageSize: 25 });",
    );
    expect(child).toContain(
      "onPaginationChange: (u: Updater<PaginationState>) => this.pagination.update((p) => applyUpdater(u, p)),",
    );
    // Controlled, so no `initialState` — the uncontrolled route would reset the
    // page on every sort click.
    expect(child).not.toContain("initialState");
    expect(child).toContain("enableMultiSort: true,");
  });

  it("re-exposes template globals as members", async () => {
    // Angular templates evaluate against the instance, not module scope.
    const child = (await gen(GRID)).get(grid("customers-grid"))!;
    expect(child).toContain("protected readonly String = String;");
    expect(child).toContain("protected readonly Math = Math;");
  });

  it("gates filter and visibility state on whether the grid asked for them", async () => {
    const plain = (
      await gen(`QueryView { of: Sales.Customer.all, data: rows => DataGrid(
        Column("Name", o => o.name, sortable: true),
        rows: rows, testid: "plain-grid") }`)
    ).get(grid("plain-grid"))!;
    expect(plain).not.toContain("getFilteredRowModel");
    expect(plain).not.toContain("ColumnFiltersState");
    expect(plain).not.toContain("VisibilityState");
    // Pagination is never optional — it is always controlled.
    expect(plain).toContain("PaginationState");
  });
});

describe("DataGrid on Angular — row selection", () => {
  it("writes the ids through the page signal's set(), not a bare assignment", async () => {
    const files = await gen(SEL_GRID, SEL_STATE);
    const page = files.get(PAGE)!;
    // A bare `picked = $event` compiles and silently never updates the view.
    expect(page).toContain(`(selectionChange)="picked.set($event)"`);
    // …and the signal carries its element type — `signal([])` would infer
    // `WritableSignal<never[]>`, making every `.set(...)` a type error.
    expect(page).toContain("readonly picked = signal<string[]>([]);");

    const child = files.get(grid("sel-grid"))!;
    expect(child).toContain("readonly selectionChange = output<string[]>();");
    expect(child).toContain("private readonly rowSelection = signal<RowSelectionState>({});");
    expect(child).toContain("enableRowSelection: true,");
    // `void this.rowSelection()` is the explicit dependency — the ids come off
    // `table`, so nothing else in the effect registers that read.
    expect(child).toContain("      void this.rowSelection();");
    expect(child).toContain(
      `.rows.map((r) => String((r.original as { id?: unknown }).id ?? r.index)),`,
    );
  });

  it("renders both checkboxes in the template, so no pack template changes", async () => {
    const child = (await gen(SEL_GRID, SEL_STATE)).get(grid("sel-grid"))!;
    expect(child).toContain("@if (h.column.id === 'loom-select') {");
    expect(child).toContain(`[checked]="table.getIsAllPageRowsSelected()"`);
    expect(child).toContain("@if (c.column.id === 'loom-select') {");
    expect(child).toContain(`(change)="c.row.toggleSelected()"`);
    expect(child).toContain(
      `{ id: "loom-select", header: "", enableSorting: false, enableColumnFilter: false },`,
    );
  });

  it("emits no selection wiring when `selection:` is absent", async () => {
    const child = (await gen(GRID)).get(grid("customers-grid"))!;
    expect(child).not.toContain("RowSelectionState");
    expect(child).not.toContain("loom-select");
    expect(child).not.toContain("output<string[]>");
  });
});

describe("DataGrid on Angular — computed cells", () => {
  it("renders a non-trivial accessor in the template, keyed by column id", async () => {
    const child = (
      await gen(`QueryView { of: Sales.Customer.all, data: rows => DataGrid(
        Column("Name", o => Badge(o.name)),
        Column("Tier", o => o.tier, sortable: true),
        rows: rows, testid: "computed-grid") }`)
    ).get(grid("computed-grid"))!;
    // No selection on this grid, so the computed column is the FIRST branch.
    expect(child).toContain("@if (c.column.id === 'col1') {");
    // The cast is a MEMBER, because a template can't carry an inline `as`.
    expect(child).toContain("protected readonly asRow = (v: CellRow): CellRow => v;");
    expect(child).toContain("asRow(c.row.original).name");
    // …and the simple column falls back to the plain cell value.
    expect(child).toContain("{{ String(c.getValue() ?? '') }}");
  });
});
