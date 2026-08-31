// ---------------------------------------------------------------------------
// Which projections a FRONTEND can read.
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
  isShorthandProjection,
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
 *      `projectionReadShape` tells the two apart).  A keyed
 *      projection returns an array parameterised by key and stays out.
 *
 *  All narrowings are honest gaps, not oversights — each is reported by
 *  `loom.ui-projection-read-unsupported` rather than mis-emitted. */
export function isFrontendReadableProjection(p: ProjectionIR): boolean {
  return isQueryTimeProjection(p) && isSingletonProjection(p);
}

/** The RESPONSE SHAPE a frontend read of this projection yields — `"one"`
 *  object, or `"many"` rows (a JSON array).  The client emitter, the walker's
 *  query-shape derivation, and the validator all key their list-vs-object
 *  handling on this one answer, same single-detector discipline as the
 *  readability predicate.
 *
 *  Exactly ONE readable form yields a single object: the whole-table
 *  aggregation, which collapses the source table to one row by construction.
 *  Both of the others return an array —
 *
 *    - a `group by` projection: one row per distinct group;
 *    - a SHORTHAND projection (`projection P { from A as a where … }`, no
 *      declared fields, no `select`): the filtered SOURCE ROWS themselves.
 *
 *  The shorthand arm is the easy one to get wrong, invisibly:
 *  `isSingletonProjection` answers "unkeyed", which a shorthand read is, so
 *  deciding the shape from `isGroupedProjection` alone emits a `z.object`
 *  client for a route that returns an array — a `.parse` that throws on the
 *  first load, from a model with no diagnostic at all.  Ask "is it the
 *  whole-table aggregation", not "is it grouped". */
export function projectionReadShape(p: ProjectionIR): "one" | "many" {
  return isGroupedProjection(p) || isShorthandProjection(p) ? "many" : "one";
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

/** Names of every frontend-readable GROUPED projection across the given
 *  contexts — the `Chart` primitive's `of:` domain.  Narrower than
 *  `listShapedProjectionNames`: a chart plots aggregates PER GROUP, which a
 *  shorthand row dump is not, even though both ride the wire as an array. */
export function groupedProjectionNames(contexts: Iterable<BoundedContextIR>): ReadonlySet<string> {
  const names = new Set<string>();
  for (const ctx of contexts) {
    for (const p of ctx.projections ?? []) {
      if (isFrontendReadableProjection(p) && isGroupedProjection(p)) names.add(p.name);
    }
  }
  return names;
}

/** Names of every frontend-readable projection whose response is the LIST shape
 *  (`projectionReadShape === "many"`).  The walker's list-vs-single
 *  discriminator for a projection read, and the client emitter's `z.array`
 *  wrap — both must ask the SHAPE question, not the grouping one. */
export function listShapedProjectionNames(
  contexts: Iterable<BoundedContextIR>,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const ctx of contexts) {
    for (const p of ctx.projections ?? []) {
      if (isFrontendReadableProjection(p) && projectionReadShape(p) === "many") names.add(p.name);
    }
  }
  return names;
}
