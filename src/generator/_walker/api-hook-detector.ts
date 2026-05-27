// ---------------------------------------------------------------------------
// API-hook detection — framework-agnostic IR pattern matching.
//
// Recognises the five DSL shapes that lower into an api call:
//
//   Pattern A: `member(member(ref:apiParam, agg), op)`           — `Sales.Customer.all`
//   Pattern B: `method-call(member(ref:apiParam, agg), op, args)` — `Sales.Customer.byId(id)`
//   Pattern C: `member(ref:"Views", viewName)`                    — `Views.activeOrders`
//   Pattern D: `member(ref:<Aggregate>, op)`                      — `Customer.create`   (no api-param prefix)
//   Pattern E: `method-call(ref:<Aggregate>, op, args)`           — `Customer.byId(id)` (no api-param prefix)
//
// Detection is PURE IR analysis — no framework assumptions, no
// emission.  Splitting it out of `react/walker/api-hooks.ts` (where it
// previously lived) lets a future Vue/Svelte/Blazor walker reuse the
// detector verbatim and plug in its own naming via the WalkerTarget's
// `buildHookUse` method.
//
// The returned `DetectedApiCall` carries everything the framework-
// specific naming layer needs: which aggregate (or view) is invoked,
// which operation, and the raw arg expressions (caller renders them
// via its walker context for ref-propagation side-effects).
// ---------------------------------------------------------------------------

import type { ExprIR } from "../../ir/types/loom-ir.js";

/** A framework-agnostic detected api call.  Produced by
 *  `tryDetectApiHook` from an `ExprIR` that matches one of the five
 *  documented patterns; consumed by `WalkerTarget.buildHookUse` to
 *  produce the per-framework hook naming (var, hook fn, import path). */
export interface DetectedApiCall {
  /** Either an aggregate PascalCase name (Patterns A/B/D/E) or
   *  the view name (Pattern C).  Disambiguated by `kind`. */
  aggregateName: string;
  /** The operation invoked off the aggregate, OR the view name
   *  itself for view hooks (Pattern C duplicates `aggregateName`
   *  into `operation` so consumers have a single shape).  Standard
   *  operations: `all`, `byId`, `create`, `update`, `delete`, plus
   *  user-declared finder / operation names. */
  operation: string;
  /** Argument expressions in source order.  Empty for `.all`-style
   *  reads and Pattern C view hooks.  Caller renders via its own
   *  walker context so refs to params/state propagate. */
  args: ExprIR[];
  /** Discriminator between the two-shape pipeline:
   *    `"aggregate"` — Patterns A/B/D/E (aggregate-rooted hook)
   *    `"view"`      — Pattern C (`Views.<viewName>`) */
  kind: "aggregate" | "view";
}

/** Detector context — the minimum subset of `WalkContext` the
 *  detection logic needs.  Decoupled from `WalkContext` so the
 *  detector doesn't pull a React-flavoured interface into the
 *  cross-framework `_walker/` directory.  Both fields are typed as
 *  `.has(name)`-bearing objects so any `Set<string>` / `Map<string, V>`
 *  the consuming walker uses satisfies the shape. */
export interface ApiHookDetectorContext {
  /** Container of in-scope api parameter names (e.g. `{"Sales",
   *  "Marketing"}`).  Populated by the UI walker from the page's
   *  `api X: Y` bindings. */
  apiParamNames: { has(name: string): boolean };
  /** Container of aggregate PascalCase names declared in the bound
   *  modules.  Patterns D / E (no api-param prefix) match against
   *  this set. */
  aggregatesByName: { has(name: string): boolean };
}

/** Returns a `DetectedApiCall` when `expr` matches one of the five
 *  api-call patterns, or `null` otherwise.  Cheap to call — bails on
 *  the first non-matching shape check. */
export function tryDetectApiHook(
  expr: ExprIR,
  ctx: ApiHookDetectorContext,
): DetectedApiCall | null {
  // Pattern A: member(member(ref:apiParam, agg), op)
  if (expr.kind === "member" && expr.receiver.kind === "member") {
    const inner = expr.receiver;
    if (inner.receiver.kind === "ref" && ctx.apiParamNames.has(inner.receiver.name)) {
      return { aggregateName: inner.member, operation: expr.member, args: [], kind: "aggregate" };
    }
  }
  // Pattern B: method-call(member(ref:apiParam, agg), op, args)
  if (expr.kind === "method-call" && expr.receiver.kind === "member") {
    const inner = expr.receiver;
    if (inner.receiver.kind === "ref" && ctx.apiParamNames.has(inner.receiver.name)) {
      return {
        aggregateName: inner.member,
        operation: expr.member,
        args: expr.args,
        kind: "aggregate",
      };
    }
  }
  // Pattern C: member(ref:"Views", viewName) — view hook.
  if (expr.kind === "member" && expr.receiver.kind === "ref" && expr.receiver.name === "Views") {
    return { aggregateName: expr.member, operation: expr.member, args: [], kind: "view" };
  }
  // Pattern D: member(ref:<Aggregate>, op) without api-param prefix.
  // Lets UIs without a `api X: Y` binding still get auto-injected
  // hooks (`scaffold modules: M` deployables that never declared
  // api params).
  if (
    expr.kind === "member" &&
    expr.receiver.kind === "ref" &&
    ctx.aggregatesByName.has(expr.receiver.name)
  ) {
    return {
      aggregateName: expr.receiver.name,
      operation: expr.member,
      args: [],
      kind: "aggregate",
    };
  }
  // Pattern E: method-call(ref:<Aggregate>, op, args) — parameterised
  // form of Pattern D.
  if (
    expr.kind === "method-call" &&
    expr.receiver.kind === "ref" &&
    ctx.aggregatesByName.has(expr.receiver.name)
  ) {
    return {
      aggregateName: expr.receiver.name,
      operation: expr.member,
      args: expr.args,
      kind: "aggregate",
    };
  }
  return null;
}
