// Vue's `DataGrid` child component — the SFC half of the `renderDataGridChild`
// seam (M-T1.1 slice 10).
//
// WHY A SIBLING FILE, NOT A MODULE DECLARATION
// --------------------------------------------
// React puts the grid's child at module scope in the page's own file.  A Vue
// SFC cannot: `<script setup>` compiles to exactly ONE component per file.  So
// this target returns a whole `src/components/<Name>.vue` through
// `ctx.hoistedComponentFiles`, and registers the name in
// `ctx.usedUserComponents` — the page shell already emits a depth-correct
// default import for every entry there, which is exactly the import the call
// site needs (a scaffold page two directories deep gets `../../components/…`).
//
// WHY THE CELLS RENDER IN THE TEMPLATE
// ------------------------------------
// React's column defs carry `cell: () => <JSX/>`.  Vue cannot: a `cell`
// function must return VNodes, and the walker produces TEMPLATE markup, not
// `h()` calls.  So a column with a non-trivial accessor keeps its markup in the
// template, selected by column id, and only simple `accessorKey` columns fall
// through to `FlexRender`.  Same for the selection checkboxes — which is the
// same decision React made for a different reason (behaviour, not appearance,
// so it stays out of the pack).  This is a genuine topology divergence, which
// is why the whole child is a seam rather than a parameterised template.
//
// The emitted shape is compile-verified against real `@tanstack/vue-table`
// 8.21 + Vue 3.5 under `vue-tsc --strict` + `noUnusedLocals`: the SFC is
// generic (`generic="T extends object"`), reactivity flows through `get`
// accessors on the options object (the documented Vue adapter idiom), and each
// `onXChange` handler resolves TanStack's updater-or-value union through one
// shared `applyUpdater` helper.

import { lines } from "../../../util/code-builder.js";
import type { DataGridChild, DataGridColumn, DataGridSpec } from "../../_walker/target.js";
import type { WalkContext } from "../../_walker/walker-core.js";

export function renderVueDataGridChild(spec: DataGridSpec, ctx: WalkContext): DataGridChild {
  const selection = spec.selection;

  // The page shell turns every `usedUserComponents` entry into a depth-correct
  // `import <Name> from "<prefix>components/<Name>.vue"`, so registering here is
  // all the import wiring this needs.
  ctx.usedUserComponents.add(spec.componentName);

  return {
    file: {
      path: `src/components/${spec.componentName}.vue`,
      content: renderSfc(spec),
    },
    // `@selection-change` is the kebab-case form of the `selectionChange` emit;
    // the payload is the id array, written straight into the page's ref (Vue
    // unwraps a top-level ref in an inline template handler).
    callSite: selection
      ? `<${spec.componentName} :rows="${spec.rowsExpr}" @selection-change="${selection} = $event" />`
      : `<${spec.componentName} :rows="${spec.rowsExpr}" />`,
  };
}

