// Feliz's `DataGrid` child component — the F# half of the `renderDataGridChild`
// seam (M-T1.1 slice 10e).
//
// WHY FELIZ CAN HAVE A REAL DataGrid AND FLUTTER CANNOT
// -----------------------------------------------------
// `DataGrid` is not a markup mapping: it is a TanStack row model (multi-column
// sort, per-column filters, column visibility, pagination, row selection) that
// each target wires to its own reactivity.  Re-implementing that row model per
// target is exactly the behavioural fork the shared seam exists to prevent — so
// a target can only host a grid if it can host TANSTACK, not merely a table.
//
// Fable compiles F# to JavaScript, so Feliz can.  It rides
// **`@tanstack/table-core`** — the framework-agnostic package every official
// adapter wraps, already the Svelte target's choice — reached through ordinary
// Fable interop (`[<Import>]` / `[<Emit>]`, the same escape hatch the toast and
// EventSource bindings use).  The row model executing here is byte-for-byte the
// one React, Vue, Svelte and Angular execute.  Flutter's native target has no
// JS runtime at all (its CI builds a real APK), which is why it stays an
// honest, permanent gap — see `src/util/flutter-deferred-primitives.ts`.
//
// WHY A CHILD COMPONENT (Feliz has no separate component FILES)
// -------------------------------------------------------------
// Grid state must survive the page re-rendering, and a `DataGrid` almost always
// sits in a `QueryView`'s `data:` slot — which Feliz emits as a lambda passed to
// `View.remoteList`, i.e. a CONDITIONAL call inside the page's `view`.  React
// hooks cannot run there.  So the grid becomes a `[<ReactComponent>]` function
// (Feliz renders through React, so `React.useState` is available) declared at
// module scope in `App.fs` and reached through `moduleDecl` — React's shape, not
// Vue/Svelte's sibling `file`, because an F# module holds many declarations.
//
// F# is order-sensitive, so `index.ts` splices these declarations after the
// wire layer and BEFORE the page views that call them.
//
// WHY THE ROW IS A PROJECTED JS OBJECT
// ------------------------------------
// TanStack reads rows by `accessorKey`, and the walker deliberately resolves no
// DTO type name (the JSX children are generic over the row type).  F# has no
// structural typing to stand in for that generic, so the CALL SITE — where the
// row list is fully typed — projects each row into a plain JS object: one key
// per `accessorKey` column holding the raw field value, plus one
// `loom-cell-<id>` key per COMPUTED column holding a `unit -> ReactElement`
// thunk that closes over the typed row.  The thunk keeps cell markup lazy (only
// visible rows render) and keeps every type name out of the child.
//
// The projected values are RAW, deliberately.  Fable maps `decimal`/`money` to a
// Decimal object whose `valueOf()` returns a string — but so does the JSX
// frontends' `decimal.js` Decimal, which their DTOs parse money into.  Handing
// TanStack the raw value therefore gives Feliz exactly the sort/filter/display
// semantics the other four already have.  Normalising to a JS number here would
// FORK the behaviour (different sort order AND a different default sort
// direction, since `getAutoSortDir` branches on `typeof value === "string"`) —
// the opposite of the point.  The money-sort weakness that leaves is real and
// SHARED, so it was fixed once across all five: a money column carries an
// explicit numeric `sortingFn` (`loomCompareDecimal` here, `compareDecimal` on
// the JSX targets), which is the only place the raw value is not what TanStack
// should compare.

import { lines } from "../../util/code-builder.js";
import { localizedChromeIcuExpr, localizedChromeIcuValue } from "../_walker/i18n-emit.js";
import type { DataGridChild, DataGridColumn, DataGridSpec } from "../_walker/target.js";
import type { WalkContext } from "../_walker/walker-core.js";

/** The lambda parameter a computed cell's accessor binds to — see
 *  `felizTarget.dataGridRowVar`.  It is the projection lambda's row, so cell
 *  markup is ordinary typed F# field access (`row.tier`). */
