// Svelte's `DataGrid` child component — the `.svelte` half of the
// `renderDataGridChild` seam (M-T1.1 slice 10).
//
// WHY `table-core` AND NOT THE SVELTE ADAPTER
// -------------------------------------------
// `@tanstack/svelte-table` (the official adapter, stable at 8.21) peers on
// `svelte: ^4 || ^3.49` — it predates runes, and the generated stack is Svelte
// 5.  Svelte 5 support exists only in `9.0.0-beta`, and TanStack v9 is a
// different API (`createTable` + a `_features` array, no row-model functions),
// which would make the Svelte grid behave differently from the React and Vue
// ones — exactly what this architecture exists to prevent.
//
// So this target drops one layer and uses `@tanstack/table-core` DIRECTLY: the
// framework-agnostic package every official adapter wraps, on the same v8 API
// React and Vue use, with no framework peer dependency at all.  Runes supply
// the reactivity the adapter would have.  This is not a workaround — it is the
// layer beneath the adapter, and the adapter's own job is exactly this wiring.
//
// WHY EVERY STATE SLICE IS CONTROLLED
// -----------------------------------
// The table is rebuilt inside `$derived.by`.  That is only correct because
// EVERY state slice — including `pagination` — is controlled by a rune: with an
// uncontrolled `pageIndex`, rebuilding would silently reset the page to 0 on
// every sort click.  It is also what makes the markup reactive: TanStack
// mutates its own internals, so reading the runes inside the derivation is the
// dependency edge Svelte needs.
//
// WHY A SIBLING FILE
// ------------------
// A `.svelte` file holds exactly ONE component, so the child cannot share the
// page's file the way React's does.  It lands at
// `src/lib/components/<Name>.svelte` through `ctx.hoistedComponentFiles`, and
// the name is registered in `ctx.usedUserComponents` so the page shell's
// existing `$lib/components/<Name>.svelte` import reaches it.
//
// The emitted shape is compile-verified against real `@tanstack/table-core`
// 8.21 + Svelte 5.56: `svelte-check` 0 errors / 0 warnings, `vite build` green.

import { lines } from "../../../util/code-builder.js";
import { mergedImports } from "../../_walker/shared/imports.js";
import type { DataGridChild, DataGridColumn, DataGridSpec } from "../../_walker/target.js";
import type { WalkContext } from "../../_walker/walker-core.js";

export function renderSvelteDataGridChild(spec: DataGridSpec, ctx: WalkContext): DataGridChild {
  ctx.usedUserComponents.add(spec.componentName);

  return {
    file: {
      path: `src/lib/components/${spec.componentName}.svelte`,
      content: renderComponent(spec),
    },
    // Svelte 5 passes callbacks as ordinary props; the page writes the ids
    // straight into its `$state` field (plain assignment is reactive).
    callSite: spec.selection
      ? `<${spec.componentName} rows={${spec.rowsExpr}} onSelectionChange={(ids) => { ${spec.selection} = ids; }} />`
      : `<${spec.componentName} rows={${spec.rowsExpr}} />`,
  };
}