/** The whole `src/components/<Name>.vue` file. */
function renderSfc(spec: DataGridSpec): string {
  const { columns, multiSort, columnVisibility, anyFilterable, pageSize } = spec;
  const selection = spec.selection !== undefined;
  // Vue's packs get the header + cell CONTENT from the walker and supply only
  // the surrounding chrome — see the file header for why the cells can't live
  // in the column defs.  Consistent with `Table` on Vue, whose sortable header
  // is likewise a walker-emitted `<button>` with inline reset styles
  // (`vueTarget.renderSortableHeader`), not pack markup.
  const body = spec.renderBody({
    headerBody: headerBody(selection),
    cellBody: cellBody(columns, selection),
  });

  const typeImports = [
    "type ColumnDef",
    "type SortingState",
    "type Updater",
    ...(anyFilterable ? ["type ColumnFiltersState"] : []),
    ...(columnVisibility ? ["type VisibilityState"] : []),
    ...(selection ? ["type RowSelectionState"] : []),
  ];
  const valueImports = [
    "FlexRender",
    "getCoreRowModel",
    ...(anyFilterable ? ["getFilteredRowModel"] : []),
    "getPaginationRowModel",
    "getSortedRowModel",
    "useVueTable",
  ];

  // `watch` only when selection has to be reported back out; `ref`/`computed`
  // are always needed.  Listing exactly what is used keeps the SFC clean under
  // `noUnusedLocals`.
  const vueImports = ["computed", "ref", ...(selection ? ["watch"] : [])];

  // One cast helper for every computed cell in this grid.  `any` is deliberate
  // and confined: the SFC is generic over the row type (so no DTO type name has
  // to be resolved at generate time), and a cell's markup reads declared row
  // fields of every scalar kind — `Record<string, unknown>` would make each read
  // `unknown`, which the template's interpolation rejects.  Emitted only when a
  // cell actually calls it, or `noUnusedLocals` fires on the SFC.
  const needsRowCast = columns.some((c) => c.cell?.includes("asRow("));
  const rowCastLines = needsRowCast
    ? [
        `// biome-ignore lint/suspicious/noExplicitAny: cell markup reads declared row fields; the grid is generic over the row type, so property access needs one cast at the boundary.`,
        `type CellRow = Record<string, any>;`,
        `const asRow = (v: T): CellRow => v as CellRow;`,
        ``,
      ]
    : [];

  // The pack's own components (its table chrome) are imported HERE, not on the
  // page: the body they belong to lives in this file, and a page importing them
  // unused would fail `vue-tsc` under `noUnusedLocals`.
  const packImportLines = spec.packImports.map(
    (i) => `import { ${[...i.named].sort().join(", ")} } from "${i.from}";`,
  );

  return `${lines(
    `<!-- Auto-generated.  Do not edit by hand. -->`,
    `<script setup lang="ts" generic="T extends object">`,
    `import { ${vueImports.join(", ")} } from "vue";`,
    `import {`,
    ...[...valueImports, ...typeImports].map((n) => `  ${n},`),
    `} from "@tanstack/vue-table";`,
    ...packImportLines,
    ``,
    `const props = defineProps<{ rows: readonly T[] }>();`,
    ...(selection ? [`const emit = defineEmits<{ selectionChange: [ids: string[]] }>();`] : []),
    ``,
    ...rowCastLines,
    ...stateRefs(spec),
    ``,
    `/** TanStack hands each \`onXChange\` either the next value or a function of`,
    ` *  the previous one; Vue's adapter leaves that union to the caller. */`,
    `function applyUpdater<S>(updater: Updater<S>, current: S): S {`,
    `  return typeof updater === "function" ? (updater as (old: S) => S)(current) : updater;`,
    `}`,
    ``,
    `const columns = computed<ColumnDef<T>[]>(() => [`,
    ...columnDefs(columns, selection),
    `]);`,
    ``,
    `const table = useVueTable({`,
    `  // Reactivity flows through getters — the documented Vue-adapter idiom.`,
    `  // \`rows\` binds as \`readonly T[]\`; TanStack's \`data\` is mutable.`,
    `  get data() {`,
    `    return (props.rows ?? []) as T[];`,
    `  },`,
    `  get columns() {`,
    `    return columns.value;`,
    `  },`,
    `  state: {`,
    ...stateGetters(spec),
    `  },`,
    ...changeHandlers(spec),
    ...(selection ? [`  enableRowSelection: true,`] : []),
    `  enableMultiSort: ${multiSort},`,
    `  getCoreRowModel: getCoreRowModel(),`,
    `  getSortedRowModel: getSortedRowModel(),`,
    ...(anyFilterable ? [`  getFilteredRowModel: getFilteredRowModel(),`] : []),
    `  getPaginationRowModel: getPaginationRowModel(),`,
    `  initialState: { pagination: { pageSize: ${pageSize} } },`,
    `});`,
    ...(selection ? ["", ...selectionWatch()] : []),
    `</script>`,
    ``,
    `<template>`,
  )}
${body}
</template>
`;
}

function stateRefs(spec: DataGridSpec): string[] {
  const out = [`const sorting = ref<SortingState>([]);`];
  if (spec.selection !== undefined) out.push(`const rowSelection = ref<RowSelectionState>({});`);
  if (spec.anyFilterable) out.push(`const columnFilters = ref<ColumnFiltersState>([]);`);
  if (spec.columnVisibility) out.push(`const columnVisibility = ref<VisibilityState>({});`);
  return out;
}

function stateGetters(spec: DataGridSpec): string[] {
  const names = [
    "sorting",
    ...(spec.selection !== undefined ? ["rowSelection"] : []),
    ...(spec.anyFilterable ? ["columnFilters"] : []),
    ...(spec.columnVisibility ? ["columnVisibility"] : []),
  ];
  return names.flatMap((n) => [`    get ${n}() {`, `      return ${n}.value;`, `    },`]);
}

function changeHandlers(spec: DataGridSpec): string[] {
  const pairs: [string, string][] = [["onSortingChange", "sorting"]];
  if (spec.selection !== undefined) pairs.push(["onRowSelectionChange", "rowSelection"]);
  if (spec.anyFilterable) pairs.push(["onColumnFiltersChange", "columnFilters"]);
  if (spec.columnVisibility) pairs.push(["onColumnVisibilityChange", "columnVisibility"]);
  return pairs.flatMap(([handler, name]) => [
    `  ${handler}: (updater) => {`,
    `    ${name}.value = applyUpdater(updater, ${name}.value);`,
    `  },`,
  ]);
}

/** Push the selected row ids up to the page whenever the selection map changes.
 *
 *  TanStack keys its map by row INDEX by default, so the ids come from the row
 *  originals — falling back to the index only when a row has no `id`, which
 *  keeps the emitted code total without assuming the wire shape. */
function selectionWatch(): string[] {
  return [
    `watch(rowSelection, () => {`,
    `  emit(`,
    `    "selectionChange",`,
    `    table`,
    `      .getSelectedRowModel()`,
    `      .rows.map((r) => String((r.original as { id?: unknown }).id ?? r.index)),`,
    `  );`,
    `});`,
  ];
}

/** Column defs.  A non-trivial accessor gets NO `cell` here — its markup is in
 *  the template, keyed by column id (see the file header). */
function columnDefs(columns: readonly DataGridColumn[], selection: boolean): string[] {
  const out: string[] = [];
  if (selection) {
    out.push(
      `  { id: "loom-select", header: "", enableSorting: false, enableColumnFilter: false },`,
    );
  }
  for (const c of columns) {
    const parts = [`id: ${JSON.stringify(c.id)}`];
    if (c.accessorKey) parts.push(`accessorKey: ${JSON.stringify(c.accessorKey)}`);
    parts.push(`header: ${JSON.stringify(c.header)}`);
    parts.push(`enableSorting: ${c.sortable}`);
    parts.push(`enableColumnFilter: ${c.filterable}`);
    out.push(`  { ${parts.join(", ")} },`);
  }
  return out;
}

/** The full `<th>` content: the select-all checkbox (when selection is on), a
 *  sortable header button, or the plain header. */
function headerBody(selection: boolean): string {
  const style =
    "background: none; border: none; padding: 0; font: inherit; cursor: pointer; user-select: none;";
  const indicator =
    `{{ h.column.getIsSorted() === "asc" ? " ↑" ` +
    `: h.column.getIsSorted() === "desc" ? " ↓" : "" }}`;
  return lines(
    ...(selection
      ? [
          `<input`,
          `  v-if="h.column.id === 'loom-select'"`,
          `  type="checkbox"`,
          `  aria-label="Select all rows"`,
          `  :checked="table.getIsAllPageRowsSelected()"`,
          `  @change="table.toggleAllPageRowsSelected()"`,
          `/>`,
        ]
      : []),
    `<button`,
    `  ${selection ? "v-else-if" : "v-if"}="h.column.getCanSort()"`,
    `  type="button"`,
    `  style="${style}"`,
    `  :aria-label="\`Sort by \${String(h.column.columnDef.header ?? h.id)}\`"`,
    `  @click="h.column.toggleSorting()"`,
    `>`,
    `  <FlexRender :render="h.column.columnDef.header" :props="h.getContext()" />`,
    `  <span>${indicator}</span>`,
    `</button>`,
    `<FlexRender v-else :render="h.column.columnDef.header" :props="h.getContext()" />`,
  );
}

/** The full `<td>` content: the row checkbox, then one branch per column whose
 *  accessor was too rich for an `accessorKey`, then `FlexRender` for the rest.
 *
 *  Selecting by `c.column.id` rather than by index keeps the branch correct
 *  under column reordering and hiding, both of which TanStack does at runtime. */
function cellBody(columns: readonly DataGridColumn[], selection: boolean): string {
  const branches: string[] = [];
  if (selection) {
    branches.push(
      lines(
        `<input`,
        `  v-if="c.column.id === 'loom-select'"`,
        `  type="checkbox"`,
        `  aria-label="Select row"`,
        `  :checked="c.row.getIsSelected()"`,
        `  :disabled="!c.row.getCanSelect()"`,
        `  @change="c.row.toggleSelected()"`,
        `/>`,
      ),
    );
  }
  for (const col of columns) {
    if (col.cell === undefined) continue;
    const guard = branches.length === 0 ? "v-if" : "v-else-if";
    branches.push(
      lines(
        // Single quotes: the guard sits inside a double-quoted HTML attribute,
        // so `JSON.stringify` here would close it early and emit invalid markup.
        `<template ${guard}="c.column.id === '${col.id}'">`,
        `  ${col.cell}`,
        `</template>`,
      ),
    );
  }
  const rest =
    branches.length === 0
      ? `<FlexRender :render="c.column.columnDef.cell" :props="c.getContext()" />`
      : `<FlexRender v-else :render="c.column.columnDef.cell" :props="c.getContext()" />`;
  return lines(...branches, rest);
}
