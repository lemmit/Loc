// WHICH context function an Elixir caller targets for a canonical `create` /
// `destroy` — the one place that decision is spelled, because getting it wrong in
// either direction is a security or a correctness bug.
//
// This backend gates the lifecycle `requires` in the CONTEXT rather than at the
// route (see the header note in `vanilla/context-emit.ts`): Phoenix is the only
// backend whose frontend runs in-process, so the scaffolded LiveView calls
// `<Ctx>.create_<agg>` directly and a controller-level gate has a second front
// door.  That placement is right for REQUEST-side callers and wrong for
// IN-PROCESS ones, which is the divergence this module resolves.
//
// THE TWO KINDS OF CALLER.  A workflow's `factory-let` step, an event
// dispatcher, and the emitted integration tests all create aggregates in-process
// with no request and no principal.  Every other backend's workflow body calls
// the domain factory directly, so it is not subject to the aggregate's create
// gate at all; if Elixir alone routed those through the guarded seam, a nil
// principal would DENY (or MatchError) a workflow whose own caller does hold the
// permission — the same `.ddd` answering 200 on four backends and 403/500 on one.
//
// SO THE SEAM SPLITS, and the naming is the safety property:
//
//   create_<agg>/2            GUARDED.  Keeps the plain name, so a caller that
//                             guesses the obvious one gets the gate — the
//                             request-side doors (controller, LiveView form,
//                             DestroyForm) need no special knowledge.
//   create_<agg>_unguarded/1  the internal entry.  Bypassing authorization is
//                             something a call site has to SAY, in a word that
//                             shows up in review.
//
// Emitted only when the action is actually guarded; an ungated aggregate keeps
// its single `defdelegate` and every call site stays byte-identical.
//
// Why not thread the principal into the workflow call instead: a workflow's
// authorization is its OWN `requires` gate, evaluated where the request is.
// Re-checking the aggregate's create gate underneath it would make Elixir
// enforce a rule the other four do not, and would fail closed for every
// principal-less internal caller (a timer, a seed, a saga) — the exact
// "uncallable from a saga without fabricating a principal" failure `op-gates.ts`
// exists to avoid.

import type { AggregateIR } from "../../ir/types/loom-ir.js";
import { lifecycleGates } from "../../ir/util/op-gates.js";
import { snake } from "../../util/naming.js";

/** Suffix that marks the authorization-free internal entry. */
const UNGUARDED = "_unguarded";

/** True when the aggregate's canonical `create` carries a `requires` gate, so the
 *  context emits the guarded/`_unguarded` pair rather than one delegate. */
export function createIsGuarded(agg: AggregateIR | undefined): boolean {
  return lifecycleGates(agg?.canonicalCreate).length > 0;
}

/** True when the aggregate's canonical `destroy` carries a `requires` gate. */
export function destroyIsGuarded(agg: AggregateIR | undefined): boolean {
  return lifecycleGates(agg?.canonicalDestroy).length > 0;
}

/** The context function an IN-PROCESS caller (workflow step, event dispatch,
 *  emitted integration test) uses to create `aggName`.  Falls back to the plain
 *  name when the create is ungated — there is no second function then. */
export function internalCreateFn(aggName: string, agg: AggregateIR | undefined): string {
  return `create_${snake(aggName)}${createIsGuarded(agg) ? UNGUARDED : ""}`;
}

/** The `delete_<agg>` twin of {@link internalCreateFn} — a workflow `destroy`
 *  step deletes a row it already holds, with no request principal to gate on. */
export function internalDeleteFn(aggName: string, agg: AggregateIR | undefined): string {
  return `delete_${snake(aggName)}${destroyIsGuarded(agg) ? UNGUARDED : ""}`;
}

/** The unguarded entry's name, for the context emitter that declares it. */
export function unguardedName(verb: "create" | "delete", aggName: string): string {
  return `${verb}_${snake(aggName)}${UNGUARDED}`;
}
