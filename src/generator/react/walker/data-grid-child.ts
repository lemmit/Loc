// React's `DataGrid` child component — the TSX half of the `renderDataGridChild`
// seam (M-T1.1 slice 10).
//
// WHY IT IS A COMPONENT, NOT MARKUP
// ---------------------------------
// `useReactTable` is a React hook, so it must run at a component's top level.
// A DataGrid almost always renders inside a `QueryView`'s `data:` slot, which
// the walker emits as a CONDITIONAL expression (`{rows && <…/>}`) — hooks
// cannot run there.  Hoisting the hook to the page component's top level does
// not work either: it needs `rows`, which only exists inside the QueryView
// lambda.  And a component declared *inside* the page would get a fresh
// identity on every render, remounting the grid and losing its sort state.
//
// So the child lands at MODULE scope in the page's own file — which TSX
// permits and a Vue SFC / `.svelte` file does not (those targets return a
// sibling `file` instead; see `DataGridChild`).
//
// The emitted shape is compile-verified against real `@tanstack/react-table`
// v8 + React 19 under `strict` + `noUnusedLocals`; in particular the child is
// generic over the row type (`<T extends object>`) so no DTO type name has to
// be resolved here, and `data:` takes a `as T[]` cast because the walker binds
// `rows` as `readonly T[]`.

import { CHROME_T_CALL } from "../../_walker/i18n-emit.js";
import { addImport, addImportsForPrimitive } from "../../_walker/render-primitive.js";
import type { DataGridChild, DataGridSpec } from "../../_walker/target.js";
import type { WalkContext } from "../../_walker/walker-core.js";

export function renderReactDataGridChild(spec: DataGridSpec, ctx: WalkContext): DataGridChild {
  const { anyFilterable, columnVisibility } = spec;
  const selection = spec.selection !== undefined;

  addImport(ctx, "react", "useMemo", "useState");
  if (selection) addImport(ctx, "react", "useEffect");
  addImport(
    ctx,
    "@tanstack/react-table",
    "flexRender",
    "getCoreRowModel",
    "getPaginationRowModel",
    "getSortedRowModel",
    "useReactTable",
    ...(anyFilterable ? ["getFilteredRowModel"] : []),
  );
  // Type-only names are imported alongside; the emitted file uses `import type`
  // via the shared import renderer's `type ` prefix convention where the pack
  // supports it, else a plain value import (erased by the bundler).
  addImport(
    ctx,
    "@tanstack/react-table",
    "type ColumnDef",
    "type SortingState",
    ...(spec.columns.some((c) => c.numericSort) ? ["type Row"] : []),
    ...(anyFilterable ? ["type ColumnFiltersState"] : []),
    ...(columnVisibility ? ["type VisibilityState"] : []),
    ...(selection ? ["type RowSelectionState"] : []),
  );

  // React's body lands in the page's own file, so the pack's declared imports
  // join the page's import block — the behaviour `renderPrimitive` used to give
  // for free before the body render moved behind the seam.
  addImportsForPrimitive(ctx, "primitive-data-grid");

  // Pack-chrome i18n (M-T1.11).  The pack's grid markup may carry
  // `t("chrome.previous", …)` pager labels, and the shared chrome helpers
  // deliberately register no import (on Vue/Svelte/Angular this markup lands in
  // a SEPARATE file, where the page's import map would be the wrong place).
  // React is the easy case — the child is a module decl in the PAGE's own file,
  // so `t` on the page's import block is exactly the binding it resolves
  // against, and `renderImportLines` rewrites `../i18n` to the page's depth.
  // Gated on the RENDERED body so a pack that bakes in no chrome gets no
  // import; i18n off never emits the call at all, so output stays identical.
  const body = spec.renderBody();
  if (body.includes(CHROME_T_CALL)) addImport(ctx, "../i18n", "t");

  return {
    moduleDecl: renderGridComponent(spec, body),
    // The call site is a single element — the grid's own layout lives inside
    // the hoisted component, so no depth-based indentation is needed here.
    callSite: spec.selection
      ? `<${spec.componentName} rows={${spec.rowsExpr}} onSelectionChange={${setterFor(spec.selection)}} />`
      : `<${spec.componentName} rows={${spec.rowsExpr}} />`,
  };
}

