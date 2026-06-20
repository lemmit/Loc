import type { Aggregate, BoundedContext, Expression } from "../../language/generated/ast.js";
import type { ContextStampIR, ExprIR } from "../types/loom-ir.js";
import { criterionRefOf, lowerExpr } from "./lower-expr.js";
import type { Env } from "./lower-types.js";

/** A lowered capability-filter predicate plus, when the source expression is
 *  *exactly* one named `criterion` reference, that reference (mirrors
 *  `FindIR.criterionRef`) — so reifying backends can call the criterion's
 *  module-level predicate fn instead of re-inlining its body. */
export interface FilterEntry {
  predicate: ExprIR;
  criterionRef?: { name: string; args: ExprIR[] };
}

function filterEntry(expr: Expression, env: Env): FilterEntry {
  return { predicate: lowerExpr(expr, env), criterionRef: criterionRefOf(expr, env) };
}

// ---------------------------------------------------------------------------
// Capability collection — reads structurally from `members[]` (no side
// tables).  Context-level capabilities, when present, are appended
// first.  Lowering is pure concatenation; the validator layer is
// responsible for any per-aggregate override semantics.
// ---------------------------------------------------------------------------

export interface ContextLevelCapabilities {
  /** Context-level filters — propagate to every aggregate in the context. */
  unqualifiedFilters: FilterEntry[];
  /** Context-level stamps — propagate to every aggregate in the context. */
  unqualifiedStamps: ContextStampIR[];
}

export const EMPTY_CONTEXT_CAPABILITIES: ContextLevelCapabilities = Object.freeze({
  unqualifiedFilters: [],
  unqualifiedStamps: [],
}) as ContextLevelCapabilities;

/** Scan a BoundedContext's members for FilterDecl/StampDecl nodes and lower
 * them in the context's env.  Context-level filters/stamps apply to every
 * aggregate inside (typed-capabilities Phase 6 removed the capability-scoped
 * `for "<name>"` qualifier — a capability co-locates its own filter/stamp).
 * Context-level `implements <Cap>` is applied by the expander (it splices the
 * capability into each aggregate), so there is nothing to lower here. */
export function collectContextLevelCapabilities(
  ctx: BoundedContext,
  env: Env,
): ContextLevelCapabilities {
  const unqualifiedFilters: FilterEntry[] = [];
  const unqualifiedStamps: ContextStampIR[] = [];
  for (const m of ctx.members ?? []) {
    if (m.$type === "FilterDecl") {
      unqualifiedFilters.push(filterEntry((m as { expr: Expression }).expr, env));
    } else if (m.$type === "StampDecl") {
      unqualifiedStamps.push(lowerStampDecl(m as unknown as StampDeclLike, env));
    }
  }
  return { unqualifiedFilters, unqualifiedStamps };
}

export function collectFilters(
  agg: Aggregate,
  env: Env,
  ctxCaps: ContextLevelCapabilities,
): FilterEntry[] {
  const own = (agg.members ?? [])
    .filter((m) => m.$type === "FilterDecl")
    .map((m) => filterEntry((m as { expr: Expression }).expr, env));
  return [...ctxCaps.unqualifiedFilters, ...own];
}

export function collectStamps(
  agg: Aggregate,
  env: Env,
  ctxCaps: ContextLevelCapabilities,
): ContextStampIR[] {
  const own = (agg.members ?? [])
    .filter((m) => m.$type === "StampDecl")
    .map((m) => lowerStampDecl(m as unknown as StampDeclLike, env));
  return [...ctxCaps.unqualifiedStamps, ...own];
}

/** Shape we rely on from a `StampDecl` AST node.  Local alias so the
 * import surface stays narrow. */
interface StampDeclLike {
  event: "onCreate" | "onUpdate";
  assignments: Array<{ target: { head: string }; value?: Expression }>;
}

function lowerStampDecl(s: StampDeclLike, env: Env): ContextStampIR {
  // The grammar's `stamp <event> { <assign>* }` produces a sequence
  // of `AssignOrCallStmt` nodes whose LValue is a single-segment
  // path (the target field name) and whose value is the assigned
  // expression.  Both sides are lowered through the existing
  // operation-body pipeline.  Stamps with chained / multi-segment
  // targets (`this.foo.bar`) are flagged by the validator.
  return {
    event: s.event === "onCreate" ? "create" : "update",
    assignments: s.assignments.map((a) => ({
      field: a.target.head,
      value: a.value ? lowerExpr(a.value, env) : (lowerExpr(undefined, env) as never),
    })),
  };
}