export const FELIZ_GRID_ROW_VAR = "row";

/** The selection column's synthetic id, shared with the pack's cell/header
 *  branches.  Same id the Vue/Svelte/Angular targets use, so a page object
 *  written against one grid reads the same on all of them. */
const SELECT_COL = "loom-select";

/** Interop preamble — emitted ONCE into `App.fs` when the ui contains any
 *  `DataGrid`, ahead of every grid declaration.
 *
 *  Everything here is a thin binding to `@tanstack/table-core` or a one-line
 *  JS shim for something F# cannot spell.  Deliberately small: the more logic
 *  that lives on this side, the more of the row model is Loom's rather than
 *  TanStack's. */
export const FELIZ_GRID_PRELUDE: string = lines(
  "// --- DataGrid runtime — @tanstack/table-core through Fable interop -------",
  "//",
  "// The SAME row model the React / Vue / Svelte / Angular grids run: `table-core`",
  "// is the framework-agnostic package every official adapter wraps, so Feliz",
  "// shares the behaviour rather than re-implementing it.",
  '[<Fable.Core.Import("createTable", "@tanstack/table-core")>]',
  "let private loomCreateTable (options: obj) : obj = jsNative",
  "",
  '[<Fable.Core.Import("getCoreRowModel", "@tanstack/table-core")>]',
  "let private loomCoreRowModel () : obj = jsNative",
  "",
  '[<Fable.Core.Import("getSortedRowModel", "@tanstack/table-core")>]',
  "let private loomSortedRowModel () : obj = jsNative",
  "",
  '[<Fable.Core.Import("getFilteredRowModel", "@tanstack/table-core")>]',
  "let private loomFilteredRowModel () : obj = jsNative",
  "",
  '[<Fable.Core.Import("getPaginationRowModel", "@tanstack/table-core")>]',
  "let private loomPaginationRowModel () : obj = jsNative",
  "",
  "/// TanStack hands each `onXChange` either the next value or a function of the",
  "/// previous one; `table-core` leaves that union to the caller (the adapters",
  "/// normally resolve it).",
  "[<Fable.Core.Emit(\"typeof $0 === 'function' ? $0($1) : $0\")>]",
  "let private loomApplyUpdater (updater: obj) (current: obj) : obj = jsNative",
  "",
  "/// `table.getState()` returns the RAW `state` option — `table-core` does NOT",
  "/// merge its defaults in.  A partial state therefore throws inside",
  "/// `getHeaderGroups()` (reading `columnPinning.left`), which no compiler can",
  "/// see.  The official adapters spread `table.initialState` in; with no adapter",
  "/// we do it ourselves.",
  '[<Fable.Core.Emit("Object.assign({}, $0, $1)")>]',
  "let private loomMergeState (defaults: obj) (own: obj) : obj = jsNative",
  "",
  "/// A computed column's cell thunk, looked up on the projected row by column",
  "/// id; `null` for a plain `accessorKey` column, which renders its value.",
  "[<Fable.Core.Emit(\"$0.row.original['loom-cell-' + $0.column.id] ?? null\")>]",
  "let private loomCellThunk (cell: obj) : obj = jsNative",
  "",
  "/// Display text for a plain cell — `String(value)`, matching what the JSX",
  "/// grids render, with null/undefined collapsing to the empty string.",
  "[<Fable.Core.Emit(\"$0 == null ? '' : String($0)\")>]",
  "let private loomText (v: obj) : string = jsNative",
  "",
  "/// The selected row's id, read off the projected row with the array index as",
  "/// the fallback — the same rule the Svelte/Vue/Angular selection effects use.",
  '[<Fable.Core.Emit("$0 != null && $0.id != null ? String($0.id) : String($1)")>]',
  "let private loomRowId (original: obj) (index: int) : string = jsNative",
  "",
  "/// Invoke a TanStack handler that expects a DOM/synthetic event (the sort",
  "/// toggle reads `shiftKey` off it to decide multi-sort).",
  '[<Fable.Core.Emit("$0($1)")>]',
  "let private loomHandle (handler: obj) (ev: obj) : unit = jsNative",
  "",
  "/// Comparator for a money / decimal column.  Fable maps those to a Decimal",
  "/// OBJECT whose valueOf() returns a string, so TanStack's default a < b orders",
  "/// them lexicographically — an ascending sort comes out [10, 100, 9].  The JSX",
  "/// frontends parse money into a decimal.js Decimal with the same valueOf and",
  "/// get the same wrong order, so this is a SHARED fix, applied identically.",
  '[<Fable.Core.Emit("((a,b,id) => { const x = Number(a.getValue(id) ?? 0), y = Number(b.getValue(id) ?? 0); return x < y ? -1 : x > y ? 1 : 0; })")>]',
  "let private loomCompareDecimal () : obj = jsNative",
  "",
  "/// Invoke a zero-argument TanStack method captured as a value.",
  '[<Fable.Core.Emit("$0()")>]',
  "let private loomInvoke (fn: obj) : unit = jsNative",
);

