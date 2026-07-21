// ---------------------------------------------------------------------------
// API-hook detection — framework-agnostic IR pattern matching.
//
// Recognises the DSL shapes that lower into an api call:
//
//   Pattern A: `member(member(ref:apiParam, agg), op)`           — `Sales.Customer.all`
//   Pattern B: `method-call(member(ref:apiParam, agg), op, args)` — `Sales.Customer.byId(id)`
//   Pattern D: `member(ref:<Aggregate>, op)`                      — `Customer.create`   (no api-param prefix)
//   Pattern E: `method-call(ref:<Aggregate>, op, args)`           — `Customer.byId(id)` (no api-param prefix)
//   Pattern F: `member(member(ref:<Workflow>, "instances"), "all")`        — `Fulfillment.instances.all`
//   Pattern G: `method-call(member(ref:<Workflow>, "instances"), "byId", args)` — `Fulfillment.instances.byId(id)`
//
// Detection is PURE IR analysis — no framework assumptions, no
// emission.  Splitting it out of `react/walker/api-hooks.ts` (where it
// previously lived) lets a future Vue/Svelte/Blazor walker reuse the
// detector verbatim and plug in its own naming via the WalkerTarget's
// `buildHookUse` method.
//
// The returned `DetectedApiCall` carries everything the framework-
// specific naming layer needs: which aggregate is invoked,
// which operation, and the raw arg expressions (caller renders them
// via its walker context for ref-propagation side-effects).
// ---------------------------------------------------------------------------

import type { ExprIR } from "../../ir/types/loom-ir.js";

/** A framework-agnostic detected api call.  Produced by
 *  `tryDetectApiHook` from an `ExprIR` that matches one of the
 *  documented patterns; consumed by `WalkerTarget.buildHookUse` to
 *  produce the per-framework hook naming (var, hook fn, import path). */
export interface DetectedApiCall {
  /** The aggregate PascalCase name (Patterns A/B/D/E), or the workflow
   *  name for workflow-instance hooks (Patterns F/G).  Disambiguated
   *  by `kind`. */
  aggregateName: string;
  /** The operation invoked off the aggregate.  Standard
   *  operations: `all`, `byId`, `create`, `update`, `delete`, plus
   *  user-declared finder / operation names. */
  operation: string;
  /** Argument expressions in source order.  Empty for `.all`-style
   *  reads.  Caller renders via its own
   *  walker context so refs to params/state propagate. */
  args: ExprIR[];
  /** Discriminator between the pipelines:
   *    `"aggregate"`         — Patterns A/B/D/E (aggregate-rooted hook)
   *    `"workflow-instance"` — Patterns F/G (`<Workflow>.instances.all` /
   *                            `.byId(id)`); `aggregateName` carries the
   *                            workflow name, `operation` is `all`/`byId`. */
  kind: "aggregate" | "workflow-instance";
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
  /** Container of workflow names declared in the bound modules.
   *  Patterns F / G (`<Workflow>.instances.…`) match against this set.
   *  Optional so callers that never reference workflow instances need
   *  not supply it. */
  workflowsByName?: { has(name: string): boolean };
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
  // Pattern F: member(member(ref:<Workflow>, "instances"), "all") — workflow
  // instance list (workflow-instance-visibility.md).
  if (
    expr.kind === "member" &&
    expr.member === "all" &&
    expr.receiver.kind === "member" &&
    expr.receiver.member === "instances" &&
    expr.receiver.receiver.kind === "ref" &&
    ctx.workflowsByName?.has(expr.receiver.receiver.name)
  ) {
    return {
      aggregateName: expr.receiver.receiver.name,
      operation: "all",
      args: [],
      kind: "workflow-instance",
    };
  }
  // Pattern G: method-call(member(ref:<Workflow>, "instances"), "byId", args)
  // — one workflow instance by correlation id.
  if (
    expr.kind === "method-call" &&
    expr.member === "byId" &&
    expr.receiver.kind === "member" &&
    expr.receiver.member === "instances" &&
    expr.receiver.receiver.kind === "ref" &&
    ctx.workflowsByName?.has(expr.receiver.receiver.name)
  ) {
    return {
      aggregateName: expr.receiver.receiver.name,
      operation: "byId",
      args: expr.args,
      kind: "workflow-instance",
    };
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
