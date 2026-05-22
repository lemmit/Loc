// Interactive control primitives: Button, IdLink, QueryView, and the
// user-defined-component invocation path. These reach into the api-hook
// detection (via emitExpr), navigation, lambda handlers, and aggregate
// lookups, so they pull the core walk/expr/stmt helpers.

import type { ExprIR } from "../../../../ir/loom-ir.js";
import { plural, snake } from "../../../../util/naming.js";
import type { WalkContext } from "../../body-walker.js";
import {
  emitExpr,
  emitStmt,
  extendLambdaParams,
  firstPositionalContent,
  propagateChildFlags,
  stringOrRefArgValue,
  testidAttr,
  walk,
} from "../../body-walker.js";
import { renderPrimitive } from "../context.js";
import {
  boolNamed,
  lambdaArg,
  namedArgValue,
  positionalArgs,
  unwrapTextLiteral,
} from "../shared/args.js";

export function emitIdLink(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  const id = namedArgValue(call, "id") ?? positionalArgs(call)[0];
  const idExpr = id ? emitExpr(id, ctx) : '""';
  const ofArg = namedArgValue(call, "of");
  const aggName =
    ofArg && ofArg.kind === "ref"
      ? ofArg.name
      : ofArg && ofArg.kind === "literal" && ofArg.lit === "string"
        ? ofArg.value
        : undefined;
  if (!aggName) {
    return `{/* IdLink: missing 'of:' aggregate ref */}`;
  }
  // When aggregate IR is in scope (Slice A4), prefer the official
  // aggregate's plural-snake slug over our local pluralisation
  // pass — `agg.name` is canonical (already validated) and any
  // future irregular-plural rules live with the IR.  When the
  // aggregate isn't visible (e.g. a deployable that excludes its
  // module), we still emit a working link, just without IR-level
  // verification.
  const agg = ctx.aggregatesByName.get(aggName);
  const slug = agg ? plural(snake(agg.name)) : plural(snake(aggName));
  ctx.usesRouterLink = true;
  return renderPrimitive(ctx, "primitive-id-link", {
    idExpr,
    pathPrefix: `/${slug}/`,
    testidAttr: testidAttr(call, ctx),
  });
}