/** Build a `DataGrid`'s F# child component + the page's call site. */
export function renderFelizDataGridChild(spec: DataGridSpec, ctx: WalkContext): DataGridChild {
  // Signals `index.ts` to emit the interop preamble once and to add
  // `@tanstack/table-core` to the generated `package.json`.
  ctx.usesDataGrid = true;

  return {
    moduleDecl: renderComponent(spec, ctx),
    callSite: renderCallSite(spec),
  };
}

// ---------------------------------------------------------------------------
// Call site
// ---------------------------------------------------------------------------

/** `(CustomersGrid (rows |> List.mapi (fun i row -> …) |> List.toArray) onSel)`.
 *
 *  Paren-wrapped against sibling absorption inside an enclosing Feliz children
 *  list, and kept to a shape whose continuation lines are all indented under
 *  the opening paren (F# is offside-sensitive). */
function renderCallSite(spec: DataGridSpec): string {
  const projection = rowProjection(spec);
  const rowsArg = `(${spec.rowsExpr} |> List.mapi (fun __i ${FELIZ_GRID_ROW_VAR} -> ${projection}) |> List.toArray)`;
  // A bound `selection:` writes the page-state field the Elmish way — by
  // dispatching its `Set<Field>` Msg (`renderStateWrite` is a no-op on Feliz
  // because state lives in `update`).  `DataGrid` is registered in
  // `BOUND_INPUT_PRIMITIVES`, so that Msg case and its update arm exist.
  const onSelection = spec.selection
    ? `(fun __ids -> dispatch (Set${upperFirstLocal(spec.selection)} __ids))`
    : "(fun _ -> ())";
  return `(${spec.componentName} ${rowsArg} ${onSelection})`;
}

/** One row → a plain JS object TanStack can read.
 *
 *  `accessorKey` columns contribute their RAW field value (see the file header
 *  on why raw); computed columns contribute a lazy `unit -> ReactElement` thunk
 *  closing over the typed row, so only the cells actually drawn render. */
function rowProjection(spec: DataGridSpec): string {
  const entries: string[] = [];
  if (spec.selection !== undefined) {
    entries.push(`"id" ==> box (loomRowId (box ${FELIZ_GRID_ROW_VAR}) __i)`);
  }
  for (const c of spec.columns) {
    if (c.accessorKey) {
      entries.push(`"${c.accessorKey}" ==> box ${FELIZ_GRID_ROW_VAR}.${c.accessorKey}`);
    } else if (c.cell) {
      entries.push(`"loom-cell-${c.id}" ==> box (fun () -> ${oneLine(c.cell)})`);
    }
  }
  // An id-only projection (a grid whose every column is computed, with
  // selection off) still needs a non-empty object — `createObj []` is valid F#
  // and a valid empty row, so no special case is required.
  return `createObj [ ${entries.join("; ")} ]`;
}

