// Interactive control primitives: Button, IdLink, QueryView, and the
// user-defined-component invocation path. These reach into the api-hook
// detection (via emitExpr), navigation, lambda handlers, and aggregate
// lookups, so they pull the core walk/expr/stmt helpers.

import { pagedReturn } from "../../../ir/stdlib/generics.js";
import type { ExprIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { humanize, lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { tryRenderGate } from "../../_frontend/gate-expr.js";
import { ariaLabelAttr } from "../a11y-emit.js";
import { tryDetectApiHook } from "../api-hook-detector.js";
import { lookupBuiltinIcon } from "../icons.js";
import { renderPrimitive } from "../render-primitive.js";
import {
  actionHandlerName,
  actionRefArg,
  boolNamed,
  lambdaArg,
  namedArgValue,
  positionalArgs,
  stringNamed,
  unwrapTextLiteral,
} from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import {
  emitExpr,
  emitStmt,
  extendLambdaParams,
  firstPositionalContent,
  propagateChildFlags,
  recordStoreUse,
  storeLocalFor,
  stringOrRefArgValue,
  styleAttr,
  testidAttr,
  walk,
} from "../walker-core.js";

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
    return ctx.target.renderComment(`IdLink: missing 'of:' aggregate ref`);
  }
  // When aggregate IR is in scope, prefer the official
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
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitButton(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const label = firstPositionalContent(call, ctx) ?? '"Button"';
  void depth;
  // `onClick:` lambda named arg wires the button to
  // a multi-statement event handler.  Takes priority over `to:` if
  // both are written.
  // A named-action reference (`onClick: confirm`) binds the hoisted handler
  // the page-shell emits from `page.actions` (named-actions-and-stores.md,
  // Proposal A Stage 1).  An onClick action is nullary (a button supplies no
  // payload); JSX binds the bare function value (`onClick={confirm}`),
  // statement-binding targets (Angular `(click)`) bind the call (`confirm()`)
  // through the event-handler seam.
  const onClickAction = actionRefArg(call, "onClick");
  const onClick = lambdaArg(call, "onClick");
  let onClickHandler: string | undefined;
  if (onClickAction?.storeName) {
    // A bare STORE action as the handler (`onClick: Cart.clear`) — record the
    // store use (so the shell binds the store-action local) and reference that
    // local, exactly as a store-action call from a body does.  Without this the
    // handler was silently dropped on every frontend (the ref matched neither
    // `actionRefArg`'s page-action path nor `to:`/lambda).
    recordStoreUse(ctx, onClickAction.storeName, onClickAction.actionName);
    const local = storeLocalFor(ctx, onClickAction.storeName, onClickAction.actionName);
    onClickHandler = ctx.target.renderEventHandler
      ? ctx.target.renderEventHandler([`${local}();`], undefined)
      : local;
  } else if (onClickAction) {
    ctx.usedActions?.add(onClickAction.actionName);
    const handler = actionHandlerName(onClickAction.actionName);
    onClickHandler = ctx.target.renderEventHandler
      ? ctx.target.renderEventHandler([`${handler}();`], undefined)
      : handler;
  } else if (onClick && (onClick.block || onClick.body)) {
    onClickHandler = emitLambdaBody(onClick, ctx);
  } else {
    // `to:` named arg wires the button to a React
    // Router navigate call.  Accepts either a string-literal path
    // or a route-param ref.
    const to = stringOrRefArgValue(call, "to", ctx);
    if (to) {
      ctx.usesNavigate = true;
      // Route through the navigate + event-handler seams so statement-binding
      // targets (Angular `(click)`) get `router.navigateByUrl(<to>)` instead of
      // a JSX arrow.  JSX family: both seams are omitted → `() => navigate(<to>)`
      // (byte-identical to the prior hardcoded form).
      const navExpr = ctx.target.renderNavigateExpr?.(to) ?? `navigate(${to})`;
      onClickHandler = ctx.target.renderEventHandler
        ? ctx.target.renderEventHandler(undefined, navExpr)
        : `() => ${navExpr}`;
    }
  }
  // `disabled:` and `loading:` named args.  Both
  // accept any expression (typically a hook accessor like
  // `Sales.Customer.create.isPending` — emitExpr triggers hook
  // injection so the local hook var is available at page-top).
  const disabled = anyNamedArgExpr(call, "disabled", ctx);
  const loading = anyNamedArgExpr(call, "loading", ctx);
  // Phase 5 — variant + icon slot.  `variant: "primary" | "secondary"
  // | "ghost"` maps to each pack's idiomatic rank ("filled" / "outline"
  // / "subtle" on Mantine, "default" / "outline" / "ghost" on shadcn).
  // `icon:` + `iconPosition:` lets a button display an SVG glyph from
  // the builtin Icon set (or an inline svg via `iconSvg:`).
  const variant = stringNamed(call, "variant");
  const icon = stringNamed(call, "icon");
  const iconSvg = stringNamed(call, "iconSvg");
  const iconPosition = stringNamed(call, "iconPosition") ?? "right";
  // `label:` supplies an explicit accessible name (aria-label) — the command's
  // a11y contract needs a name, and the visible text can be an unhelpful glyph
  // or the default "Button" when the button leads with an `icon:`.
  const ariaLabel = stringNamed(call, "label");
  // Resolve a builtin icon name to its inline SVG so the template
  // doesn't need to know the registry.  Custom SVG passes through.
  let resolvedIconSvg: string | undefined = iconSvg;
  if (!resolvedIconSvg && icon) {
    resolvedIconSvg = lookupBuiltinIcon(icon);
  }
  return renderPrimitive(ctx, "primitive-button", {
    label: unwrapTextLiteral(label, ctx.target.escapeText),
    onClick: onClickHandler,
    hasOnClick: onClickHandler !== undefined,
    disabled,
    hasDisabled: disabled !== undefined,
    loading,
    hasLoading: loading !== undefined,
    variant,
    hasVariant: variant !== undefined,
    iconSvg: resolvedIconSvg,
    hasIcon: resolvedIconSvg !== undefined,
    iconPosition,
    // HTML-ish frontends consume the ready-made ` aria-label="…"` fragment;
    // Feliz (F#) reads the raw `ariaLabel` to build `prop.ariaLabel`.
    a11yAttr: ariaLabelAttr(ariaLabel),
    ariaLabel,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

/** `Action(<instance>.<operation>, then?: <effect>)` — a button bound
 *  to an aggregate operation invoked on an in-scope instance.  The
 *  operation is referenced through the instance (`order.confirm`), so
 *  the receiver carries both the aggregate (resolved via
 *  `ctx.paramTypes`) and the id to mutate (`order.id`).  Records the
 *  mutation hook on `ctx.actionMutations` for the shell to declare at
 *  function top, then renders a button whose onClick fires the
 *  mutation and runs the optional `then:` effect on success. */
export function emitAction(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // A target may fork the whole primitive (Angular renders an inline
  // statement-bound button + an id-at-mutate hoist instead of a JSX arrow).
  const override = ctx.target.renderAction?.(call, ctx, depth);
  if (override != null) return override;
  const opRef = positionalArgs(call)[0];
  if (!opRef || opRef.kind !== "member" || opRef.receiver.kind !== "ref") {
    return ctx.target.renderComment(
      `Action: first argument must be <instance>.<operation> (e.g. order.confirm)`,
    );
  }
  const instanceName = opRef.receiver.name;
  const opName = opRef.member;
  const aggName = ctx.paramTypes?.get(instanceName);
  if (!aggName) {
    return ctx.target.renderComment(
      `Action(${instanceName}.${opName}): '${instanceName}' is not an in-scope aggregate instance`,
    );
  }
  const agg = ctx.aggregatesByName.get(aggName);
  if (!agg) {
    return ctx.target.renderComment(
      `Action(${instanceName}.${opName}): aggregate ${aggName} not found`,
    );
  }
  const op = agg.operations.find((o) => o.name === opName && o.visibility === "public");
  if (!op) {
    return ctx.target.renderComment(
      `Action(${instanceName}.${opName}): no public operation '${opName}' on ${agg.name}`,
    );
  }
  // Hoist the mutation hook to function top (React requires hooks at
  // component scope, not inside the onClick handler).
  const localVar = `${lowerFirst(op.name)}${agg.name}`;
  const hookName = `use${upperFirst(op.name)}${agg.name}`;
  // Optional-chain the receiver: on a byId/single detail page the receiver is
  // the query `data`, which is `undefined` until the fetch resolves.  React
  // re-runs the hook per render (so it captures the real id once loaded); Vue
  // (setup runs once) and Svelte (getter) tolerate the `undefined`.  Without
  // the `?.`, React/Vue crash on mount dereferencing `.id` of pending data.
  const idExpr = `${emitExpr(opRef.receiver, ctx)}?.id`;
  if (!ctx.actionMutations.some((m) => m.localVar === localVar)) {
    ctx.actionMutations.push({
      localVar,
      hookName,
      aggCamel: lowerFirst(agg.name),
      idExpr,
    });
  }
  const thenArg = namedArgValue(call, "then");
  const thenJs = thenArg ? emitActionThen(thenArg, ctx) : undefined;
  const mutateCall = `${localVar}.mutateAsync({})`;
  const onClick = thenJs
    ? `() => void ${mutateCall}.then(() => { ${thenJs}; })`
    : `() => void ${mutateCall}`;
  const button = renderPrimitive(ctx, "primitive-button", {
    label: humanize(op.name),
    onClick,
    hasOnClick: true,
    disabled: undefined,
    hasDisabled: false,
    loading: `${localVar}.isPending`,
    hasLoading: true,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
  // Action-button gating (D-AUTH-OIDC, the action-level mirror of the page
  // `requires` guard).  On an `auth: ui` frontend, hide the button at runtime
  // when EVERY `requires` predicate on the operation is currentUser-only (the
  // verified session claims can decide it client-side).  If the op has no
  // `requires`, or ANY predicate touches `this.<field>` / params (not
  // client-evaluable — `tryRenderGate` returns null), the button stays
  // ungated; the backend 403 still enforces the gate (defence-in-depth).
  if (ctx.authUi) {
    const gates = op.statements.filter((s) => s.kind === "requires").map((s) => s.expr);
    if (gates.length > 0) {
      const parts = gates.map((g) => tryRenderGate(g, "currentUser"));
      if (parts.every((p) => p !== null)) {
        ctx.usesCurrentUser = true;
        return ctx.target.renderConditionalChild(
          parts.map((p) => `(${p})`).join(" && "),
          button,
          "null",
          depth,
        );
      }
    }
  }
  return button;
}

/** Render an `Action`'s `then:` effect — the JS run after the
 *  mutation resolves.  `navigate(<Page>, { …params })` delegates
 *  to `tsxTarget.renderNavigate` (cross-framework contract — see
 *  src/generator/_walker/target.ts); any other expression falls
 *  through to `emitExpr`.
 *
 *  The page-ref → route slug derivation stays walker-local (it
 *  reads `ctx.pageRoutes` which is a walker concern); the contract
 *  consumes a pre-resolved route template.  The `usesNavigate`
 *  side-effect (drives the shell's `useNavigate` import) also stays
 *  walker-local. */
export function emitActionThen(then: ExprIR, ctx: WalkContext): string {
  if (then.kind === "call" && then.name === "navigate") {
    const pageRef = then.args[0];
    const route =
      pageRef && pageRef.kind === "ref"
        ? (ctx.pageRoutes?.get(pageRef.name) ?? `/${snake(pageRef.name)}`)
        : "/";
    ctx.usesNavigate = true;
    const stateArg = then.args[1];
    // Source's second arg is rendered as an opaque expression
    // (`navigate(Page, someRef)` / `navigate(Page, computeState())`).
    // The contract's `stateExpr` escape hatch wraps it as the
    // `state:` value verbatim; the args[] path is reserved for the
    // future kv-decomposed shape.
    const stateExpr = stateArg ? emitExpr(stateArg, ctx) : undefined;
    return ctx.target.renderNavigate(route, [], stateExpr);
  }
  return emitExpr(then, ctx);
}

/** Render any named arg's value through emitExpr.
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
  const statements =
    lam.block && lam.block.length > 0 ? lam.block.map((s) => emitStmt(s, ctx)) : undefined;
  const expr = !statements && lam.body ? emitExpr(lam.body, ctx) : undefined;
  // Frameworks whose event bindings take a STATEMENT, not a function
  // value (Angular `(click)`), override the wrapping; the JSX family
  // keeps the arrow default.
  if (ctx.target.renderEventHandler) {
    return ctx.target.renderEventHandler(statements, expr);
  }
  if (statements) return `() => { ${statements.join(" ")} }`;
  if (expr !== undefined) return `() => ${expr}`;
  return `() => {}`;
}

/** Resolve the aggregate a single-record QueryView yields, from its
 *  `of:` query expression.  Conventionally `<handle>.<Agg>.byId(id)`
 *  (a method-call whose receiver names the aggregate) or `<Agg>.byId`
 *  with no api handle.  Returns the aggregate name when it's known to
 *  this UI, else undefined. */
function singleAggregateOfQuery(ofArg: ExprIR, ctx: WalkContext): string | undefined {
  const recv = ofArg.kind === "method-call" ? ofArg.receiver : ofArg;
  const name = recv.kind === "member" ? recv.member : recv.kind === "ref" ? recv.name : undefined;
  return name && ctx.aggregatesByName.has(name) ? name : undefined;
}

/** Does the `of:` query return the `Paged<T>` envelope (the paged-by-default
 *  auto-`findAll`, M-T2.6)?  Resolved from the owning context's repository the
 *  same way the hook-arg adjuster does — so a hand-written
 *  `QueryView { of: X.all, data: rows => Table { rows: rows } }` unwraps the
 *  envelope automatically instead of `.map`-ing over `{items, page, …}`.
 *  Event-sourced `all` (an unpaged fold) and user finds returning `T[]` return
 *  false, so they keep bare-array semantics. */
function queryIsPaged(ofArg: ExprIR, ctx: WalkContext): boolean {
  const detected = tryDetectApiHook(ofArg, ctx);
  if (!detected || detected.kind !== "aggregate") return false;
  const bc = ctx.bcByAggregate.get(detected.aggregateName);
  const repo = bc?.repositories.find((r) => r.aggregateName === detected.aggregateName);
  const find = repo?.finds.find((f) => f.name === detected.operation);
  return find ? !!pagedReturn(find.returnType) : false;
}

export function emitQueryView(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const ofArg = namedArgValue(call, "of");
  if (!ofArg) {
    return ctx.target.renderComment(`QueryView: missing 'of:' query expression`);
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
  // `single: true` flips QueryView to single-record
  // semantics (byId queries return `T | undefined`, not `T[]`).
  // The `empty` branch fires when `data === undefined` after
  // loading completes; `data` branch fires when `data` is truthy.
  // Without the flag, the default collection semantics apply
  // (`data && data.length === 0` / `data && data.length > 0`).
  const single = boolNamed(call, "single");
  // `paged: true` (scaffold, M-T2.6) flips QueryView to server-paged semantics:
  // the query's `.data` is the `Paged<T>` envelope `{items, page, pageSize,
  // total, totalPages}`, and the `data:` lambda binds to `.data` (the envelope)
  // so the scaffold body reads `rows.items` + the page metadata for its pager.
  //   AUTO-PAGED (no explicit flag): a hand-written `QueryView { of: X.all,
  // data: rows => Table { rows: rows } }` still sees a paged `.all` — but the
  // author wrote it for an array.  Derive paged-ness from the query's
  // returnType and, when it wasn't opted into explicitly, bind the lambda to
  // `.data.items` (the ARRAY) so the body keeps bare-array semantics (page 1,
  // no pager) — byte-identical to the pre-flip behaviour.  Either way the
  // empty/non-empty length checks read `.items` (`paged` drives the template).
  const explicitPaged = boolNamed(call, "paged");
  const autoPaged = !explicitPaged && !single && queryIsPaged(ofArg, ctx);
  const paged = explicitPaged || autoPaged;

  const loadingJsx = loading ? walk(loading, ctx, depth + 2) : "null";
  const errorJsx = error ? walk(error, ctx, depth + 2) : "null";
  const emptyJsx = empty ? walk(empty, ctx, depth + 2) : "null";

  // `data:` branch supports the lambda-binding form `rows => …`.
  // Lambda body walks with the lambda param rebound to the
  // unwrapped query data; non-lambda bodies render as-is.
  let dataJsx: string;
  if (data && data.kind === "lambda") {
    // When the query yields a single known aggregate record, type the
    // data-lambda binding so `OperationForm(data.<op>)` / `Action(data.<op>)`
    // inside it resolve the aggregate (the IR carries no receiverType
    // for page bodies).
    const recordAgg = single ? singleAggregateOfQuery(ofArg, ctx) : undefined;
    const childParamTypes = recordAgg
      ? new Map([...(ctx.paramTypes ?? []), [data.param, recordAgg]])
      : ctx.paramTypes;
    // Auto-paged: unwrap the envelope to its `.items` array so a hand-written
    // body (`Table { rows: rows }`) maps over records, not `{items, …}`.  The
    // explicit-paged (scaffold) binding stays the envelope — its Table reads
    // `rows.items` and the pager reads `rows.totalPages` off it.  The unwrap is
    // the target's call (the JSX fallback appends `.items`; Feliz already
    // decodes `all` to a `'T list`, so it ignores `autoPaged`).
    const dataAccess =
      ctx.target.renderQueryDataAccess?.(queryExpr, single, paged, autoPaged) ??
      (autoPaged ? `${queryExpr}.data.items` : `${queryExpr}.data`);
    // On a list-decoding target (Feliz), a paged binding IS already the array,
    // so mark it for the member walk to strip the scaffold's `rows.items`.
    const childPagedListBindings =
      paged && ctx.target.pagedDataIsList
        ? new Set([...(ctx.pagedListBindings ?? []), data.param])
        : ctx.pagedListBindings;
    const childCtx: WalkContext = {
      ...ctx,
      lambdaParams: extendLambdaParams(ctx, data.param, dataAccess),
      paramTypes: childParamTypes,
      pagedListBindings: childPagedListBindings,
    };
    dataJsx = data.body ? walk(data.body, childCtx, depth + 2) : "null";
    propagateChildFlags(ctx, childCtx);
  } else if (data) {
    dataJsx = walk(data, ctx, depth + 2);
  } else {
    dataJsx = "null";
  }

  // `paged` drives the pack template's empty / non-empty length checks to read
  // the envelope's `.items` (`<query>.data.items.length`, or the framework's
  // signal / `?? []` variant) instead of a bare `<query>.data.length`.  The
  // `data:` lambda binding stays `<query>.data` (the envelope) in both modes —
  // a paged body reads `rows.items` / `rows.totalPages` off it.
  return renderPrimitive(ctx, "primitive-query-view", {
    queryExpr,
    loadingJsx,
    errorJsx,
    emptyJsx,
    dataJsx,
    single,
    paged,
    indent,
    branchIndent,
    closeIndent,
    testidAttr: testidAttr(call, ctx),
    styleAttr: styleAttr(call, ctx),
  });
}

export function emitUserComponent(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Invoke a user-defined component as a JSX element.
  // Positional args map to the component's declared param names by
  // position; named args use their `name:` prefix verbatim.  String
  // literals render as quoted attrs (`name="Alice"`); refs / binary
  // ops / non-string literals emit through emitExpr inside `{...}`.
  //
  // Positional args BEYOND the component's declared
  // param count are JSX children — wrapped between the open and
  // close tags so the component receives them via the `children`
  // prop.  Named args still go to props regardless of position.
  //
  // `slot`-typed params (PR B) take any walker expression as a
  // value and the arg renders as JSX in the caller's scope, brace-
  // wrapped into the prop position (`prop={<Heading … />}`) — see
  // attrValue's slot branch below.
  const params = ctx.userComponents.get(call.name) ?? [];
  ctx.usedUserComponents.add(call.name);
  const argNames = call.argNames ?? [];
  // Collect names already filled by named args so
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
    const namedTarget = argNames[i];
    if (namedTarget !== undefined) {
      const param = params.find((p) => p.name === namedTarget);
      attrs.push(componentAttr(namedTarget, arg, ctx, depth, param?.type));
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
      attrs.push(componentAttr(param.name, arg, ctx, depth, param.type));
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

/** Render a single user-component attribute, name included
 *  (`name="text"` / `:name="expr"` / `name={expr}` per framework).
 *  String literals → a static quoted attr (`name="text"`, identical
 *  across frameworks); a slot-typed param walks its arg as JSX in the
 *  caller's scope, brace-wrapped into a `ReactNode` prop (react-only);
 *  an action-typed param emits a typed arrow (Tier 2, react-only);
 *  every other dynamic value routes through the target's
 *  `renderAttrBinding` so the JSX vs Vue-`v-bind` form is the seam's
 *  call, not hardcoded here. */
function componentAttr(
  name: string,
  expr: ExprIR,
  ctx: WalkContext,
  depth: number,
  paramType?: TypeIR,
): string {
  const isSlot =
    paramType?.kind === "slot" ||
    (paramType?.kind === "optional" && paramType.inner.kind === "slot");
  const action =
    paramType?.kind === "action"
      ? paramType
      : paramType?.kind === "optional" && paramType.inner.kind === "action"
        ? paramType.inner
        : undefined;
  if (action && expr.kind === "lambda") {
    return `${name}={${emitActionLambda(expr, action, ctx)}}`;
  }
  if (!isSlot && expr.kind === "literal" && expr.lit === "string") {
    return `${name}=${JSON.stringify(expr.value)}`;
  }
  if (isSlot) {
    // Slot args walk in the caller's env — `order.confirm` /
    // `navigate(Home)` / referenced state and route-params resolve
    // against the caller's scope, not the component's.  Any walker
    // flags raised inside (usesNavigate, usesRouterLink, …) propagate
    // through `ctx` directly since we walk against the same context.
    const jsx = walk(expr, ctx, depth + 1);
    return `${name}={${jsx}}`;
  }
  // Dynamic non-slot value — the target owns the cross-framework
  // dynamic-attr form (`name={expr}` JSX vs `:name="expr"` v-bind).
  // `renderAttrBinding` returns the attr with a leading separator
  // space; the open-tag assembly adds its own, so trim it here.
  return ctx.target.renderAttrBinding(name, emitExpr(expr, ctx)).trimStart();
}

/** Render a lambda passed to an `action`-typed component param as a TS
 *  arrow function (extern-component-escape-hatch.md, Tier 2).  Unlike
 *  `emitLambdaBody` (event handlers, param dropped), the lambda's param
 *  stays bound — the component calls the prop with the declared arg —
 *  and the body statements walk in the *caller's* scope, exactly as
 *  `onSubmit` does: state writes hit the caller's `state {}` setters,
 *  `navigate(…)` / `toast(…)` resolve against the caller's imports.
 *  When the declared arg is an aggregate, the param is typed through
 *  `paramTypes` so `Action(p.<op>)`-style resolution sees it. */
function emitActionLambda(
  lam: ExprIR & { kind: "lambda" },
  action: TypeIR & { kind: "action" },
  ctx: WalkContext,
): string {
  const argName = lam.param;
  const childCtx: WalkContext = {
    ...ctx,
    lambdaParams: extendLambdaParams(ctx, argName, argName),
    paramTypes:
      action.arg?.kind === "entity"
        ? new Map([...(ctx.paramTypes ?? []), [argName, action.arg.name]])
        : ctx.paramTypes,
  };
  const head = action.arg ? `(${argName})` : "()";
  let body: string;
  if (lam.block && lam.block.length > 0) {
    body = `{ ${lam.block.map((s) => emitStmt(s, childCtx)).join(" ")} }`;
  } else if (lam.body) {
    body = emitExpr(lam.body, childCtx);
  } else {
    body = "{}";
  }
  propagateChildFlags(ctx, childCtx);
  return `${head} => ${body}`;
}