export function emitButton(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const label = firstPositionalContent(call, ctx) ?? '"Button"';
  void depth;
  // Slice 11.7 — `onClick:` lambda named arg wires the button to
  // a multi-statement event handler.  Takes priority over `to:` if
  // both are written.
  const onClick = lambdaArg(call, "onClick");
  let onClickHandler: string | undefined;
  if (onClick && (onClick.block || onClick.body)) {
    onClickHandler = emitLambdaBody(onClick, ctx);
  } else {
    // Slice 11.5 — `to:` named arg wires the button to a React
    // Router navigate call.  Accepts either a string-literal path
    // or a route-param ref.
    const to = stringOrRefArgValue(call, "to", ctx);
    if (to) {
      ctx.usesNavigate = true;
      onClickHandler = `() => navigate(${to})`;
    }
  }
  // Slice 11.29 — `disabled:` and `loading:` named args.  Both
  // accept any expression (typically a hook accessor like
  // `Sales.Customer.create.isPending` — emitExpr triggers hook
  // injection so the local hook var is available at page-top).
  const disabled = anyNamedArgExpr(call, "disabled", ctx);
  const loading = anyNamedArgExpr(call, "loading", ctx);
  return renderPrimitive(ctx, "primitive-button", {
    label: unwrapTextLiteral(label),
    onClick: onClickHandler,
    hasOnClick: onClickHandler !== undefined,
    disabled,
    hasDisabled: disabled !== undefined,
    loading,
    hasLoading: loading !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}

/** Slice 11.29 — render any named arg's value through emitExpr.
 *  Used for boolean prop pass-through (`disabled:`, `loading:`)
 *  where the value is an arbitrary expression — refs, hook
 *  accessors, binary ops are all admissible. */
function anyNamedArgExpr(
  call: ExprIR & { kind: "call" },
  name: string,
  ctx: WalkContext,
): string | undefined {
  const arg = namedArgValue(call, name);
  return arg !== undefined ? emitExpr(arg, ctx) : undefined;
}

/** Render a Lambda IR as a TS arrow function suitable for an event
 *  handler position.  The lambda's source-side `param` name is
 *  dropped — v0 walker output is event-data-agnostic and emitting
 *  `() => …` keeps the generated code clean (no unused-var
 *  warnings).  Block-body lambdas emit a brace-wrapped sequence of
 *  statements; expression-body lambdas emit a single expression. */
function emitLambdaBody(lam: ExprIR & { kind: "lambda" }, ctx: WalkContext): string {
  if (lam.block && lam.block.length > 0) {
    const stmts = lam.block.map((s) => emitStmt(s, ctx)).join(" ");
    return `() => { ${stmts} }`;
  }
  if (lam.body) {
    return `() => ${emitExpr(lam.body, ctx)}`;
  }
  return `() => {}`;
}

export function emitQueryView(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const ofArg = namedArgValue(call, "of");
  if (!ofArg) {
    return `{/* QueryView: missing 'of:' query expression */}`;
  }
  // Render the query expression; this triggers `tryDetectApiHook`
  // so the page-shell registers the matching `useAll<X>()` (or
  // similar) hook decl + import, and we get the local var name
  // back via emitExpr's hook-detection path.
  const queryExpr = emitExpr(ofArg, ctx);

  const indent = "  ".repeat(depth + 1);
  const branchIndent = "  ".repeat(depth + 2);
  const closeIndent = "  ".repeat(depth);

  const loading = namedArgValue(call, "loading");
  const error = namedArgValue(call, "error");
  const empty = namedArgValue(call, "empty");
  const data = namedArgValue(call, "data");
  // Slice A11 — `single: true` flips QueryView to single-record
  // semantics (byId queries return `T | undefined`, not `T[]`).
  // The `empty` branch fires when `data === undefined` after
  // loading completes; `data` branch fires when `data` is truthy.
  // Without the flag, the default collection semantics apply
  // (`data && data.length === 0` / `data && data.length > 0`).
  const single = boolNamed(call, "single");

  const loadingJsx = loading ? walk(loading, ctx, depth + 2) : "null";
  const errorJsx = error ? walk(error, ctx, depth + 2) : "null";
  const emptyJsx = empty ? walk(empty, ctx, depth + 2) : "null";

  // `data:` branch supports the lambda-binding form `rows => …`.
  // Lambda body walks with the lambda param rebound to the
  // unwrapped query data; non-lambda bodies render as-is.
  let dataJsx: string;
  if (data && data.kind === "lambda") {
    const childCtx: WalkContext = {
      ...ctx,
      lambdaParams: extendLambdaParams(ctx, data.param, `${queryExpr}.data`),
    };
    dataJsx = data.body ? walk(data.body, childCtx, depth + 2) : "null";
    propagateChildFlags(ctx, childCtx);
  } else if (data) {
    dataJsx = walk(data, ctx, depth + 2);
  } else {
    dataJsx = "null";
  }

  return renderPrimitive(ctx, "primitive-query-view", {
    queryExpr,
    loadingJsx,
    errorJsx,
    emptyJsx,
    dataJsx,
    single,
    indent,
    branchIndent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
  });
}

export function emitUserComponent(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Slice 11.18 — invoke a user-defined component as a JSX element.
  // Positional args map to the component's declared param names by
  // position; named args use their `name:` prefix verbatim.  String
  // literals render as quoted attrs (`name="Alice"`); refs / binary
  // ops / non-string literals emit through emitExpr inside `{...}`.
  //
  // Slice 11.19 — positional args BEYOND the component's declared
  // param count are JSX children — wrapped between the open and
  // close tags so the component receives them via the `children`
  // prop.  Named args still go to props regardless of position.
  const params = ctx.userComponents.get(call.name) ?? [];
  ctx.usedUserComponents.add(call.name);
  const argNames = call.argNames ?? [];
  // Slice 11.19 — collect names already filled by named args so
  // positional args don't clobber them when looking up the next
  // free param slot.
  const filledByName = new Set<string>();
  for (let i = 0; i < argNames.length; i++) {
    const n = argNames[i];
    if (n !== undefined) filledByName.add(n);
  }
  const attrs: string[] = [];
  const childrenExprs: ExprIR[] = [];
  let nextParamCursor = 0;
  for (let i = 0; i < call.args.length; i++) {
    const arg = call.args[i]!;
    if (argNames[i] !== undefined) {
      attrs.push(`${argNames[i]}=${attrValue(arg, ctx)}`);
      continue;
    }
    // Advance the cursor past any params that were already filled
    // via a named arg.
    while (nextParamCursor < params.length && filledByName.has(params[nextParamCursor]!.name)) {
      nextParamCursor += 1;
    }
    const param = params[nextParamCursor];
    if (param) {
      nextParamCursor += 1;
      attrs.push(`${param.name}=${attrValue(arg, ctx)}`);
    } else {
      // No more declared params — extra positional arg becomes a
      // JSX child.
      childrenExprs.push(arg);
    }
  }
  const open = attrs.length > 0 ? `<${call.name} ${attrs.join(" ")}` : `<${call.name}`;
  if (childrenExprs.length === 0) {
    return `${open} />`;
  }
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  const childTsx = childrenExprs.map((c) => walk(c, ctx, depth + 1)).join(`\n${indent}`);
  return `${open}>\n${indent}${childTsx}\n${closeIndent}</${call.name}>`;
}

/** Slice 11.18 — render an ExprIR as a JSX attribute value.
 *  String literals → `"text"` (quoted attr); everything else →
 *  `{<emitExpr>}` (brace-wrapped JS expression). */
function attrValue(expr: ExprIR, ctx: WalkContext): string {
  if (expr.kind === "literal" && expr.lit === "string") {
    return JSON.stringify(expr.value);
  }
  return `{${emitExpr(expr, ctx)}}`;
}
