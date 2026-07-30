// DataGrid primitive — a TanStack-Table-backed data grid (M-T1.1 follow-on).
//
// WHY THIS IS NOT `Table`
// -----------------------
// `Table` is deliberately simple and portable: it renders markup around a
// rows expression the walker has already sorted/sliced, so all six frontends
// (plus the parallel HEEx engine) can implement it.  It covers single-column
// sort, one substring filter, and prev/next paging — and for the scaffold's
// server-paged list the server does the work anyway.
//
// `DataGrid` is the case where hand-rolling stops paying: multi-column sort,
// per-column filters, and column visibility.  Those are row-model concerns,
// which is exactly what TanStack Table is, so this primitive delegates to it
// rather than growing `Table` a fourth and fifth interactive mode.
//
// WHY IT EMITS A COMPONENT, NOT MARKUP
// ------------------------------------
// `useReactTable` is a React hook, so it must run at a component's top level.
// A DataGrid almost always renders inside a `QueryView`'s `data:` slot, which
// the walker emits as a CONDITIONAL expression (`{rows && <…/>}`) — hooks
// cannot run there.  Hoisting the hook to the page component's top level does
// not work either: it needs `rows`, which only exists inside the QueryView
// lambda.  And a component declared *inside* the page would get a fresh
// identity on every render, remounting the grid and losing its sort state.
//
// So the primitive hoists a child component to MODULE scope (via
// `ctx.hoistedModuleDecls`) and renders `<XGrid rows={…} />` at the call site.
// This is the same shape shadcn's own DataTable recipe uses, and it ports to
// Vue/Svelte/Angular (each emits a child component too) in the next slice.
//
// The emitted shape is compile-verified against real `@tanstack/react-table`
// v8 + React 19 under `strict` + `noUnusedLocals`; in particular the child is
// generic over the row type (`<T extends object>`) so no DTO type name has to
// be resolved here, and `data:` takes a `as T[]` cast because the walker binds
// `rows` as `readonly T[]`.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";
import { addImport, renderPrimitive } from "../render-primitive.js";
import {
  boolNamed,
  namedArgValue,
  numericNamed,
  positionalArgs,
  stringNamed,
} from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import { emitExpr, extendLambdaParams, propagateChildFlags, walk } from "../walker-core.js";

/** One resolved grid column. */
interface GridColumn {
  /** Stable column id — also the TanStack `accessorKey` for a simple field. */
  id: string;
  /** Header label (already escaped for the target). */
  header: string;
  /** Row field this column reads, when the accessor is a simple member. */
  accessorKey?: string;
  /** Rendered cell JSX for a non-trivial accessor (formatting, a nested
   *  primitive).  Mutually exclusive with `accessorKey`. */
  cellJsx?: string;
  sortable: boolean;
  filterable: boolean;
}

export function emitDataGrid(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const rowsArg = namedArgValue(call, "rows");
  const rowsExpr = rowsArg ? emitExpr(rowsArg, ctx) : "[]";

  const multiSort = boolNamed(call, "multiSort");
  const columnVisibility = boolNamed(call, "columnVisibility");
  const pageSize = numericNamed(call, "pageSize") ?? 25;

  const columns = positionalArgs(call)
    .filter((a): a is ExprIR & { kind: "call" } => a.kind === "call" && a.name === "Column")
    .map((c, i) => resolveColumn(c, ctx, i, depth));

  // Any column asking to be filtered turns the per-column filter row on; the
  // grid otherwise emits no filter inputs (smaller output, no dead state).
  const anyFilterable = columns.some((c) => c.filterable);

  const componentName = gridComponentName(call, ctx);

  addImport(ctx, "react", "useMemo", "useState");
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
    ...(anyFilterable ? ["type ColumnFiltersState"] : []),
    ...(columnVisibility ? ["type VisibilityState"] : []),
  );

  // The grid body markup comes from the design pack, so each pack keeps its
  // own table chrome; the hook wiring above it is framework-level and lives
  // here.
  const body = renderPrimitive(ctx, "primitive-data-grid", {
    hasColumnVisibility: columnVisibility,
    hasFilters: anyFilterable,
    testidAttr: stringNamed(call, "testid") ? ` data-testid="${stringNamed(call, "testid")}"` : "",
  });

  ctx.hoistedModuleDecls ??= [];
  ctx.hoistedModuleDecls.push(
    renderGridComponent({
      componentName,
      columns,
      multiSort,
      columnVisibility,
      anyFilterable,
      pageSize,
      body,
    }),
  );

  // The call site is a single element — the grid's own layout lives inside the
  // hoisted component, so no depth-based indentation is needed here.
  return `<${componentName} rows={${rowsExpr}} />`;
}

