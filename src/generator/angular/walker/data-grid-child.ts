// Angular's `DataGrid` child component — the fourth and final JS-frontend half
// of the `renderDataGridChild` seam (M-T1.1 slice 10).
//
// WHY A SIBLING FILE
// ------------------
// An Angular component is a decorated class, so a second one *could* share the
// page's file — but a standalone component must also be listed in the page's
// `imports: []`, and Loom's page files are assembled from a fixed member/import
// plan.  A sibling `src/app/components/<kebab>.component.ts` keeps the grid out
// of that plan entirely; the page gets one import line and one `imports: []`
// entry, threaded through the Angular walker sink.
//
// WHY THE ROW TYPE IS CONCRETE, NOT GENERIC
// -----------------------------------------
// React/Vue/Svelte make the child generic over the row type so no DTO name has
// to be resolved at generate time.  Angular can declare a generic component
// class, but `strictTemplates` then has to infer that parameter at every tag
// use-site, which is fragile across pack markup.  The row type is `CellRow`
// (`Record<string, any>`) instead — the same confined cast the other three
// targets apply at the cell boundary, just hoisted to the input's type.
//
// WHY `String`/`Math` ARE CLASS MEMBERS
// -------------------------------------
// Angular templates evaluate against the component instance, not module scope,
// so a template calling `String(...)` or `Math.max(...)` needs them re-exposed
// as members.  Same reason `Table`'s Angular target re-exposes `sortRows`.
//
// The emitted shape is verified against a real `ng build` (Angular 22 +
// `@tanstack/angular-table` 8.21) with the component actually referenced from a
// page, so its TEMPLATE is type-checked and not merely tree-shaken.

import { lines } from "../../../util/code-builder.js";
import { snake } from "../../../util/naming.js";
import { FORMAT_CALL_HELPERS } from "../../_frontend/format-helpers.js";
import { CHROME_T_CALL } from "../../_walker/i18n-emit.js";
import { mergedImports } from "../../_walker/shared/imports.js";
import type { DataGridChild, DataGridColumn, DataGridSpec } from "../../_walker/target.js";
import type { WalkContext } from "../../_walker/walker-core.js";
import { angularSink } from "./sink.js";

/** The walker binds a computed cell's row through this helper — see
 *  `angularTarget.dataGridRowVar`. */
const ROW_VAR = "asRow";

export function renderAngularDataGridChild(spec: DataGridSpec, ctx: WalkContext): DataGridChild {
  const className = `${spec.componentName}Component`;
  const fileBase = `${kebab(spec.componentName)}.component`;
  const selector = `app-${kebab(spec.componentName)}`;

  // Pages live at `src/app/pages/`, so a sibling under `src/app/components/`
  // resolves one hop up.
  angularSink(ctx).dataGrids.push({ className, importPath: `../components/${fileBase}` });

  return {
    file: {
      path: `src/app/components/${fileBase}.ts`,
      content: renderComponent(spec, className, selector),
    },
    // Page state is a signal on Angular, so the write goes through `.set(...)`
    // — a bare assignment compiles but silently never updates the view.
    callSite: spec.selection
      ? `<${selector} [rows]="${spec.rowsExpr}" (selectionChange)="${spec.selection}.set($event)" />`
      : `<${selector} [rows]="${spec.rowsExpr}" />`,
  };
}

function kebab(pascal: string): string {
  return snake(pascal).replace(/_/g, "-");
}

