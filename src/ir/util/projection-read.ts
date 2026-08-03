// ---------------------------------------------------------------------------
// Which projections a FRONTEND can read (M-T1.3 Phase 1).
//
// One predicate, imported by all three parties that must agree about it:
//
//   - the client emitter   (`_frontend/projections-module.ts`) — what to emit
//   - the walker's detector (`_walker/walker-core.ts`)          — what resolves
//   - the validator gate   (`validate/checks/ui-checks.ts`)     — what to reject
//
// They are deliberately not allowed to hold three copies of this rule.  A
// three-way disagreement is precisely the defect this closes: a page reading a
// projection validated clean, resolved to nothing, and emitted
// `/* unresolved: Sales */ undefined.<Projection>` — a runtime TypeError and a
// build break, from a model with no diagnostic at all.
//
// Lives at the IR layer because the fact is an IR fact (clause presence), and
// because a `generator → ir` import is with the pipeline while the reverse
// would not be.  Sibling of `repo-read.ts`, which plays the same
// single-detector role for repository reads.
// ---------------------------------------------------------------------------

import type { BoundedContextIR, ProjectionIR } from "../types/loom-ir.js";
import {
  isGroupedProjection,
  isQueryTimeProjection,
  isSingletonProjection,
} from "../types/loom-ir.js";

/** True when a frontend can read this projection today.
 *
 *  Two conditions, both structural:
 *
 *    QUERY-TIME — computed per read, so the backend serves it on a route.  A
 *      folded projection is materialized into a `<Proj>Row` table and read by
 *      key; that is a different route shape and a different binding.
 *    SINGLETON  — unkeyed, so the response has ONE shape per read: one object
 *      for the whole-table aggregation (the dashboard KPI `QueryView`'s
 *      single-record mode binds), or the LIST shape for a `group by`
 *      projection (one row per group — the `Chart`/`Table`-shaped binding,
 *      M-T1.3 Phase 4; `projectionReadShape` tells the two apart).  A keyed
 *      projection returns an array parameterised by key and stays out.
 *
 *  All narrowings are honest gaps, not oversights — each is reported by
 *  `loom.ui-projection-read-unsupported` rather than mis-emitted. */
export function isFrontendReadableProjection(p: ProjectionIR): boolean {
  return isQueryTimeProjection(p) && isSingletonProjection(p);
}

/** The RESPONSE SHAPE a frontend read of this projection yields — `"one"`
 *  object for the whole-table aggregation, `"many"` rows (a JSON array) for a
 *  `group by` projection.  The client emitter, the walker's query-shape
 *  derivation, and the validator all key their list-vs-object handling on this
 *  one answer, same single-detector discipline as the readability predicate. */
export function projectionReadShape(p: ProjectionIR): "one" | "many" {
  return isGroupedProjection(p) ? "many" : "one";
}

/** Names of every frontend-readable projection across the given contexts. */
export function readableProjectionNames(contexts: Iterable<BoundedContextIR>): ReadonlySet<string> {
  const names = new Set<string>();
  for (const ctx of contexts) {
    for (const p of ctx.projections ?? []) {
      if (isFrontendReadableProjection(p)) names.add(p.name);
    }
  }
  return names;
}

/** Names of every frontend-readable GROUPED projection (the `"many"` shape)
 *  across the given contexts.  The `Chart` primitive's `of:` domain, and the
 *  walker's list-vs-single discriminator for a projection read. */
export function groupedProjectionNames(contexts: Iterable<BoundedContextIR>): ReadonlySet<string> {
  const names = new Set<string>();
  for (const ctx of contexts) {
    for (const p of ctx.projections ?? []) {
      if (isFrontendReadableProjection(p) && isGroupedProjection(p)) names.add(p.name);
    }
  }
  return names;
}