/** Resolve one `Column("Header", accessor, sortable:, field:, filterable:)`.
 *
 *  A simple member accessor (`o => o.sku`) becomes a TanStack `accessorKey`,
 *  which is what makes sorting and filtering work without a custom comparator.
 *  Anything richer (a formatting call, a nested primitive) renders through the
 *  normal walker into a `cell:` function instead — it can still be displayed,
 *  it just isn't sortable/filterable by value. */
function resolveColumn(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  index: number,
  depth: number,
): GridColumn {
  const positionals = positionalArgs(call);
  const headerArg = positionals[0];
  const accessorArg = positionals[1];
  const headerStr =
    headerArg && headerArg.kind === "literal" && headerArg.lit === "string"
      ? headerArg.value
      : `Column ${index + 1}`;

  const explicitField = stringNamed(call, "field");
  const inferred = simpleAccessorField(accessorArg);
  const accessorKey = explicitField ?? inferred;

  let cellJsx: string | undefined;
  if (!accessorKey && accessorArg?.kind === "lambda" && accessorArg.body) {
    const rowVar = "row";
    const childCtx: WalkContext = {
      ...ctx,
      lambdaParams: extendLambdaParams(ctx, accessorArg.param, rowVar),
    };
    const b = accessorArg.body;
    cellJsx = b.kind === "call" ? walk(b, childCtx, depth) : `{${emitExpr(b, childCtx)}}`;
    propagateChildFlags(ctx, childCtx);
  }

  return {
    id: accessorKey ?? `col${index + 1}`,
    header: headerStr,
    accessorKey,
    cellJsx,
    // A column with no resolvable field can't be sorted or filtered BY VALUE,
    // so those flags are forced off rather than emitted and silently ignored.
    sortable: boolNamed(call, "sortable") && accessorKey !== undefined,
    filterable: boolNamed(call, "filterable") && accessorKey !== undefined,
  };
}

/** `o => o.sku` → `"sku"`.  Undefined for anything more complex. */
function simpleAccessorField(accessor: ExprIR | undefined): string | undefined {
  if (accessor?.kind !== "lambda") return undefined;
  const body = accessor.body;
  if (body?.kind === "member" && body.receiver.kind === "ref") return body.member;
  return undefined;
}

/** A unique, stable component name for this grid within the emitted module. */
function gridComponentName(call: ExprIR & { kind: "call" }, ctx: WalkContext): string {
  const testid = stringNamed(call, "testid");
  if (testid) {
    const pascalCase = testid
      .split(/[^A-Za-z0-9]+/)
      .filter((s) => s !== "")
      .map((s) => upperFirst(s))
      .join("");
    // Don't stutter when the testid already names it a grid
    // (`customers-grid` → `CustomersGrid`, not `CustomersGridGrid`).
    if (pascalCase !== "") {
      return pascalCase.endsWith("Grid") ? pascalCase : `${pascalCase}Grid`;
    }
  }
  // Fall back to a per-module sequence.  Counted off the hoist array so no
  // extra walker state is needed; every grid pushes exactly one declaration.
  const n = (ctx.hoistedModuleDecls?.length ?? 0) + 1;
  return `LoomGrid${n}`;
}

/** Render the hoisted child component: column defs, view state, the
 *  `useReactTable` call, and the pack-rendered markup. */
function renderGridComponent(args: {
  componentName: string;
  columns: readonly GridColumn[];
  multiSort: boolean;
  columnVisibility: boolean;
  anyFilterable: boolean;
  pageSize: number;
  body: string;
}): string {
  const { componentName, columns, multiSort, columnVisibility, anyFilterable, pageSize, body } =
    args;

  const colDefs = columns
    .map((c) => {
      const parts = [`id: ${JSON.stringify(c.id)}`];
      if (c.accessorKey) parts.push(`accessorKey: ${JSON.stringify(c.accessorKey)}`);
      parts.push(`header: ${JSON.stringify(c.header)}`);
      if (c.cellJsx) parts.push(`cell: () => ${c.cellJsx}`);
      parts.push(`enableSorting: ${c.sortable}`);
      parts.push(`enableColumnFilter: ${c.filterable}`);
      return `        { ${parts.join(", ")} },`;
    })
    .join("\n");

  const stateDecls = [
    `  const [sorting, setSorting] = useState<SortingState>([]);`,
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
    anyFilterable ? "columnFilters" : "",
    columnVisibility ? "columnVisibility" : "",
  ]
    .filter((s) => s !== "")
    .join(", ");

  const changeHandlers = [
    `    onSortingChange: setSorting,`,
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

  // `rows` arrives as `readonly T[]` from the walker's binding; TanStack's
  // `data` is mutable, hence the cast.  The component is generic so no DTO
  // type name has to be resolved at generate time.
  return `function ${componentName}<T extends object>({ rows }: { rows: readonly T[] }) {
${stateDecls}
  const columns = useMemo<ColumnDef<T>[]>(
    () => [
${colDefs}
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
  return (
${body}
  );
}
`;
}