function renderComponent(spec: DataGridSpec, className: string, selector: string): string {
  // `pageSize` is read by `stateSignals` — it seeds the controlled pagination
  // signal rather than an `initialState`, so it isn't needed here.
  const { columns, multiSort, columnVisibility, anyFilterable } = spec;
  const selection = spec.selection !== undefined;

  // Angular's packs get the header + cell CONTENT from the walker, like Vue's
  // and Svelte's — a TanStack `cell` function returns framework-specific render
  // output, and the walker produces markup.
  const body = spec.renderBody({
    headerBody: headerBody(selection),
    cellBody: cellBody(columns, selection),
  });

  const coreSymbols = [
    "Component",
    "computed",
    ...(selection ? ["effect"] : []),
    "input",
    ...(selection ? ["output"] : []),
    "signal",
  ];
  const tableValueImports = [
    "createAngularTable",
    "getCoreRowModel",
    ...(anyFilterable ? ["getFilteredRowModel"] : []),
    "getPaginationRowModel",
    "getSortedRowModel",
  ];
  const tableTypeImports = [
    "type ColumnDef",
    ...(columns.some((c) => c.numericSort) ? ["type Row"] : []),
    ...(anyFilterable ? ["type ColumnFiltersState"] : []),
    "type PaginationState",
    ...(selection ? ["type RowSelectionState"] : []),
    "type SortingState",
    "type Updater",
    ...(columnVisibility ? ["type VisibilityState"] : []),
  ];

  // The pack's own directives/modules go in this component's `imports: []`, not
  // the page's — the markup they serve lives here.  `cellImports` joins them:
  // a COMPUTED cell's markup also lives here, but the walk parked its imports
  // on the PAGE, so anything an `EnumBadge` / `Money` cell needed resolved to
  // nothing in this file.  Merged per source — the chrome and the cells often
  // name the same module, and Angular would see a duplicate import.
  const allImports = mergedImports([...spec.packImports, ...spec.cellImports]);
  const packModules = allImports.flatMap((i) => i.named).sort();
  const packImportLines = allImports.map(
    (i) => `import { ${i.named.join(", ")} } from "${i.from}";`,
  );

  // Format helpers the CELL markup calls.  Angular templates evaluate against
  // the component instance, so a bare `formatDateTime(...)` in a `DateDisplay`
  // cell resolves to nothing — the page shell re-exposes these as members for
  // exactly this reason, and the hoisted child needs its own copy.  Detected
  // from the rendered body so only what is used is emitted (Angular's template
  // compiler is happy either way, but an unused member is noise).
  const usedFormatHelpers = FORMAT_CALL_HELPERS.filter((h) => body.includes(`${h}(`));

  const formatImportLine =
    usedFormatHelpers.length > 0
      ? [`import { ${usedFormatHelpers.join(", ")} } from "../../lib/format";`]
      : [];

  // Pack-chrome i18n (M-T1.11).  The pack's grid markup carries the pager's
  // `{{ t("chrome.previous", …) }}` labels under i18n.  Angular needs BOTH
  // halves: the module import (this component is its own file, so unlike
  // React's child it inherits nothing from the page) AND a class MEMBER,
  // because an Angular template resolves names against the component instance
  // — the same reason `String`/`Math`/the format helpers are re-exposed above,
  // and the same lift `app.component.ts` does for the shell's own chrome.
  // Gated on the RENDERED body so a pack that bakes in no chrome gets neither.
  const usesI18n = body.includes(CHROME_T_CALL);
  // The runtime lives at `src/lib/i18n.ts`, two hops up from
  // `src/app/components/` — the same lift the format import above makes.
  const i18nImportLine = usesI18n ? [`import { t } from "../../lib/i18n";`] : [];

  return `${lines(
    `// Auto-generated.  Do not edit by hand.`,
    `import { ${coreSymbols.join(", ")} } from "@angular/core";`,
    `import {`,
    ...[...tableValueImports, ...tableTypeImports].map((n) => `  ${n},`),
    `} from "@tanstack/angular-table";`,
    ...formatImportLine,
    ...i18nImportLine,
    ...packImportLines,
    ``,
    `// biome-ignore lint/suspicious/noExplicitAny: cell markup reads declared row fields; the grid is not generic over the row type (see the file header), so the row is carried as an index-signature record.`,
    `type CellRow = Record<string, any>;`,
    ``,
    `@Component({`,
    `  selector: ${JSON.stringify(selector)},`,
    `  imports: [${packModules.join(", ")}],`,
    "  template: `",
  )}
