// Table primitive: emitTable renders a per-pack data table from a
// `rows:` expression and positional Column(...) calls. Column accessor
// lambdas rebind their source param to the emitted `row` identifier via
// the shared lambda-scope helpers. emitColumn is private to this module.

import type { ExprIR, StateFieldIR } from "../../../ir/types/loom-ir.js";
import { provableStringType } from "../../../util/expr-body-type.js";
import { renderPrimitive } from "../render-primitive.js";
import {
  actionHandlerName,
  actionRefArg,
  boolNamed,
  escapeJsxText,
  lambdaArg,
  namedArgValue,
  positionalArgs,
  slugify,
  stringNamed,
} from "../shared/args.js";
import type { StateRef } from "../target.js";
import type { WalkContext } from "../walker-core.js";
import {
  emitExpr,
  emitStmt,
  extendLambdaParams,
  propagateChildFlags,
  styleAttr,
  testidAttr,
  walk,
} from "../walker-core.js";

/** Build a `StateRef` for a page-state field named `name`.  Sort state is
 *  always string-typed (`sortKey: ""`, `sortDir: "asc"`); mirrors the ad-hoc
 *  ref the ref-case path in `walker-core.ts` constructs. */
function stateRefFor(name: string): StateRef {
  return {
    field: { name, type: { kind: "primitive", name: "string" } } as StateFieldIR,
    name,
  };
}

/** Read a named arg that must be a bare state-field reference (`sortKey:
 *  sortKey`).  Returns the referenced name, or undefined when the arg is
 *  absent or not a plain ref. */
function refArgName(call: ExprIR & { kind: "call" }, name: string): string | undefined {
  const v = namedArgValue(call, name);
  return v && v.kind === "ref" ? v.name : undefined;
}