// ---------------------------------------------------------------------------
// The child component
// ---------------------------------------------------------------------------

function renderComponent(spec: DataGridSpec, ctx: WalkContext): string {
  const { componentName, columns, multiSort, columnVisibility, anyFilterable, pageSize } = spec;
  const selection = spec.selection !== undefined;

  // The pack renders the chrome; the walker supplies the header + cell CONTENT,
  // exactly as on Vue and Svelte.  F# is not a template language, so the
  // fragments are EXPRESSIONS the pack splices where `h` (a header), `c` (a
  // cell) and `table` are in scope.
  const body = spec.renderBody({
    // Feliz builds PROPS, not markup, so the sort button's accessible name
    // arrives as an F# VALUE (`localizedChromeIcuExpr`) rather than as the
    // attribute fragment `spec.sortByAria` carries for the markup targets —
    // D-I18N-ATTR's split, one more time.  With i18n off the `renderStringConcat`
    // seam re-spells it as the same `("Sort by " + loomText …)` this file wrote
    // by hand, so the pre-i18n output is unchanged.
    headerBody: headerBody(
      selection,
      localizedChromeIcuExpr(ctx, "sortBy", [
        { name: "column", expr: "loomText (h?column?columnDef?header)" },
      ]),
    ),
    cellBody: cellBody(columns, selection),
    // The pager's ICU counter (M-T1.11).  Supplied HERE rather than in
    // `emitDataGrid` alongside the other chrome tokens because its two hole
    // expressions are Fable's dynamic-access dialect (`table?getState()?…`),
    // not the JS member chain the `.hbs` packs read — the message is shared,
    // the way each frontend reaches the numbers is not.  `undefined` with i18n
    // off, and `pack.ts` then keeps its own hand-written sentence.
    pageOfLabelValue: localizedChromeIcuValue(ctx, "pageOf", [
      { name: "page", expr: "unbox<int> (table?getState()?pagination?pageIndex) + 1" },
      { name: "pages", expr: "max (unbox<int> (table?getPageCount())) 1" },
    ]),
  });

  return lines(
    `[<ReactComponent>]`,
    `let ${componentName} (rows: obj array) (onSelectionChange: string list -> unit) =`,
    // Every state slice is CONTROLLED — including pagination.  The table is
    // rebuilt on each render (as on Svelte), which is only correct because
    // nothing uncontrolled is left to lose: an uncontrolled `pageIndex` would
    // silently reset to 0 on every sort click.
    `  let sorting, setSorting = React.useState<obj> (box [||])`,
    ...(selection
      ? [`  let rowSelection, setRowSelection = React.useState<obj> (createObj [])`]
      : []),
    ...(anyFilterable
      ? [`  let columnFilters, setColumnFilters = React.useState<obj> (box [||])`]
      : []),
    ...(columnVisibility
      ? [`  let columnVisibility, setColumnVisibility = React.useState<obj> (createObj [])`]
      : []),
    `  let pagination, setPagination =`,
    `    React.useState<obj> (createObj [ "pageIndex" ==> 0; "pageSize" ==> ${pageSize} ])`,
    ``,
    `  let columns : obj array =`,
    `    [|`,
    ...columnDefs(columns, selection).map((l) => `      ${l}`),
    `    |]`,
    ``,
    `  let ownState : obj =`,
    `    createObj [`,
    ...stateSliceNames(spec).map((n) => `      "${n}" ==> ${n}`),
    `    ]`,
    ``,
    `  let options (st: obj) : obj =`,
    `    createObj [`,
    `      "data" ==> rows`,
    `      "columns" ==> columns`,
    `      "state" ==> st`,
    ...changeHandlers(spec).map((l) => `      ${l}`),
    `      // Every slice has its own handler above, so the aggregate hook is a`,
    `      // no-op; \`table-core\` requires it to be present.`,
    `      "onStateChange" ==> (fun (_: obj) -> ())`,
    `      "renderFallbackValue" ==> null`,
    ...(selection ? [`      "enableRowSelection" ==> true`] : []),
    `      "enableMultiSort" ==> ${multiSort}`,
    `      "getCoreRowModel" ==> loomCoreRowModel ()`,
    `      "getSortedRowModel" ==> loomSortedRowModel ()`,
    ...(anyFilterable ? [`      "getFilteredRowModel" ==> loomFilteredRowModel ()`] : []),
    `      "getPaginationRowModel" ==> loomPaginationRowModel ()`,
    `    ]`,
    ``,
    `  // The defaults never change, so one throwaway instance on first render is`,
    `  // enough to source them (this is what the official adapters keep on their`,
    `  // persistent instance).  Without the merge, \`getHeaderGroups()\` throws.`,
    `  let defaultState =`,
    `    React.useMemo ((fun () -> (loomCreateTable (options (createObj [])))?initialState), [||])`,
    `  let table = loomCreateTable (options (loomMergeState defaultState ownState))`,
    ...(selection ? ["", ...selectionEffect()] : []),
    ``,
    ...indent(body, 2),
  );
}