/** The whole `src/lib/components/<Name>.svelte` file. */
function renderComponent(spec: DataGridSpec): string {
  // `pageSize` is read by `stateRunes` — it seeds the controlled pagination
  // rune rather than an `initialState`, so it isn't needed here.
  const { columns, multiSort, columnVisibility, anyFilterable } = spec;
  const selection = spec.selection !== undefined;

  // Svelte's packs get the header + cell CONTENT from the walker, like Vue's —
  // a TanStack `cell` function returns VNode-ish output, and the walker
  // produces markup.  Consistent with `Table` on Svelte, whose sortable header
  // is likewise walker-emitted (`svelteTarget.renderSortableHeader`).
  const body = spec.renderBody({
    headerBody: headerBody(selection),
    cellBody: cellBody(columns, selection),
  });

  const needsDecimalSort = columns.some((c) => c.numericSort);
  const typeImports = [
    "type ColumnDef",
    ...(needsDecimalSort ? ["type Row"] : []),
    ...(anyFilterable ? ["type ColumnFiltersState"] : []),
    "type PaginationState",
    ...(selection ? ["type RowSelectionState"] : []),
    "type SortingState",
    // Aliased: several Svelte packs import a COMPONENT called `Table`
    // (flowbite-svelte does), and `import { type Table, … }` plus
    // `import { Table } from "flowbite-svelte"` is a duplicate declaration —
    // a hard parse error in the Svelte preprocessor, not a type-only clash.
    "type Table as TanstackTable",
    "type TableOptionsResolved",
    "type Updater",
    ...(columnVisibility ? ["type VisibilityState"] : []),
  ];
  const valueImports = [
    "createTable",
    "getCoreRowModel",
    ...(anyFilterable ? ["getFilteredRowModel"] : []),
    "getPaginationRowModel",
    "getSortedRowModel",
  ];

  const needsRowCast = columns.some((c) => c.cell?.includes(ROW_VAR));
  const rowCastLines = needsRowCast
    ? [
        `  // biome-ignore lint/suspicious/noExplicitAny: cell markup reads declared row fields; the grid is generic over the row type, so property access needs one cast at the boundary.`,
        `  type CellRow = Record<string, any>;`,
        `  const ${ROW_VAR} = (v: T): CellRow => v as CellRow;`,
        ``,
      ]
    : [];

  // The grid chrome's own pack imports, PLUS everything the computed cells
  // pulled in.  Without the second group the component references symbols
  // nothing imported — `<Badge>` from the pack, `formatDateTime` from
  // `$lib/format` — which the page's import block received instead, because
  // that is where the walk parks them.  On Svelte that is a runtime
  // `ReferenceError`, not a build failure.  Merged per source so one
  // `flowbite-svelte` line carries both the chrome's and the cells' names.
  const packImportLines = mergedImports([...spec.packImports, ...spec.cellImports]).map(
    (i) => `  import { ${i.named.join(", ")} } from "${i.from}";`,
  );

  const props = selection
    ? lines(
        `  let { rows, onSelectionChange }: {`,
        `    rows: readonly T[];`,
        `    onSelectionChange: (ids: string[]) => void;`,
        `  } = $props();`,
      )
    : `  let { rows }: { rows: readonly T[] } = $props();`;

  return `${lines(
    `<!-- Auto-generated.  Do not edit by hand. -->`,
    `<script lang="ts" generics="T extends object">`,
    `  import {`,
    ...[...valueImports, ...typeImports].map((n) => `    ${n},`),
    `  } from "@tanstack/table-core";`,
    ...packImportLines,
    ``,
    props,
    ``,
    ...rowCastLines,
    ...stateRunes(spec),
    ``,
    `  /** TanStack hands each \`onXChange\` either the next value or a function`,
    `   *  of the previous one; \`table-core\` leaves that union to the caller. */`,
    ...(columns.some((c) => c.numericSort)
      ? [
          "  /** Comparator for a money / decimal column.  Those reach the row as a Decimal",
          "   *  OBJECT whose valueOf() returns a string, so TanStack's default a < b orders",
          "   *  them lexicographically — an ascending sort comes out [10, 100, 9].  Number()",
          "   *  goes through that same valueOf, which is what makes it a correct numeric",
          "   *  read, and (unlike TanStack's alphanumeric fallback) it stays correct for",
          "   *  negative amounts. */",
          "  function compareDecimal(a: Row<T>, b: Row<T>, id: string): number {",
          "    const x = Number(a.getValue(id) ?? 0);",
          "    const y = Number(b.getValue(id) ?? 0);",
          "    return x < y ? -1 : x > y ? 1 : 0;",
          "  }",
          "",
        ]
      : []),
    `  function applyUpdater<S>(updater: Updater<S>, current: S): S {`,
    `    return typeof updater === "function" ? (updater as (old: S) => S)(current) : updater;`,
    `  }`,
    ``,
    `  const columns: ColumnDef<T>[] = [`,
    ...columnDefs(columns, selection),
    `  ];`,
    ``,
    `  // \`table-core\`'s \`getState()\` returns the RAW \`state\` option — unlike the`,
    `  // framework adapters, it does NOT merge its own defaults in.  A \`state\``,
    `  // carrying only the slices we control therefore throws inside`,
    `  // \`getHeaderGroups()\` (it reads \`columnPinning.left\`) and the grid renders`,
    `  // NOTHING — a runtime-only failure \`svelte-check\` and \`vite build\` are both`,
    `  // blind to.  The adapters spread \`table.initialState\` in; with no adapter we`,
    `  // source it once from a throwaway instance (the defaults are constant).`,
    `  const defaultState = createTable({`,
    `    data: [],`,
    `    columns,`,
    `    state: {},`,
    `    onStateChange: () => {},`,
    `    renderFallbackValue: null,`,
    `    getCoreRowModel: getCoreRowModel(),`,
    `  } as TableOptionsResolved<T>).initialState;`,
    ``,
    `  // Rebuilding on each change is correct because EVERY state slice above is`,
    `  // controlled — nothing uncontrolled is left to lose — and reading those`,
    `  // runes here is the dependency edge the markup needs (table-core mutates`,
    `  // its own internals, which Svelte cannot observe).`,
    `  const table: TanstackTable<T> = $derived.by(() => {`,
    `    const options: TableOptionsResolved<T> = {`,
    `      // \`rows\` binds as \`readonly T[]\`; TanStack's \`data\` is mutable.`,
    `      data: (rows ?? []) as T[],`,
    `      columns,`,
    `      state: { ...defaultState, ${stateSliceNames(spec).join(", ")} },`,
    ...changeHandlers(spec),
    `      // Every slice has its own handler above, so the aggregate hook is a`,
    `      // no-op; \`table-core\` requires it to be present.`,
    `      onStateChange: () => {},`,
    `      renderFallbackValue: null,`,
    ...(selection ? [`      enableRowSelection: true,`] : []),
    `      enableMultiSort: ${multiSort},`,
    `      getCoreRowModel: getCoreRowModel(),`,
    `      getSortedRowModel: getSortedRowModel(),`,
    ...(anyFilterable ? [`      getFilteredRowModel: getFilteredRowModel(),`] : []),
    `      getPaginationRowModel: getPaginationRowModel(),`,
    `    };`,
    `    return createTable(options);`,
    `  });`,
    ...(selection ? ["", ...selectionEffect()] : []),
    `</script>`,
    ``,
  )}${body}
