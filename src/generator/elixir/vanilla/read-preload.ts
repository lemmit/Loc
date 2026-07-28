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

import type {
  AggregateIR,
  BoundedContextIR,
  ContainmentIR,
  EntityPartIR,
  SystemIR,
} from "../../../ir/types/loom-ir.js";
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
  const { flat, nested } = containmentPreloadRels(agg, ctx, sys);
  return [
    ...valueCollectionRels,
    ...flat,
    ...preloadList(agg),
    // Keyword (nested) entries LAST — `[:a, b: :c]` parses, `[b: :c, :a]` does not.
    ...nested,
  ];
}

/** The relational-containment preload terms, SPLIT into plain-`:atom` entries
 *  (a leaf containment: `:lines`) and keyword entries whose contained part has
 *  its OWN containments (part-in-part: `lines: :tags`).  Ecto requires keyword
 *  entries to trail the atoms in a list literal (`[:a, b: :c]` parses,
 *  `[b: :c, :a]` does not), so callers splice `nested` after their atoms.  A
 *  nested `has_many` left unpreloaded serialises as `NotLoaded` (a 500), and the
 *  update path needs the prior nested rows loaded for `cast_assoc` to diff. */
export function containmentPreloadRels(
  agg: AggregateIR,
  ctx: BoundedContextIR | undefined,
  sys?: SystemIR,
): { flat: string[]; nested: string[] } {
  if (!ctx || !usesRelationalContainments(agg, ctx, sys)) return { flat: [], nested: [] };
  const partsByName = new Map((agg.parts ?? []).map((p) => [p.name, p]));
  const flat: string[] = [];
  const nested: string[] = [];
  for (const c of agg.contains) {
    const term = nestedPreloadOf(c, partsByName);
    if (term) nested.push(`${snake(c.name)}: ${term}`);
    else flat.push(`:${snake(c.name)}`);
  }
  return { flat, nested };
}

/** The nested-preload term for a containment whose contained part ITSELF has
 *  relational containments — `:tags` for one child, `[:tags, :labels]` for
 *  several, recursing (`[items: :notes]`) for deeper nesting.  `undefined` when
 *  the contained part is a leaf (no further containments to preload). */
function nestedPreloadOf(
  c: ContainmentIR,
  partsByName: Map<string, EntityPartIR>,
): string | undefined {
  const part = partsByName.get(c.partName);
  const children = part?.contains ?? [];
  if (children.length === 0) return undefined;
  const terms = children.map((cc) => {
    const deeper = nestedPreloadOf(cc, partsByName);
    return deeper ? `[${snake(cc.name)}: ${deeper}]` : `:${snake(cc.name)}`;
  });
  return terms.length === 1 ? terms[0]! : `[${terms.join(", ")}]`;
}
