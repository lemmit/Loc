// Shared REST-surface predicates for the vanilla Phoenix backend.
//
// These answer "does this aggregate expose a given generic REST verb" and are
// consumed across the four seams that must agree on it — the router
// (`api-emit.ts`), the controller action (`api-emit.ts`), the context
// `<verb>_<agg>` defdelegate (`context-emit.ts`), and the repository function
// (`repository-emit.ts`).  Deriving the answer ONCE here (rather than inlining
// it per seam) is what keeps the four in lock-step: the class of bug where the
// route was gated but the seam it drives was emitted unconditionally, leaving
// dead code the router never reaches.
//
// Lives in its own module (not in `api-emit.ts` alongside `emitsRestCreate`)
// because `api-emit.ts` imports from `context-emit.ts`, so a predicate the
// context also needs cannot live there without a cycle.  This module depends
// only on the leaf `isAbstractBase` / `isEventSourced` predicates.

import type { AggregateIR } from "../../../ir/types/loom-ir.js";
import { isEventSourced } from "./eventsourced-emit.js";
import { isAbstractBase } from "./inheritance-emit.js";

/**
 * Whether the vanilla Phoenix backend exposes a REST delete surface — the
 * `DELETE /<plural>/:id` route AND the CRUD `delete` seam it drives (the
 * controller `delete` action, the context `delete_<agg>` defdelegate, and the
 * repository `delete/1`) — for this aggregate.  Consumed by the router, the
 * controller, the context, and the repository so the four can never disagree:
 * without this gate the seam was emitted UNconditionally while the router gated
 * the route, so an aggregate with no reachable destroy (e.g. `with softDeletable`
 * and no `destroy`) shipped a dead hard-`Repo.delete` with no route to reach it
 * (audit `generated-code-ddd-review-2026-07.md`: "The dead hard-`delete` on the
 * Phoenix repository is an emitter defect").
 *
 * A destroy exists iff the aggregate declares one (`with crudish` supplies it;
 * an explicit `destroy` op too).  Event-sourced aggregates have no generic
 * delete surface (their only mutations are per-op commands), and an abstract
 * inheritance base is read-only — neither exposes delete.  The `destroy_<agg>!`
 * LiveView bang seam is a SEPARATE path gated on the same destroy presence
 * (`context-emit.ts`), so a `DestroyForm` still works.
 */
export function emitsRestDelete(agg: AggregateIR): boolean {
  if (isAbstractBase(agg)) return false;
  return !isEventSourced(agg) && (agg.destroys ?? []).length > 0;
}
