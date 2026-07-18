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
  lambdaArg,
  namedArgValue,
  numericNamed,
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
  // The bound rows expression before any sort/slice wrapping.  Sort and slice
  // both preserve nothing about it except count (sort reorders, slice narrows),
  // so the pager reads the pre-slice total off this base expression.
  const boundRowsExpr = rowsExpr;

  // `serverPaged: true` (M-T2.6): the bound rows are ALREADY the server's page
  // (a `Paged<T>.items` slice, ordered by the server) — the frontend does no
  // client-side sort/slice; the sortable header + pager instead write page/sort
  // STATE that the query's `of:` args feed back for a refetch.  `totalPages:` is
  // the envelope's page count (drives the pager's "of M" + Next-disable).
  const serverPaged = boolNamed(call, "serverPaged");
  const totalPagesArg = namedArgValue(call, "totalPages");

  // Column filter (M-T1.1 client).  A `filter:` state ref binds a search box
  // (rendered ABOVE the table) that narrows the rows by a case-insensitive
  // substring match across every value.  Client-only: `serverPaged` rows are a
  // server window, so a client filter would silently narrow one page — gated
  // off there (a server-driven filter is a later slice, like sort/pager).  A
  // target without the seams ignores the arg (byte-identical plain table).
  const filterName = refArgName(call, "filter");
  const filterActive =
    filterName !== undefined &&
    !serverPaged &&
    ctx.target.renderFilteredRows !== undefined &&
    ctx.target.renderFilterInput !== undefined;
  const filterRef = filterName !== undefined ? stateRefFor(filterName) : undefined;
  let filterMarkup: string | undefined;
  if (filterActive && filterRef) {
    ctx.usesState = true;
    ctx.usesTableFilter = true;
    rowsExpr = ctx.target.renderFilteredRows!(rowsExpr, filterRef);
    filterMarkup = ctx.target.renderFilterInput!(filterRef);
  }

  // Column sort (M-T1.1 client / M-T2.6 server).  The clickable sortable
  // HEADERS render in both modes (they write `sortKey`/`sortDir` state); only
  // CLIENT mode additionally wraps the rows in a client-side `sortRows`.  A
  // target without the seam ignores the args and renders a plain table.
  const sortKeyName = refArgName(call, "sortKey");
  const sortDirName = refArgName(call, "sortDir");
  const sortActive =
    sortKeyName !== undefined &&
    sortDirName !== undefined &&
    ctx.target.renderSortableHeader !== undefined;
  const sortKeyRef = sortKeyName !== undefined ? stateRefFor(sortKeyName) : undefined;
  const sortDirRef = sortDirName !== undefined ? stateRefFor(sortDirName) : undefined;
  if (sortActive && sortKeyRef && sortDirRef) {
    ctx.usesState = true;
    if (!serverPaged && ctx.target.renderSortedRows !== undefined) {
      // Signals the page-shell to import the shared `sortRows` helper.  Targets
      // whose `renderSortedRows` inlines the sort (React) leave the flag unread;
      // targets that call the helper (Vue/Svelte/Angular — their strict
      // templates reject the inline `as`-cast comparator) read it to import.
      ctx.usesTableSort = true;
      rowsExpr = ctx.target.renderSortedRows(rowsExpr, sortKeyRef, sortDirRef);
    }
  }

  // Pagination (M-T1.1 client-`.slice` / M-T2.6 server).  Active when the Table
  // carries a `page:` state ref AND the target implements `renderPager`.  Client
  // mode `.slice`s the bound rows to the active window and computes the page
  // count from their length; server mode leaves the rows (already a page) alone
  // and reads the count from `totalPages:`.  Either way a per-target pager is
  // appended below the table; an un-ported target renders unpaged.
  const pageName = refArgName(call, "page");
  const pageSize = numericNamed(call, "pageSize") ?? 10;
  const pagedActive =
    pageName !== undefined && pageSize > 0 && ctx.target.renderPager !== undefined;
  const pageRef = pageName !== undefined ? stateRefFor(pageName) : undefined;
  let pagerMarkup: string | undefined;
  if (pagedActive && pageRef) {
    ctx.usesState = true;
    let totalPagesExpr: string;
    if (serverPaged) {
      // Server owns the page window; the envelope carries the page count.
      const tp = totalPagesArg ? emitExpr(totalPagesArg, ctx) : "1";
      totalPagesExpr = `Math.max(1, ${tp})`;
    } else {
      const pageRead = ctx.target.renderStateRead(pageRef, "template");
      // The (post-sort, pre-slice) rows expression — its `.length` is the pager's
      // pre-slice total (sort preserves count).  When sort is active this is a
      // sorted array guaranteed non-null (`sortRows(…)` returns `T[]`; the React
      // inline `[...].sort` too), so no `?? []` guard is added — a redundant
      // guard on a never-nullish operand is a strict-Angular error (TS2869).
      const preSliceExpr = rowsExpr;
      rowsExpr = `(${preSliceExpr}).slice((${pageRead} - 1) * ${pageSize}, ${pageRead} * ${pageSize})`;
      // Filter and sort both leave `rowsExpr` a non-null array (`.filter(...)` /
      // `sortRows(...)` / `[...].sort(...)`), so when either is active the total
      // reads off the transformed (post-filter) expression with no `?? []`
      // guard — a redundant guard on a never-nullish operand is a strict-Angular
      // error (TS2869).  Untransformed rows keep the guard.
      const rowsTransformed = sortActive || filterActive;
      const totalBase = rowsTransformed ? preSliceExpr : boundRowsExpr;
      const lengthExpr = /\?\?\s*\[\]\s*$/.test(totalBase.trim())
        ? `(${totalBase}).length`
        : rowsTransformed
          ? `(${totalBase}).length`
          : `((${totalBase}) ?? []).length`;
      totalPagesExpr = `Math.max(1, Math.ceil(${lengthExpr} / ${pageSize}))`;
    }
    pagerMarkup = ctx.target.renderPager!({ page: pageRef, totalPagesExpr });
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
  const tableMarkup = renderPrimitive(ctx, "primitive-table", {
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
  // The pager renders as a sibling below the table (both inside the scaffold's
  // `Paper`); the filter box renders as a sibling ABOVE it.  Concatenation
  // keeps the table markup untouched for a plain table (byte-identical) and
  // wraps it only with the controls actually requested.
  let result = pagerMarkup ? `${tableMarkup}\n${closeIndent}${pagerMarkup}` : tableMarkup;
  if (filterMarkup) {
    result = `${filterMarkup}\n${closeIndent}${result}`;
    // The filter box makes the table MULTI-ROOT (the search box + the table are
    // adjacent siblings).  JSX rejects adjacent elements in a single-expression
    // slot — a `QueryView`'s `{cond && ( … )}`, a conditional child — so React
    // wraps the pair in a `<>…</>` fragment; the multi-root-tolerant frameworks
    // (Vue/Svelte/Angular) omit the seam.  Scoped to the filter box: the pager
    // alone is emitted under a pack wrapper (`<Paper>`) in scaffolded pages, so
    // wrapping it too would add a redundant fragment there (fixture drift) for
    // no gain — a bare pager-only `QueryView` is a pre-existing edge left as-is.
    if (ctx.target.wrapMultiRoot) result = ctx.target.wrapMultiRoot(result);
  }
  return result;
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