/** React's `useState` setter name for a page-state field (`picked` →
 *  `setPicked`) — the page shell's own naming, mirrored here so the child's
 *  `onSelectionChange` prop binds straight to it. */
function setterFor(field: string): string {
  return `set${field[0]!.toUpperCase()}${field.slice(1)}`;
}

/** Render the hoisted child component: column defs, view state, the
 *  `useReactTable` call, and the pack-rendered markup. */
/** The walker binds a computed cell's row to this local — see
 *  `tsxTarget.dataGridRowVar`. */
const ROW_VAR = "__loomRow";

function renderGridComponent(spec: DataGridSpec, body: string): string {
  const { componentName, columns, multiSort, columnVisibility, anyFilterable, pageSize } = spec;
  const selection = spec.selection !== undefined;

  // A leading checkbox column when selection is on.  Emitted by the WALKER as
  // plain `<input type="checkbox">` rather than a pack component: it is the one
  // cell whose behaviour (not appearance) is load-bearing, and keeping it here
  // means selection needs no template change in any of the four packs — and
  // ports to Vue/Svelte/Angular unchanged.
  const selectCol = selection
    ? `        {
          id: "loom-select",
          header: ({ table: tbl }) => (
            <input
              type="checkbox"
              ${spec.selectAllRowsAria}
              checked={tbl.getIsAllPageRowsSelected()}
              onChange={tbl.getToggleAllPageRowsSelectedHandler()}
            />
          ),
          cell: ({ row }) => (
            <input
              type="checkbox"
              ${spec.selectRowAria}
              checked={row.getIsSelected()}
              disabled={!row.getCanSelect()}
              onChange={row.getToggleSelectedHandler()}
            />
          ),
          enableSorting: false,
          enableColumnFilter: false,
        },`
    : "";

  const colDefs = columns
    .map((c) => {
      const parts = [`id: ${JSON.stringify(c.id)}`];
      if (c.accessorKey) parts.push(`accessorKey: ${JSON.stringify(c.accessorKey)}`);
      parts.push(`header: ${JSON.stringify(c.header)}`);
      if (c.cell) {
        // A computed cell reads the row, so bind it — the pre-`cell: ({ row })`
        // shape emitted an UNBOUND `row` and failed `tsc` (found by compiling a
        // generated project with a formatting accessor).  The local is omitted
        // when the markup doesn't reference it, or `noUnusedVariables` fires on
        // the emitted output.
        parts.push(
          c.cell.includes(ROW_VAR)
            ? `cell: ({ row }) => { const ${ROW_VAR} = row.original as CellRow; return ${c.cell}; }`
            : `cell: () => ${c.cell}`,
        );
      }
      parts.push(`enableSorting: ${c.sortable}`);
      parts.push(`enableColumnFilter: ${c.filterable}`);
      // A money/decimal column needs an explicit numeric comparator — see
      // `DataGridColumn.numericSort`.
      if (c.numericSort) parts.push("sortingFn: compareDecimal");
      return `        { ${parts.join(", ")} },`;
    })
    .join("\n");
  const allColDefs = selectCol === "" ? colDefs : `${selectCol}\n${colDefs}`;

  const stateDecls = [
    `  const [sorting, setSorting] = useState<SortingState>([]);`,
    selection ? `  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});` : "",
    anyFilterable
      ? `  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);`
      : "",
    columnVisibility
      ? `  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});`
      : "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const tableState = [
    "sorting",
    selection ? "rowSelection" : "",
    anyFilterable ? "columnFilters" : "",
    columnVisibility ? "columnVisibility" : "",
  ]
    .filter((s) => s !== "")
    .join(", ");

  const changeHandlers = [
    `    onSortingChange: setSorting,`,
    selection ? `    onRowSelectionChange: setRowSelection,` : "",
    selection ? `    enableRowSelection: true,` : "",
    anyFilterable ? `    onColumnFiltersChange: setColumnFilters,` : "",
    columnVisibility ? `    onColumnVisibilityChange: setColumnVisibility,` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const rowModels = [
    `    getCoreRowModel: getCoreRowModel(),`,
    `    getSortedRowModel: getSortedRowModel(),`,
    anyFilterable ? `    getFilteredRowModel: getFilteredRowModel(),` : "",
    `    getPaginationRowModel: getPaginationRowModel(),`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  // Push the selected row ids up to the page's `string[]` state whenever the
  // selection map changes.  TanStack keys its map by row INDEX by default, so
  // the ids come from the row originals — falling back to the index only when a
  // row has no `id`, which keeps the emitted code total without assuming the
  // wire shape.  The effect depends on `rowSelection` (not the derived array)
  // so it fires exactly once per selection change.
  const selectionSync = selection
    ? `  useEffect(() => {
    onSelectionChange(
      table
        .getSelectedRowModel()
        .rows.map((r) => String((r.original as { id?: unknown }).id ?? r.index)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowSelection]);
`
    : "";

  // `rows` arrives as `readonly T[]` from the walker's binding; TanStack's
  // `data` is mutable, hence the cast.  The component is generic so no DTO
  // type name has to be resolved at generate time.
  const props = selection
    ? `{ rows, onSelectionChange }: { rows: readonly T[]; onSelectionChange: (ids: string[]) => void }`
    : `{ rows }: { rows: readonly T[] }`;
  // One cast type for every computed cell in this grid.  `any` is deliberate
  // and confined: the child is generic over the row type (so no DTO type name
  // has to be resolved at generate time), and a cell's markup reads declared
  // row fields of every scalar kind — `Record<string, unknown>` would make each
  // read `unknown`, which JSX children reject.
  const cellRowType = columns.some((c) => c.cell?.includes(ROW_VAR))
    ? `  // biome-ignore lint/suspicious/noExplicitAny: cell markup reads declared row fields; the grid child is generic over the row type, so property access needs one cast at the boundary.\n  type CellRow = Record<string, any>;\n`
    : "";

  // Emitted at module scope, ahead of the component, when any column needs it.
  // `Row<any>` (not `Row<T>`): the helper sits OUTSIDE the generic component and
  // only ever reads a value through `getValue`, so the row's shape is irrelevant
  // to it — parameterising it would force the type through every call site.
  const decimalCmp = columns.some((c) => c.numericSort)
    ? [
        "// Comparator for a money / decimal column.  Those reach the row as a Decimal",
        "// OBJECT whose valueOf() returns a string, so TanStack's default a < b orders",
        "// them lexicographically — an ascending sort comes out [10, 100, 9].  Number()",
        "// goes through that same valueOf, which is what makes it a correct numeric",
        "// read, and (unlike TanStack's alphanumeric fallback) it stays correct for",
        "// negative amounts.",
        "// biome-ignore lint/suspicious/noExplicitAny: the comparator reads through getValue and never touches the row shape.",
        "function compareDecimal(a: Row<any>, b: Row<any>, id: string): number {",
        "  const x = Number(a.getValue(id) ?? 0);",
        "  const y = Number(b.getValue(id) ?? 0);",
        "  return x < y ? -1 : x > y ? 1 : 0;",
        "}",
        "",
      ].join("\n")
    : "";

  return `${decimalCmp}function ${componentName}<T extends object>(${props}) {
${cellRowType}${stateDecls}
  const columns = useMemo<ColumnDef<T>[]>(
    () => [
${allColDefs}
    ],
    [],
  );
  const table = useReactTable({
    data: (rows ?? []) as T[],
    columns,
    state: { ${tableState} },
${changeHandlers}
    enableMultiSort: ${multiSort},
${rowModels}
    initialState: { pagination: { pageSize: ${pageSize} } },
  });
${selectionSync}  return (
${body}
  );
}
`;
}