export function emitTable(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const rowsArg = namedArgValue(call, "rows");
  let rowsExpr = rowsArg ? emitExpr(rowsArg, ctx) : "[]";

  // Client-side column sort (M-T1.1).  Active only when the Table carries
  // `sortKey:`/`sortDir:` state refs AND the target implements the seam; a
  // target without the seam ignores the args and renders the plain,
  // unsorted table (byte-identical to a table with no sort args).
  const sortKeyName = refArgName(call, "sortKey");
  const sortDirName = refArgName(call, "sortDir");
  const sortActive =
    sortKeyName !== undefined &&
    sortDirName !== undefined &&
    ctx.target.renderSortedRows !== undefined &&
    ctx.target.renderSortableHeader !== undefined;
  const sortKeyRef = sortKeyName !== undefined ? stateRefFor(sortKeyName) : undefined;
  const sortDirRef = sortDirName !== undefined ? stateRefFor(sortDirName) : undefined;
  if (sortActive && sortKeyRef && sortDirRef) {
    ctx.usesState = true;
    // Signals the page-shell to import the shared `sortRows` helper.  Targets
    // whose `renderSortedRows` inlines the sort (React) leave the flag unread;
    // targets that call the helper (Vue/Svelte/Angular — their strict
    // templates reject the inline `as`-cast comparator) read it to import.
    ctx.usesTableSort = true;
    rowsExpr = ctx.target.renderSortedRows!(rowsExpr, sortKeyRef, sortDirRef);
  }
  // A named-action reference (`onRowClick: add`) binds the hoisted handler
  // the page-shell emits from `page.actions` (named-actions-and-stores.md,
  // Proposal A Stage 1): a single-payload action receives the clicked `row`;
  // a nullary action is called with no arg.
  const onRowClickAction = actionRefArg(call, "onRowClick");
  const onRowClick = lambdaArg(call, "onRowClick");

  const positionals = positionalArgs(call);
  const sortRefs = sortActive && sortKeyRef && sortDirRef ? { sortKeyRef, sortDirRef } : undefined;
  const cols = positionals
    .filter((a): a is ExprIR & { kind: "call" } => a.kind === "call" && a.name === "Column")
    .map((c, i) => emitColumn(c, ctx, i, depth + 3, sortRefs));

  const rowVar = "row";
  let onRowClickJs: string | undefined;
  if (onRowClickAction) {
    ctx.usedActions?.add(onRowClickAction.actionName);
    const arg = onRowClickAction.paramType ? rowVar : "";
    onRowClickJs = `{ ${actionHandlerName(onRowClickAction.actionName)}(${arg}); }`;
  } else if (onRowClick) {
    const childCtx: WalkContext = {
      ...ctx,
      lambdaParams: extendLambdaParams(ctx, onRowClick.param, rowVar),
    };
    if (onRowClick.body) {
      onRowClickJs = emitExpr(onRowClick.body, childCtx);
    } else if (onRowClick.block && onRowClick.block.length > 0) {
      const stmts = onRowClick.block.map((s) => emitStmt(s, childCtx)).join(" ");
      onRowClickJs = `{ ${stmts} }`;
    }
    propagateChildFlags(ctx, childCtx);
  }

  // Boolean style props matching Mantine's `<Table>`
  // surface.  shadcn templates ignore the props (their <Table> has
  // built-in striping); reading them here keeps the DSL pack-
  // agnostic.
  const striped = boolNamed(call, "striped");
  const highlight = boolNamed(call, "highlight");
  const sticky = boolNamed(call, "sticky");

  // `keyExpr:` named arg overrides the default
  // `row.id` key.  Views with custom output (no `id` field on the
  // row type) supply `keyExpr: "idx"` (or similar) so the
  // `<Table.Tr key=…>` doesn't reference a non-existent field.
  // String-literal arg only — emitted verbatim into the JSX
  // expression.
  const keyExprArg = stringNamed(call, "keyExpr");
  const keyExpr = keyExprArg ?? `${rowVar}.id`;

  // `rowTestid:` lambda computes a per-row testid.
  // The lambda's source-side param rebinds to `row` (the
  // lambdaParams scope) so user code reads `row.id` cleanly.
  // The expression body emits inside a TS template literal so
  // dynamic ids interpolate (`orders-row-${row.id}`).
  const rowTestidLam = lambdaArg(call, "rowTestid");
  let rowTestidJs: string | undefined;
  if (rowTestidLam?.body) {
    const childCtx: WalkContext = {
      ...ctx,
      lambdaParams: extendLambdaParams(ctx, rowTestidLam.param, rowVar),
    };
    rowTestidJs = emitExpr(rowTestidLam.body, childCtx);
    propagateChildFlags(ctx, childCtx);
  }

  const indent = "  ".repeat(depth + 1);
  const headIndent = "  ".repeat(depth + 2);
  const bodyIndent = "  ".repeat(depth + 2);
  const rowIndent = "  ".repeat(depth + 3);
  const cellIndent = "  ".repeat(depth + 4);
  const closeIndent = "  ".repeat(depth);
  // The row lambda only declares the `idx` param when something
  // actually references it (e.g. a view keying on `keyExpr: "idx"`);
  // otherwise emit `(row)` so the generated code carries no unused param.
  const usesIdx = /\bidx\b/.test([keyExpr, rowTestidJs, onRowClickJs].filter(Boolean).join(" "));
  return renderPrimitive(ctx, "primitive-table", {
    rowsExpr,
    rowVar,
    keyExpr,
    usesIdx,
    columns: cols,
    hasColumns: cols.length > 0,
    hasOnRowClick: onRowClickJs !== undefined,
    onRowClick: onRowClickJs,
    striped,
    highlight,
    sticky,
    hasAnyStyleProps: striped || highlight || sticky,
    hasRowTestid: rowTestidJs !== undefined,
    rowTestid: rowTestidJs,
    indent,
    headIndent,
    bodyIndent,
    rowIndent,
    cellIndent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

/** Emit one `Column("Header", <accessor>)` into a
 *  template-friendly shape: a header string + a per-cell TSX
 *  fragment.  Accessor lambda bodies that are primitive calls
 *  walk through the regular emitter (yields JSX); expression
 *  bodies (member access, refs) emit as `{<expr>}` brace-wrapped
 *  JS expressions. */
function emitColumn(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  index: number,
  depth: number,
  sortRefs?: { sortKeyRef: StateRef; sortDirRef: StateRef },
): { header: string; cellJsx: string; key: string } {
  const positionals = positionalArgs(call);
  const headerArg = positionals[0];
  const accessorArg = positionals[1];
  const headerStr =
    headerArg && headerArg.kind === "literal" && headerArg.lit === "string"
      ? headerArg.value
      : `Column ${index + 1}`;
  const key = slugify(headerStr) || `col-${index + 1}`;

  const rowVar = "row";
  let cellJsx = ctx.target.renderComment("missing accessor");
  if (accessorArg && accessorArg.kind === "lambda") {
    const childCtx: WalkContext = {
      ...ctx,
      lambdaParams: extendLambdaParams(ctx, accessorArg.param, rowVar),
    };
    const body = accessorArg.body;
    if (body) {
      if (body.kind === "call") {
        cellJsx = walk(body, childCtx, depth);
      } else if (body.kind === "literal" && body.lit === "string") {
        cellJsx = ctx.target.escapeText(body.value);
      } else {
        cellJsx = ctx.target.renderInterpolation(
          emitExpr(body, childCtx),
          provableStringType(body),
        );
      }
    }
    propagateChildFlags(ctx, childCtx);
  }

  // A `sortable: true` column with an active sort seam renders a clickable
  // header driving the page's `sortKey`/`sortDir` state.  The sort field is
  // the explicit `field:` arg, else the accessor's member (`o => o.name` →
  // `"name"`); a column whose field can't be resolved stays a plain header.
  let header = ctx.target.escapeText(headerStr);
  if (boolNamed(call, "sortable") && sortRefs && ctx.target.renderSortableHeader) {
    const field = stringNamed(call, "field") ?? sortFieldFromAccessor(accessorArg);
    if (field) {
      header = ctx.target.renderSortableHeader({
        header,
        field,
        sortKey: sortRefs.sortKeyRef,
        sortDir: sortRefs.sortDirRef,
      });
    }
  }

  return {
    header,
    cellJsx,
    key,
  };
}

/** Infer a column's sort field from a simple accessor lambda `o => o.<field>`.
 *  Returns undefined for anything more complex (a formatting call, a nested
 *  chain) — those columns need an explicit `field:` to be sortable. */
function sortFieldFromAccessor(accessorArg: ExprIR | undefined): string | undefined {
  if (accessorArg?.kind !== "lambda") return undefined;
  const body = accessorArg.body;
  if (body?.kind === "member" && body.receiver.kind === "ref") return body.member;
  return undefined;
}