/** Column defs.  A computed column gets NO `cell` here — its markup rides the
 *  projected row's thunk and is rendered by the pack, keyed by column id (the
 *  same split Vue and Svelte use). */
function columnDefs(columns: readonly DataGridColumn[], selection: boolean): string[] {
  const out: string[] = [];
  const def = (parts: string[]): string => `createObj [ ${parts.join("; ")} ]`;
  if (selection) {
    out.push(
      def([
        `"id" ==> "${SELECT_COL}"`,
        `"header" ==> ""`,
        `"enableSorting" ==> false`,
        `"enableColumnFilter" ==> false`,
      ]),
    );
  }
  for (const c of columns) {
    const parts = [`"id" ==> "${c.id}"`];
    if (c.accessorKey) parts.push(`"accessorKey" ==> "${c.accessorKey}"`);
    parts.push(`"header" ==> "${escapeFs(c.header)}"`);
    parts.push(`"enableSorting" ==> ${c.sortable}`);
    parts.push(`"enableColumnFilter" ==> ${c.filterable}`);
    // A money/decimal column needs an explicit numeric comparator — see
    // `DataGridColumn.numericSort`.
    if (c.numericSort) parts.push(`"sortingFn" ==> loomCompareDecimal ()`);
    out.push(def(parts));
  }
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
  const pairs: [string, string, string][] = [["onSortingChange", "sorting", "setSorting"]];
  if (spec.selection !== undefined)
    pairs.push(["onRowSelectionChange", "rowSelection", "setRowSelection"]);
  if (spec.anyFilterable)
    pairs.push(["onColumnFiltersChange", "columnFilters", "setColumnFilters"]);
  if (spec.columnVisibility)
    pairs.push(["onColumnVisibilityChange", "columnVisibility", "setColumnVisibility"]);
  pairs.push(["onPaginationChange", "pagination", "setPagination"]);
  return pairs.map(
    ([handler, name, setter]) =>
      `"${handler}" ==> (fun (u: obj) -> ${setter} (loomApplyUpdater u ${name}))`,
  );
}

/** Report the selected row ids up to the page.
 *
 *  `rowSelection` is the dependency: the effect must re-run when the selection
 *  MAP changes, and the ids come off `table`.  Same contract as the Svelte and
 *  Vue effects, so the page sees identical ids on every frontend. */
function selectionEffect(): string[] {
  return [
    `  React.useEffect (`,
    `    (fun () ->`,
    `      onSelectionChange (`,
    `        unbox<obj array> (table?getSelectedRowModel()?rows)`,
    `        |> Array.map (fun r -> loomRowId (r?original) (unbox<int> (r?index)))`,
    `        |> List.ofArray)),`,
    `    [| box rowSelection |])`,
  ];
}

