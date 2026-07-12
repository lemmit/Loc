// ---------------------------------------------------------------------------
// Aggregate-set feature predicates — the "does any in-scope aggregate need
// feature X" booleans every backend orchestrator computes to presence-gate an
// emit (so a project without the feature stays byte-identical).  Each was
// hand-inlined per backend, verbatim apart from whether it iterates the merged
// context's aggregates (`merged.aggregates.some(...)`, dotnet/node/python) or
// the hosted contexts (`contexts.some((c) => c.aggregates.some(...))`,
// java/elixir) — both compute the same boolean, so the shared predicate takes
// the aggregate list and each caller keeps its own iteration shape.
//
// The leaf predicates (`aggregateIsVersioned`, `aggregateIsEventSourced`) live
// in sibling util modules; composing them once here keeps the "versioned OR
// event-sourced ⇒ concurrency" rule from drifting across five backends.
// ---------------------------------------------------------------------------

import type { AggregateIR } from "../types/loom-ir.js";
import { aggregateIsEventSourced } from "./resolve-datasource.js";
import { aggregateIsVersioned } from "./versioned-capability.js";

/** True when some aggregate needs the optimistic-concurrency (HTTP 409)
 *  machinery — it carries the `versioned` capability OR is event-sourced (an
 *  event-log append raises the same stale-write conflict on a
 *  `(stream_id, version)` collision).  Backends gate their concurrency error
 *  class + 409 arm on this; a project with neither stays byte-identical. */
export function aggregatesNeedConcurrency(aggregates: readonly AggregateIR[]): boolean {
  return aggregates.some((a) => aggregateIsVersioned(a) || aggregateIsEventSourced(a));
}

/** True when some aggregate declares a `unique` key — gates each backend's
 *  unique-violation (integrity → 409) handling. */
export function aggregatesHaveUniqueKeys(aggregates: readonly AggregateIR[]): boolean {
  return aggregates.some((a) => (a.uniqueKeys?.length ?? 0) > 0);
}
