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
// A `DataGrid` is a TanStack row model driven by framework-specific reactive
// state, and that state cannot live in the page component: the grid almost
// always renders inside a `QueryView`'s `data:` slot, which the walker emits as
// a CONDITIONAL expression, and it needs `rows`, which only exists inside that
// lambda.  So each target emits a CHILD component and renders a call site here.
//
// WHAT IS SHARED AND WHAT IS NOT
// ------------------------------
// Arg parsing, column resolution and the component name are framework-neutral
// and live in this file.  Everything about the child itself — the reactive
// idiom, the TanStack package, and whether the child can share the page's file
// at all — is the `renderDataGridChild` seam (`_walker/target.ts`).  TSX puts
// the child at module scope in the page's own file; a Vue SFC and a `.svelte`
// file hold exactly ONE component each, so those targets return a whole
// sibling file through `ctx.hoistedComponentFiles`.
//
// Unlike the `Table` sort/filter/pager seams, a missing seam here is NOT a
// graceful degradation — a grid that renders nothing is a blank page region.
// `loom.datagrid-unsupported-target` rejects `DataGrid` on any framework
// without the seam at IR-validate, so the sentinel below is unreachable from
// valid input.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";

import {
  boolNamed,
  namedArgValue,
  numericNamed,
  positionalArgs,
  stringNamed,
} from "../shared/args.js";
import type { DataGridColumn } from "../target.js";
import type { WalkContext } from "../walker-core.js";
import { emitExpr, extendLambdaParams, propagateChildFlags, walk } from "../walker-core.js";

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

  // `selection: <string[] page-state field>` turns on row selection and syncs
  // the selected row ids back into that field.  Selection is the ONE piece of
  // grid view-state exposed to the page: a sibling ("Delete selected (3)") has
  // a real need for it, whereas sort/filter/visibility are opaque and nothing
  // outside the grid reads them.  That keeps decision (A)'s spirit — state a
  // sibling needs lives in `state {}` — without forcing TanStack's internal
  // shapes into the DSL.
  //
  // Requires an ARRAY-typed field: a `string[]` is the honest contract, and the
  // React page-shell only emits `useState<string[]>([])` for it since the
  // array-state fix (#2294) — before that it was `useState<any>(undefined)`.
  const selection = stateNameArg(call, "selection", ctx);
  // A bound selection is a state USE even though no `ref` node was walked —
  // the page shell only emits the field's reactive declaration (React's
  // `useState`, Vue's `ref`) when something in the body used it, and here the
  // consumer is the grid's own prop wiring rather than an expression.  Without
  // this the page loses the very field the grid writes to.
  if (selection) ctx.usesState = true;

  const columns = positionalArgs(call)
    .filter((a): a is ExprIR & { kind: "call" } => a.kind === "call" && a.name === "Column")
    .map((c, i) => resolveColumn(c, ctx, i, depth));

  // Any column asking to be filtered turns the per-column filter row on; the
  // grid otherwise emits no filter inputs (smaller output, no dead state).
  const anyFilterable = columns.some((c) => c.filterable);

  const componentName = gridComponentName(call, ctx);

  const testid = stringNamed(call, "testid");
  const testidAttr = testid ? ` data-testid="${testid}"` : "";

  const child = ctx.target.renderDataGridChild?.(
    {
      componentName,
      columns,
      rowsExpr,
      multiSort,
      columnVisibility,
      anyFilterable,
      pageSize,
      selection,
      testidAttr,
      // The grid body markup comes from the active design pack, so each pack
      // keeps its own table chrome while the reactive wiring around it belongs
      // to the target.  Rendered through a callback rather than eagerly: a
      // target supplies its own extra template context (Vue splices
      // walker-built header/cell fragments, which React puts in its column
      // defs instead), and only the target knows what those are.
      packImports: ctx.pack.manifest.imports?.["primitive-data-grid"] ?? [],
      renderBody: (extra) =>
        ctx.pack.render("primitive-data-grid", {
          hasColumnVisibility: columnVisibility,
          hasFilters: anyFilterable,
          hasSelection: selection !== undefined,
          testidAttr,
          // Every target-specific key a pack may reference is defaulted here,
          // not just supplied by the target that uses it.  `emitPageObjectsForUi`
          // drives the REACT tsx walker over whichever pack is active — Vue and
          // Svelte included — purely to collect `testid:` strings, so a Vue pack
          // template gets rendered with React's context on that throwaway pass.
          // Handlebars runs in strict mode, so a missing key is a hard error
          // rather than a blank.  The pass's output is discarded (only testids
          // survive), so an empty fragment here is harmless; the real Vue page
          // comes from the Vue walker, which overrides both.
          headerBody: "",
          cellBody: "",
          ...extra,
        }),
    },
    ctx,
  );
  // Unreachable from valid input — `loom.datagrid-unsupported-target` rejects a
  // DataGrid on any framework without the seam.  Kept so the walker is total.
  if (!child) return `{/* DataGrid: not supported on ${ctx.target.framework} */}`;

  if (child.moduleDecl !== undefined) {
    ctx.hoistedModuleDecls ??= [];
    ctx.hoistedModuleDecls.push(child.moduleDecl);
  }
  if (child.file !== undefined) {
    ctx.hoistedComponentFiles ??= [];
    ctx.hoistedComponentFiles.push(child.file);
  }
  return child.callSite;
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
): DataGridColumn {
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

  let cell: string | undefined;
  if (!accessorKey && accessorArg?.kind === "lambda" && accessorArg.body) {
    // How the row reaches the cell is target-specific — see
    // `WalkerTarget.dataGridRowVar`.
    const rowVar = ctx.target.dataGridRowVar ?? "row";
    const childCtx: WalkContext = {
      ...ctx,
      lambdaParams: extendLambdaParams(ctx, accessorArg.param, rowVar),
    };
    const b = accessorArg.body;
    cell = b.kind === "call" ? walk(b, childCtx, depth) : `{${emitExpr(b, childCtx)}}`;
    propagateChildFlags(ctx, childCtx);
  }

  return {
    id: accessorKey ?? `col${index + 1}`,
    header: headerStr,
    accessorKey,
    cell,
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

/** A unique, stable component name for this grid within the emitted module.
 *
 *  Must not collide with a user `component` OR a page: the targets that hoist
 *  the child into `src/components/` would overwrite that component's file and
 *  the page's import would silently bind the wrong one, while React — which
 *  hoists into the page's OWN file — would emit two declarations of the same
 *  name (`page ProjectsGrid` with `testid: "projects-grid"` derives
 *  `ProjectsGrid` twice, a `Duplicate function implementation` error found by
 *  compiling `showcase.ddd`).  A colliding derived name falls through to the
 *  sequence below. */
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
      const name = pascalCase.endsWith("Grid") ? pascalCase : `${pascalCase}Grid`;
      // `pageRoutes` is keyed by page name, which is what the page component is
      // named after — so it is the available view of "names this module already
      // binds", with no new plumbing through `walkBody`'s parameter list.
      if (!ctx.userComponents.has(name) && !ctx.pageRoutes?.has(name)) return name;
    }
  }
  // Fall back to a per-page sequence.  Counted off the hoist accumulators so no
  // extra walker state is needed; every grid pushes exactly one entry, into
  // whichever channel its target uses (module decl on TSX, sibling file on
  // Vue/Svelte) — so BOTH are counted or the second grid on a file-hoisting
  // target would reuse the first one's name.
  const n = (ctx.hoistedModuleDecls?.length ?? 0) + (ctx.hoistedComponentFiles?.length ?? 0) + 1;
  return `LoomGrid${n}`;
}

/** Read a named arg that must reference a declared page-state field
 *  (`selection: selectedIds`), returning the field name as declared.
 *
 *  The walker sees only state NAMES, not their declared types, so the
 *  "must be `string[]`" half is enforced one layer up by the IR check
 *  `loom.datagrid-selection-not-array` — where the types are resolved and the
 *  diagnostic can name the field.  Binding a scalar would otherwise emit
 *  `setSelectedIds(<string[]>)` against a `useState<string>` and surface as a
 *  tsc error far from its cause. */
function stateNameArg(
  call: Extract<ExprIR, { kind: "call" }>,
  name: string,
  ctx: WalkContext,
): string | undefined {
  const arg = namedArgValue(call, name);
  if (arg?.kind !== "ref") return undefined;
  return ctx.stateNames.has(arg.name) ? arg.name : undefined;
}
