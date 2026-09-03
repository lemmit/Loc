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

import { emitsRestDestroy } from "../enrich/wire-projection.js";
import type { AggregateIR, TypeIR } from "../types/loom-ir.js";
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

/** Peel `optional` / `array` wrappers off a field type. */
function unwrapType(t: TypeIR): TypeIR {
  let cur = t;
  while (cur.kind === "optional" || cur.kind === "array") {
    cur = cur.kind === "optional" ? cur.inner : cur.element;
  }
  return cur;
}

/** True when hard-deleting one of these aggregates can trip a Postgres
 *  `foreign_key_violation` (SQLSTATE 23503) — i.e. the project needs the
 *  still-referenced → `ReferencedInUse` (409 by default) arm.
 *
 *  A cross-aggregate `X id` field becomes a FK column with `ON DELETE RESTRICT`
 *  (`src/system/migrations-builder.ts`), so deleting a row another aggregate
 *  still points at fails at the database.  Every backend answers that with the
 *  resolved `ReferencedInUse` status instead of leaking a 500 — except java,
 *  which gated its whole `DataIntegrityViolationException` advice on
 *  `unique (...)` keys, so a model with a reference and no unique key answered
 *  500 where the other four answered 409.  This predicate is that arm's own
 *  gate; a project that can't trip 23503 stays byte-identical.
 *
 *  Both halves are required: something must be REST-deletable, and something
 *  must hold a reference to an in-scope aggregate. */
export function aggregatesCanTripReferencedDelete(aggregates: readonly AggregateIR[]): boolean {
  if (!aggregates.some((a) => emitsRestDestroy(a))) return false;
  const names = new Set(aggregates.map((a) => a.name));
  return aggregates.some((a) =>
    a.fields.some((f) => {
      const t = unwrapType(f.type);
      return t.kind === "id" && names.has(t.targetName);
    }),
  );
}