`;
}

/** The walker binds a computed cell's row through this helper — see
 *  `svelteTarget.dataGridRowVar`. */
const ROW_VAR = "asRow";

function stateRunes(spec: DataGridSpec): string[] {
  const out = [`  let sorting = $state<SortingState>([]);`];
  if (spec.selection !== undefined) out.push(`  let rowSelection = $state<RowSelectionState>({});`);
  if (spec.anyFilterable) out.push(`  let columnFilters = $state<ColumnFiltersState>([]);`);
  if (spec.columnVisibility) out.push(`  let columnVisibility = $state<VisibilityState>({});`);
  // Pagination is controlled like the rest — see the `$derived.by` note.
  out.push(
    `  let pagination = $state<PaginationState>({ pageIndex: 0, pageSize: ${spec.pageSize} });`,
  );
  return out;
}

function stateSliceNames(spec: DataGridSpec): string[] {
  return [
    "sorting",
    ...(spec.selection !== undefined ? ["rowSelection"] : []),
    ...(spec.anyFilterable ? ["columnFilters"] : []),
    ...(spec.columnVisibility ? ["columnVisibility"] : []),
    "pagination",
  ];
}

function changeHandlers(spec: DataGridSpec): string[] {
  const pairs: [string, string][] = [["onSortingChange", "sorting"]];
  if (spec.selection !== undefined) pairs.push(["onRowSelectionChange", "rowSelection"]);
  if (spec.anyFilterable) pairs.push(["onColumnFiltersChange", "columnFilters"]);
  if (spec.columnVisibility) pairs.push(["onColumnVisibilityChange", "columnVisibility"]);
  pairs.push(["onPaginationChange", "pagination"]);
  return pairs.map(
    ([handler, name]) => `      ${handler}: (u) => { ${name} = applyUpdater(u, ${name}); },`,
  );
}

/** Report the selected row ids up to the page.
 *
 *  `void rowSelection` is the explicit dependency: the effect must re-run when
 *  the selection MAP changes, and the ids come off `table`, so nothing else in
 *  the body would register that read. */
function selectionEffect(): string[] {
  return [
    `  $effect(() => {`,
    `    void rowSelection;`,
    `    onSelectionChange(`,
    `      table`,
    `        .getSelectedRowModel()`,
    `        .rows.map((r) => String((r.original as { id?: unknown }).id ?? r.index)),`,
    `    );`,
    `  });`,
  ];
}

/** Column defs.  A non-trivial accessor gets NO `cell` here — its markup is in
 *  the template, keyed by column id (same split as Vue). */
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

/** The full header-cell content: the select-all checkbox (when selection is
 *  on), a sortable header button, or the plain header. */
function headerBody(selection: boolean): string {
  const style =
    "background: none; border: none; padding: 0; font: inherit; cursor: pointer; user-select: none;";
  const label = `{String(h.column.columnDef.header ?? h.id)}`;
  const indicator = `{h.column.getIsSorted() === "asc" ? " ↑" : h.column.getIsSorted() === "desc" ? " ↓" : ""}`;
  return lines(
    ...(selection
      ? [
          `{#if h.column.id === "loom-select"}`,
          `  <input`,
          `    type="checkbox"`,
          `    aria-label="Select all rows"`,
          `    checked={table.getIsAllPageRowsSelected()}`,
          `    onchange={() => table.toggleAllPageRowsSelected()}`,
          `  />`,
          `{:else if h.column.getCanSort()}`,
        ]
      : [`{#if h.column.getCanSort()}`]),
    `  <button`,
    `    type="button"`,
    `    style="${style}"`,
    `    aria-label={\`Sort by \${String(h.column.columnDef.header ?? h.id)}\`}`,
    `    onclick={() => h.column.toggleSorting()}`,
    `  >`,
    `    ${label}${indicator}`,
    `  </button>`,
    `{:else}`,
    `  ${label}`,
    `{/if}`,
  );
}

/** The full body-cell content: the row checkbox, then one branch per column
 *  whose accessor was too rich for an `accessorKey`, then the plain value.
 *
 *  Branching on `c.column.id` rather than an index keeps it correct under the
 *  column reordering and hiding TanStack does at runtime. */
function cellBody(columns: readonly DataGridColumn[], selection: boolean): string {
  const branches: string[] = [];
  if (selection) {
    branches.push(
      lines(
        `{#if c.column.id === "loom-select"}`,
        `  <input`,
        `    type="checkbox"`,
        `    aria-label="Select row"`,
        `    checked={c.row.getIsSelected()}`,
        `    disabled={!c.row.getCanSelect()}`,
        `    onchange={() => c.row.toggleSelected()}`,
        `  />`,
      ),
    );
  }
  for (const col of columns) {
    if (col.cell === undefined) continue;
    branches.push(
      lines(
        `${branches.length === 0 ? "{#if" : "{:else if"} c.column.id === ${JSON.stringify(col.id)}}`,
        `  ${col.cell}`,
      ),
    );
  }
  if (branches.length === 0) return `{String(c.getValue() ?? "")}`;
  return lines(...branches, `{:else}`, `  {String(c.getValue() ?? "")}`, `{/if}`);
}
