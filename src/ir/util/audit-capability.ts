// -------------------------------------------------------------------------
// Shared "does this aggregate / context carry an audit target?" predicate.
//
// An aggregate is an audit target when ANY of its public command actions —
// `operation … audited`, `create(...) audited`, or `destroy audited` — opts
// into per-action audit-record emission.  Backends gate three things on this:
//
//   1. emitting the `audit_records` table DDL (`emit.ts` schema gate),
//   2. importing the audit-record schema into a route file,
//   3. instrumenting the matching route handler with the insert.
//
// It lives at IR level (`ir/util/`) so the validator and every backend can
// import it DOWN the pipeline — never re-deriving the gate per-backend, which
// is how the pre-#1503 code drifted (each backend scanned only `agg.operations`
// and so silently dropped audited creates/destroys).  A new backend porting
// audited lifecycle adopts this predicate rather than re-scanning.
//
// Platform-neutral and browser-safe — pure structural reads off the resolved
// IR, no Node-only APIs.
// -------------------------------------------------------------------------
import type { AggregateIR, BoundedContextIR, OperationIR } from "../types/loom-ir.js";

/** All audit-target command actions of an aggregate: audited operations ∪
 *  audited creates ∪ audited destroys.  Order is operations, then creates,
 *  then destroys (stable, for deterministic emission). */
export function auditedTargets(agg: AggregateIR): OperationIR[] {
  return [...agg.operations, ...(agg.creates ?? []), ...(agg.destroys ?? [])].filter(
    (o) => o.audited,
  );
}

/** True when the aggregate has at least one audited command action
 *  (operation, create, or destroy). */
export function aggHasAuditedTarget(agg: AggregateIR): boolean {
  if (agg.operations.some((o) => o.audited)) return true;
  if ((agg.creates ?? []).some((o) => o.audited)) return true;
  if ((agg.destroys ?? []).some((o) => o.audited)) return true;
  return false;
}

/** True when any aggregate in the context has an audited command action. */
export function contextHasAuditedTarget(ctx: BoundedContextIR): boolean {
  return ctx.aggregates.some(aggHasAuditedTarget);
}
