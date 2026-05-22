// Api-hook injection: detects `<apiParam>.<aggregate>.<op>(args?)` (and
// the param-less / Views variants) inside walked expressions, records a
// deduped hook usage on the walk sink, and renders the page-top import
// lines. The page shell emits the `const <var> = use<Op><Agg>(args)`
// declarations from the recorded usages.
//
// emitExpr (core) calls tryDetectApiHook/registerApiHook, and buildHookUse
// calls back into emitExpr to render hook args — a call-time cycle ESM
// resolves fine; the type imports below are erased.

import type { ExprIR } from "../../../ir/loom-ir.js";
import { camel, pascal, plural } from "../../../util/naming.js";
import type { ApiHookUse, WalkContext } from "../body-walker.js";
import { emitExpr } from "../body-walker.js";

export function tryDetectApiHook(expr: ExprIR, ctx: WalkContext): ApiHookUse | null {
  // Pattern A: member(member(ref:apiParam, agg), op)
  if (expr.kind === "member" && expr.receiver.kind === "member") {
    const inner = expr.receiver;
    if (inner.receiver.kind === "ref" && ctx.apiParamNames.has(inner.receiver.name)) {
      return buildHookUse(inner.member, expr.member, [], ctx);
    }
  }
  // Pattern B: method-call(member(ref:apiParam, agg), op, args)
  if (expr.kind === "method-call" && expr.receiver.kind === "member") {
    const inner = expr.receiver;
    if (inner.receiver.kind === "ref" && ctx.apiParamNames.has(inner.receiver.name)) {
      return buildHookUse(inner.member, expr.member, expr.args, ctx);
    }
  }
  // Pattern C: member(ref:"Views", viewName) lifts to
  // `useXxxView()` from `../api/views`.
  if (expr.kind === "member" && expr.receiver.kind === "ref" && expr.receiver.name === "Views") {
    return buildViewHookUse(expr.member);
  }
  // Pattern D: member(ref:<Aggregate>, op) without an
  // api param prefix lifts to the same hook Pattern A produces.
  // Lets UIs without a `api X: Y` binding still get auto-injected
  // hooks (e.g. legacy `scaffold modules: M` deployables that
  // never declared api params).
  if (
    expr.kind === "member" &&
    expr.receiver.kind === "ref" &&
    ctx.aggregatesByName.has(expr.receiver.name)
  ) {
    return buildHookUse(expr.receiver.name, expr.member, [], ctx);
  }
  // Pattern E: same as D but with method-call args
  // (parameterised forms like `Account.byId(id)`).
  if (
    expr.kind === "method-call" &&
    expr.receiver.kind === "ref" &&
    ctx.aggregatesByName.has(expr.receiver.name)
  ) {
    return buildHookUse(expr.receiver.name, expr.member, expr.args, ctx);
  }
  return null;
}

/** `useXxxView()` hook injection.  View hooks live in
 *  the shared `../api/views.ts` module; the local var name is
 *  `<viewCamel>View` (e.g. `activeOrdersView`). */
function buildViewHookUse(viewName: string): ApiHookUse {
  const viewPascal = pascal(viewName);
  return {
    varName: `${camel(viewName)}View`,
    hookName: `use${viewPascal}View`,
    importFrom: "../api/views",
    argsRendered: [],
  };
}

/** Build the ApiHookUse for a detected `<aggregate>.<op>(args?)`
 *  reference.  Naming convention matches the existing scaffold
 *  output (see `webApp/src/api/<aggregate>.ts`):
 *    `<agg>.all`    → useAll<Plural>
 *    `<agg>.byId`   → use<Single>ById  (parameterized)
 *    `<agg>.create` → useCreate<Single>
 *    `<agg>.update` → useUpdate<Single>
 *    `<agg>.delete` → useDelete<Single>
 *    `<agg>.<find>` → use<FindPascal><Single>  (custom finder)
 *
 *  The local var name is `<aggCamel><OpPascal>` — deterministic,
 *  visible in the generated file, never invented by the user. */
function buildHookUse(aggregate: string, op: string, args: ExprIR[], ctx: WalkContext): ApiHookUse {
  const aggSingle = pascal(aggregate);
  const aggPlural = plural(aggSingle);
  let hookName: string;
  if (op === "all") hookName = `useAll${aggPlural}`;
  else if (op === "byId") hookName = `use${aggSingle}ById`;
  else if (op === "create") hookName = `useCreate${aggSingle}`;
  else if (op === "update") hookName = `useUpdate${aggSingle}`;
  else if (op === "delete") hookName = `useDelete${aggSingle}`;
  else hookName = `use${pascal(op)}${aggSingle}`;
  const varName = `${camel(aggSingle)}${pascal(op)}`;
  const importFrom = `../api/${camel(aggSingle)}`;
  // Render args via the main ctx so refs to params/state propagate
  // (param refs add to `usedParams` → the shell destructures them
  // from `useParams`; state refs are an error since the hook lives
  // before useState in the function body).
  const argsRendered = args.map((a) => emitExpr(a, ctx));
  return { varName, hookName, importFrom, argsRendered };
}

/** Register a detected hook usage on the walker context.  De-dupes
 *  by var name — if the same `<param>.<aggregate>.<op>` appears
 *  twice in the body, only one declaration is emitted at page-top. */
export function registerApiHook(hook: ApiHookUse, ctx: WalkContext): void {
  if (!ctx.usedApiHooks.has(hook.varName)) {
    ctx.usedApiHooks.set(hook.varName, hook);
  }
}