${body}
${lines(
  "  `,",
  `})`,
  `export class ${className} {`,
  `  readonly rows = input.required<readonly CellRow[]>();`,
  ...(selection ? [`  readonly selectionChange = output<string[]>();`] : []),
  ``,
  `  // Angular templates evaluate against the instance, so globals the markup`,
  `  // calls have to be re-exposed as members.`,
  `  protected readonly String = String;`,
  `  protected readonly Math = Math;`,
  ...usedFormatHelpers.map((h) => `  protected readonly ${h} = ${h};`),
  ...(usesI18n ? [`  protected readonly t = t;`] : []),
  ...(columns.some((c) => c.cell?.includes(ROW_VAR))
    ? [
        `  /** Identity at runtime — the cast is the point (see \`CellRow\`). */`,
        `  protected readonly ${ROW_VAR} = (v: CellRow): CellRow => v;`,
      ]
    : []),
  ``,
  ...stateSignals(spec),
  ``,
  `  private readonly columns = computed<ColumnDef<CellRow>[]>(() => [`,
  ...columnDefs(columns, selection),
  `  ]);`,
  ``,
  `  protected readonly table = createAngularTable(() => ({`,
  `    // \`rows\` binds as \`readonly CellRow[]\`; TanStack's \`data\` is mutable.`,
  `    data: (this.rows() ?? []) as CellRow[],`,
  `    columns: this.columns(),`,
  `    state: {`,
  ...stateReads(spec),
  `    },`,
  ...changeHandlers(spec),
  ...(selection ? [`    enableRowSelection: true,`] : []),
  `    enableMultiSort: ${multiSort},`,
  `    getCoreRowModel: getCoreRowModel(),`,
  `    getSortedRowModel: getSortedRowModel(),`,
  ...(anyFilterable ? [`    getFilteredRowModel: getFilteredRowModel(),`] : []),
  `    getPaginationRowModel: getPaginationRowModel(),`,
  `  }));`,
  ...(selection ? ["", ...selectionEffect()] : []),
  `}`,
  ``,
  `/** TanStack hands each \`onXChange\` either the next value or a function of the`,
  ` *  previous one; the adapter leaves that union to the caller. */`,
  ...(columns.some((c) => c.numericSort)
    ? [
        "/** Comparator for a money / decimal column.  Those reach the row as a Decimal",
        " *  OBJECT whose valueOf() returns a string, so TanStack's default a < b orders",
        " *  them lexicographically — an ascending sort comes out [10, 100, 9].  Number()",
        " *  goes through that same valueOf, which is what makes it a correct numeric",
        " *  read, and (unlike TanStack's alphanumeric fallback) it stays correct for",
        " *  negative amounts. */",
        "function compareDecimal(a: Row<CellRow>, b: Row<CellRow>, id: string): number {",
        "  const x = Number(a.getValue(id) ?? 0);",
        "  const y = Number(b.getValue(id) ?? 0);",
        "  return x < y ? -1 : x > y ? 1 : 0;",
        "}",
        "",
      ]
    : []),
  `function applyUpdater<S>(updater: Updater<S>, current: S): S {`,
  `  return typeof updater === "function" ? (updater as (old: S) => S)(current) : updater;`,
  `}`,
)}`;
}

function stateSignals(spec: DataGridSpec): string[] {
  const out = [`  private readonly sorting = signal<SortingState>([]);`];
  if (spec.selection !== undefined)
    out.push(`  private readonly rowSelection = signal<RowSelectionState>({});`);
  if (spec.anyFilterable)
    out.push(`  private readonly columnFilters = signal<ColumnFiltersState>([]);`);
  if (spec.columnVisibility)
    out.push(`  private readonly columnVisibility = signal<VisibilityState>({});`);
  // Pagination is controlled like every other slice, so the page survives a
  // sort click (the same trap the Svelte target documents).
  out.push(
    `  private readonly pagination = signal<PaginationState>({ pageIndex: 0, pageSize: ${spec.pageSize} });`,
  );
  return out;
}

function sliceNames(spec: DataGridSpec): string[] {
  return [
    "sorting",
    ...(spec.selection !== undefined ? ["rowSelection"] : []),
    ...(spec.anyFilterable ? ["columnFilters"] : []),
    ...(spec.columnVisibility ? ["columnVisibility"] : []),
    "pagination",
  ];
}

function stateReads(spec: DataGridSpec): string[] {
  return sliceNames(spec).map((n) => `      ${n}: this.${n}(),`);
}

function changeHandlers(spec: DataGridSpec): string[] {
  const typeOf: Record<string, string> = {
    sorting: "SortingState",
    rowSelection: "RowSelectionState",
    columnFilters: "ColumnFiltersState",
    columnVisibility: "VisibilityState",
    pagination: "PaginationState",
  };
  return sliceNames(spec).map((n) => {
    const handler = `on${n[0]!.toUpperCase()}${n.slice(1)}Change`;
    return `    ${handler}: (u: Updater<${typeOf[n]}>) => this.${n}.update((p) => applyUpdater(u, p)),`;
  });
}

/** Report the selected row ids up to the page.
 *
 *  `void this.rowSelection()` is the explicit dependency: the effect must re-run
 *  when the selection MAP changes, and the ids come off `table`, so nothing else
 *  in the body registers that read. */
function selectionEffect(): string[] {
  return [
    `  constructor() {`,
    `    effect(() => {`,
    `      void this.rowSelection();`,
    `      this.selectionChange.emit(`,
    `        this.table`,
    `          .getSelectedRowModel()`,
    `          .rows.map((r) => String((r.original as { id?: unknown }).id ?? r.index)),`,
    `      );`,
    `    });`,
    `  }`,
  ];
}

function columnDefs(columns: readonly DataGridColumn[], selection: boolean): string[] {
  const out: string[] = [];
  if (selection) {
    out.push(
      `    { id: "loom-select", header: "", enableSorting: false, enableColumnFilter: false },`,
    );
  }
  for (const c of columns) {
    const parts = [`id: ${JSON.stringify(c.id)}`];
    if (c.accessorKey) parts.push(`accessorKey: ${JSON.stringify(c.accessorKey)}`);
    parts.push(`header: ${JSON.stringify(c.header)}`);
    parts.push(`enableSorting: ${c.sortable}`);
    parts.push(`enableColumnFilter: ${c.filterable}`);
    // A money/decimal column needs an explicit numeric comparator — see
    // `DataGridColumn.numericSort`.
    if (c.numericSort) parts.push("sortingFn: compareDecimal");
    out.push(`    { ${parts.join(", ")} },`);
  }
  return out;
}

/** The full header-cell content, as Angular control flow (`@if`/`@else if`). */
function headerBody(selection: boolean): string {
  const label = `{{ String(h.column.columnDef.header ?? h.id) }}`;
  const indicator = `{{ h.column.getIsSorted() === 'asc' ? ' ↑' : h.column.getIsSorted() === 'desc' ? ' ↓' : '' }}`;
  const style =
    "background: none; border: none; padding: 0; font: inherit; cursor: pointer; user-select: none;";
  return lines(
    ...(selection
      ? [
          `@if (h.column.id === 'loom-select') {`,
          `  <input`,
          `    type="checkbox"`,
          `    aria-label="Select all rows"`,
          `    [checked]="table.getIsAllPageRowsSelected()"`,
          `    (change)="table.toggleAllPageRowsSelected()"`,
          `  />`,
          `} @else if (h.column.getCanSort()) {`,
        ]
      : [`@if (h.column.getCanSort()) {`]),
    `  <button`,
    `    type="button"`,
    `    style="${style}"`,
    `    [attr.aria-label]="'Sort by ' + String(h.column.columnDef.header ?? h.id)"`,
    `    (click)="h.column.toggleSorting()"`,
    `  >`,
    `    ${label}${indicator}`,
    `  </button>`,
    `} @else {`,
    `  ${label}`,
    `}`,
  );
}

/** The full body-cell content, as Angular control flow. */
function cellBody(columns: readonly DataGridColumn[], selection: boolean): string {
  const branches: string[] = [];
  if (selection) {
    branches.push(
      lines(
        `@if (c.column.id === 'loom-select') {`,
        `  <input`,
        `    type="checkbox"`,
        `    aria-label="Select row"`,
        `    [checked]="c.row.getIsSelected()"`,
        `    [disabled]="!c.row.getCanSelect()"`,
        `    (change)="c.row.toggleSelected()"`,
        `  />`,
      ),
    );
  }
  for (const col of columns) {
    if (col.cell === undefined) continue;
    branches.push(
      lines(
        `${branches.length === 0 ? "@if" : "} @else if"} (c.column.id === '${col.id}') {`,
        `  ${col.cell}`,
      ),
    );
  }
  if (branches.length === 0) return `{{ String(c.getValue() ?? '') }}`;
  return lines(...branches, `} @else {`, `  {{ String(c.getValue() ?? '') }}`, `}`);
}
