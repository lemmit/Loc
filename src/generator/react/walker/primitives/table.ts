// Table primitive: emitTable renders a per-pack data table from a
// `rows:` expression and positional Column(...) calls. Column accessor
// lambdas rebind their source param to the emitted `row` identifier via
// the shared lambda-scope helpers. emitColumn is private to this module.

import type { ExprIR } from "../../../../ir/loom-ir.js";
import type { WalkContext } from "../../body-walker.js";
import {
  emitExpr,
  emitStmt,
  extendLambdaParams,
  propagateChildFlags,
  testidAttr,
  walk,
} from "../../body-walker.js";
import { renderPrimitive } from "../context.js";
import {
  boolNamed,
  escapeJsxText,
  lambdaArg,
  namedArgValue,
  positionalArgs,
  slugify,
  stringNamed,
} from "../shared/args.js";

export function emitTable(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const rowsArg = namedArgValue(call, "rows");
  const rowsExpr = rowsArg ? emitExpr(rowsArg, ctx) : "[]";
  const onRowClick = lambdaArg(call, "onRowClick");

  const positionals = positionalArgs(call);
  const cols = positionals
    .filter((a): a is ExprIR & { kind: "call" } => a.kind === "call" && a.name === "Column")
    .map((c, i) => emitColumn(c, ctx, i, depth + 3));

  const rowVar = "row";
  let onRowClickJs: string | undefined;
  if (onRowClick) {
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

  // Slice A9 — boolean style props matching Mantine's `<Table>`
  // surface.  shadcn templates ignore the props (their <Table> has
  // built-in striping); reading them here keeps the DSL pack-
  // agnostic.
  const striped = boolNamed(call, "striped");
  const highlight = boolNamed(call, "highlight");
  const sticky = boolNamed(call, "sticky");

  // Slice A13 — `keyExpr:` named arg overrides the default
  // `row.id` key.  Views with custom output (no `id` field on the
  // row type) supply `keyExpr: "idx"` (or similar) so the
  // `<Table.Tr key=…>` doesn't reference a non-existent field.
  // String-literal arg only — emitted verbatim into the JSX
  // expression.
  const keyExprArg = stringNamed(call, "keyExpr");
  const keyExpr = keyExprArg ?? `${rowVar}.id`;

  // Slice A9 — `rowTestid:` lambda computes a per-row testid.
  // The lambda's source-side param rebinds to `row` (Slice A2's
  // lambdaParams scope) so user code reads `row.id` cleanly.
  // The expression body emits inside a TS template literal so
  // dynamic ids interpolate (`orders-row-${row.id}`).
  const rowTestidLam = lambdaArg(call, "rowTestid");
  let rowTestidJs: string | undefined;
  if (rowTestidLam && rowTestidLam.body) {
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
  return renderPrimitive(ctx, "primitive-table", {
    rowsExpr,
    rowVar,
    keyExpr,
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
  });
}

/** Slice A2 — emit one `Column("Header", <accessor>)` into a
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
  let cellJsx = "{/* missing accessor */}";
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
        cellJsx = escapeJsxText(body.value);
      } else {
        cellJsx = `{${emitExpr(body, childCtx)}}`;
      }
    }
    propagateChildFlags(ctx, childCtx);
  }
  return {
    header: escapeJsxText(headerStr),
    cellJsx,
    key,
  };
}