// ---------------------------------------------------------------------------
// Header / cell fragments handed to the pack
// ---------------------------------------------------------------------------

/** Header CONTENT: the select-all checkbox, a sortable header button, or the
 *  plain label.  One expression — the pack splices it where `h` and `table` are
 *  bound.
 *
 *  The sort click goes through TanStack's own `getToggleSortingHandler()` rather
 *  than a hand-rolled toggle, because that handler is what reads `shiftKey` to
 *  decide multi-sort.  Re-implementing it would fork exactly the behaviour this
 *  target exists to share. */
function headerBody(selection: boolean, sortByAria: string): string {
  const label = `loomText (h?column?columnDef?header)`;
  const indicator =
    `(match unbox<obj> (h?column?getIsSorted()) with` +
    ` | :? string as d when d = "asc" -> " ↑"` +
    ` | :? string as d when d = "desc" -> " ↓"` +
    ` | _ -> "")`;
  const sortButton =
    `Html.button [ prop.className "inline-flex items-center gap-1 font-inherit cursor-pointer bg-transparent border-0 p-0";` +
    ` prop.ariaLabel ${sortByAria};` +
    ` prop.onClick (fun (e: Browser.Types.MouseEvent) -> loomHandle (h?column?getToggleSortingHandler()) (box e));` +
    ` prop.text (${label} + ${indicator}) ]`;
  const plain = `Html.text (${label})`;
  if (!selection) {
    return `(if unbox<bool> (h?column?getCanSort()) then ${sortButton} else ${plain})`;
  }
  const selectAll =
    `Html.input [ prop.type' "checkbox"; prop.ariaLabel "Select all rows";` +
    ` prop.isChecked (unbox<bool> (table?getIsAllPageRowsSelected()));` +
    ` prop.onChange (fun (_: bool) -> loomInvoke (table?toggleAllPageRowsSelected)) ]`;
  return (
    `(if unbox<string> (h?column?id) = "${SELECT_COL}" then ${selectAll}` +
    ` elif unbox<bool> (h?column?getCanSort()) then ${sortButton}` +
    ` else ${plain})`
  );
}

/** Cell CONTENT: the row checkbox, else the computed-cell thunk when the column
 *  has one, else the plain value.  Branching on the column id (not an index)
 *  keeps it correct under the hiding and reordering TanStack does at runtime. */
function cellBody(columns: readonly DataGridColumn[], selection: boolean): string {
  const plain = `Html.text (loomText (c?getValue()))`;
  const computed =
    `(let __cell = loomCellThunk c in` +
    ` if isNull __cell then ${plain} else (unbox<unit -> ReactElement> __cell) ())`;
  const hasComputed = columns.some((col) => col.cell !== undefined);
  const value = hasComputed ? computed : plain;
  if (!selection) return value;
  const checkbox =
    `Html.input [ prop.type' "checkbox"; prop.ariaLabel "Select row";` +
    ` prop.isChecked (unbox<bool> (c?row?getIsSelected()));` +
    ` prop.onChange (fun (_: bool) -> loomInvoke (c?row?toggleSelected)) ]`;
  return `(if unbox<string> (c?column?id) = "${SELECT_COL}" then ${checkbox} else ${value})`;
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/** Collapse a walked element to ONE line.  Cell markup is spliced into a
 *  single-expression thunk inside a `createObj [ … ]` list, and F# is
 *  offside-sensitive — a multi-line child there would not parse. */
function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

/** Indent a rendered block (the pack's grid markup) into the component body. */
function indent(block: string, spaces: number): string[] {
  const pad = " ".repeat(spaces);
  return block.split("\n").map((l) => (l.trim() === "" ? "" : `${pad}${l}`));
}

/** F# string-literal escaping for a header label. */
function escapeFs(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Local `upperFirst` — the Msg case for a bound `selection:` state field.
 *  Matches `boundSetMsg`'s `Set<Field>` spelling in `update-emit.ts`. */
function upperFirstLocal(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
