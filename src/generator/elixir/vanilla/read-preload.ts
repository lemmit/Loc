// Shared read-path preload list for the vanilla Phoenix backend.
//
// A read that returns aggregate STRUCTS and then projects them through the
// canonical `wireShape` serializer must `Repo.preload(...)` every collection
// association the serializer touches — a `has_many` / `many_to_many` left
// unloaded comes back as `%Ecto.Association.NotLoaded{}`, which the serializer
// then either `Enum.map`s over (→ `Protocol.UndefinedError`) or hands to Jason
// (→ `Jason.EncodeError`); either way a 500.
//
// The REST repository read (`repository-emit.ts`) and the query-time projection
// read (`query-projections-emit.ts`) both serialise structs through the same
// wireShape, so both need the SAME preload list.  Deriving it here once keeps
// them in lock-step: without it the repository read preloaded and the projection
// read did not, so a projection over an aggregate with a value-object
// collection / relational containment crashed at runtime (audit
// `generated-code-ddd-review-2026-07.md`: "a `NotLoaded` Jason crash on the
// no-preload projection read").

import type { AggregateIR, BoundedContextIR, SystemIR } from "../../../ir/types/loom-ir.js";
import { snake } from "../../../util/naming.js";
import { preloadList } from "./ref-collection-emit.js";
import { usesRelationalContainments } from "./schema-emit.js";
import { valueCollectionsWithVo } from "./value-collection-schema-emit.js";

/**
 * The association atoms a struct-returning read must `Repo.preload(...)` so the
 * wireShape serializer materialises every collection wire field:
 *
 *   - value-object collections (`charges: Money[]`) — `has_many` child tables,
 *   - relational entity-part containments (`contains lines: Line[]`, §11c) —
 *     `has_many`/`has_one` child tables (embedded containments fold into the
 *     jsonb column and load with the row, so they contribute nothing),
 *   - reference collections (`X id[]`) — `many_to_many` join rows.
 *
 * Order is value-collections → containments → ref-colls, matching the repository
 * read's `preloadRels` exactly (byte-identical output on that path).  `ctx`/`sys`
 * are optional because the repository renderer admits an aggregate-only call; a
 * missing `ctx` yields no value-collections, and a missing `sys` classifies
 * containments by the default saving shape (as `usesRelationalContainments`).
 */
export function readPreloadRels(
  agg: AggregateIR,
  ctx: BoundedContextIR | undefined,
  sys?: SystemIR,
): string[] {
  const valueCollectionRels = ctx
    ? valueCollectionsWithVo(agg, ctx).map((v) => `:${snake(v.vc.fieldName)}`)
    : [];
  const containmentRels =
    ctx && usesRelationalContainments(agg, ctx, sys)
      ? agg.contains.map((c) => `:${snake(c.name)}`)
      : [];
  return [...valueCollectionRels, ...containmentRels, ...preloadList(agg)];
}
