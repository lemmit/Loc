import type { Aggregate, BoundedContext, Expression } from "../../language/generated/ast.js";
import type { ContextStampIR, ExprIR } from "../types/loom-ir.js";
import { lowerExpr } from "./lower-expr.js";
import type { Env } from "./lower-types.js";

// ---------------------------------------------------------------------------
// Capability collection — reads structurally from `members[]` (no side
// tables).  Context-level capabilities, when present, are appended
// first.  Lowering is pure concatenation; the validator layer is
// responsible for any per-aggregate override semantics.
// ---------------------------------------------------------------------------

export interface ContextLevelCapabilities {
  /** Unqualified filters — propagate to every aggregate in the
   * context, regardless of `implements`. */
  unqualifiedFilters: ExprIR[];
  /** Capability-qualified filters — propagate only to aggregates
   * whose `implementsCapabilities` includes the matching name. */
  qualifiedFilters: Array<{ capability: string; predicate: ExprIR }>;
  /** Unqualified stamps — propagate to every aggregate. */
  unqualifiedStamps: ContextStampIR[];
  /** Capability-qualified stamps — propagate only to opt-ins. */
  qualifiedStamps: Array<{ capability: string; stamp: ContextStampIR }>;
  /** `implements` declarations at context level propagate to every
   * aggregate's `implementsCapabilities` (today; "for" qualifier on
   * implements is intentionally not supported — implements IS the
   * opt-in mechanism, qualifying it would be redundant). */
  implementsCaps: string[];
}

export const EMPTY_CONTEXT_CAPABILITIES: ContextLevelCapabilities = Object.freeze({
  unqualifiedFilters: [],
  qualifiedFilters: [],
  unqualifiedStamps: [],
  qualifiedStamps: [],
  implementsCaps: [],
}) as ContextLevelCapabilities;

/** Scan a BoundedContext's members for FilterDecl/StampDecl/
 * ImplementsDecl nodes, lower them in the context's env, and
 * partition by qualifier.  Unqualified context-level decls apply to
 * every aggregate inside; qualified (`for "<name>"`) decls apply
 * only to aggregates whose `implements` matches. */
export function collectContextLevelCapabilities(
  ctx: BoundedContext,
  env: Env,
): ContextLevelCapabilities {
  const unqualifiedFilters: ExprIR[] = [];
  const qualifiedFilters: Array<{ capability: string; predicate: ExprIR }> = [];
  const unqualifiedStamps: ContextStampIR[] = [];
  const qualifiedStamps: Array<{ capability: string; stamp: ContextStampIR }> = [];
  const implementsCaps: string[] = [];
  for (const m of ctx.members ?? []) {
    if (m.$type === "FilterDecl") {
      const f = m as { expr: Expression; capability?: string };
      const predicate = lowerExpr(f.expr, env);
      if (f.capability) {
        qualifiedFilters.push({ capability: f.capability, predicate });
      } else {
        unqualifiedFilters.push(predicate);
      }
    } else if (m.$type === "StampDecl") {
      const s = m as unknown as StampDeclLike & { capability?: string };
      const lowered = lowerStampDecl(s, env);
      if (s.capability) {
        qualifiedStamps.push({ capability: s.capability, stamp: lowered });
      } else {
        unqualifiedStamps.push(lowered);
      }
    } else if (m.$type === "ImplementsDecl") {
      implementsCaps.push((m as { name: string }).name);
    }
  }
  return {
    unqualifiedFilters,
    qualifiedFilters,
    unqualifiedStamps,
    qualifiedStamps,
    implementsCaps,
  };
}

export function collectFilters(
  agg: Aggregate,
  env: Env,
  ctxCaps: ContextLevelCapabilities,
  aggImplementsCaps: readonly string[],
): ExprIR[] {
  const own = (agg.members ?? [])
    .filter((m) => m.$type === "FilterDecl")
    .map((m) => lowerExpr((m as { expr: Expression }).expr, env));
  // Qualified context filters propagate only to aggregates whose
  // implements set includes the qualifier name.
  const matchingQualified = ctxCaps.qualifiedFilters
    .filter((q) => aggImplementsCaps.includes(q.capability))
    .map((q) => q.predicate);
  return [...ctxCaps.unqualifiedFilters, ...matchingQualified, ...own];
}

export function collectStamps(
  agg: Aggregate,
  env: Env,
  ctxCaps: ContextLevelCapabilities,
  aggImplementsCaps: readonly string[],
): ContextStampIR[] {
  const own = (agg.members ?? [])
    .filter((m) => m.$type === "StampDecl")
    .map((m) => lowerStampDecl(m as unknown as StampDeclLike, env));
  const matchingQualified = ctxCaps.qualifiedStamps
    .filter((q) => aggImplementsCaps.includes(q.capability))
    .map((q) => q.stamp);
  return [...ctxCaps.unqualifiedStamps, ...matchingQualified, ...own];
}

export function collectImplements(agg: Aggregate, propagated: readonly string[]): string[] {
  const own = (agg.members ?? [])
    .filter((m) => m.$type === "ImplementsDecl")
    .map((m) => (m as { name: string }).name);
  // Dedupe + sort so generators get a deterministic order regardless
  // of declaration source (context vs aggregate vs macro emission).
  return [...new Set([...propagated, ...own])].sort();
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
