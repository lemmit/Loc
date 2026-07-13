import type { AggregateIR, EntityPartIR } from "../types/loom-ir.js";

/** The entity that directly declares a part as a containment. */
export interface DirectParent {
  /** The declaring entity's name — the aggregate root for a root-level part,
   *  or a sibling part for a nested (part-in-part) one. */
  readonly name: string;
  /** True when the declaring containment is single (non-collection) — drives a
   *  `UNIQUE` on the child's parent FK in the target storage model. */
  readonly single: boolean;
  /** True when the declaring entity is a NESTED part (not the aggregate root) —
   *  the case whose storage FK must target a sibling part's table rather than
   *  the root's (the whole point of resolving the direct parent). */
  readonly nested: boolean;
}

/** Resolve the entity that directly contains `partName` — the aggregate root for
 *  a root-level part, or the sibling part for a nested one — together with
 *  whether that containment is single.  A part is contained exactly once (the
 *  containment graph is a tree), so the answer is unambiguous; `undefined` only
 *  when `partName` is not contained anywhere in this aggregate.
 *
 *  This is the single source of truth for "which table does a part's row hang
 *  off?" — the storage model FKs every part to its DIRECT parent (not the
 *  aggregate root), so a deeply-nested collection keeps its hierarchy instead of
 *  flattening every level onto the root (which is lossy for a collection nested
 *  below the root).  Root-level parts resolve to the root, so existing
 *  single-level output is unchanged. */
export function directParentOf(agg: AggregateIR, partName: string): DirectParent | undefined {
  const fromRoot = agg.contains.find((c) => c.partName === partName);
  if (fromRoot) return { name: agg.name, single: !fromRoot.collection, nested: false };
  for (const part of agg.parts) {
    const c = part.contains.find((x) => x.partName === partName);
    if (c) return { name: part.name, single: !c.collection, nested: true };
  }
  return undefined;
}

/** The entity name a part's storage row FKs to — its direct parent when the
 *  part is nested (a sibling part's table), else `defaultOwner` (the aggregate
 *  root, or the TPH base table when the caller passes it).  This is the single
 *  rule the shared migration (`migrations-builder.ts` `tableForPart`) applies
 *  as `dp?.nested ? dp.name : ownerName`; a per-backend ORM emitter calls this
 *  so its own FK column (`<name>_id`) lines up with the migration DDL by
 *  construction.  A root-level part resolves to `defaultOwner`, so existing
 *  single-level output is unchanged. */
export function directParentName(agg: AggregateIR, partName: string, defaultOwner: string): string {
  const dp = directParentOf(agg, partName);
  return dp?.nested ? dp.name : defaultOwner;
}

/** Order parts so a CONTAINED part precedes the part that contains it — a
 *  STABLE topological sort (declaration order preserved among parts with no
 *  containment dependency between them).  An emitter that renders one
 *  class/model per part into a single module uses this so a part-in-part type
 *  reference (`Shipment.labels: list[Label]`) never forward-references a
 *  not-yet-defined sibling.  For an aggregate with no part-in-part nesting the
 *  result equals the input order, so single-level output is byte-identical. */
export function partsChildrenFirst<P extends EntityPartIR>(parts: readonly P[]): P[] {
  const byName = new Map(parts.map((p) => [p.name, p]));
  const out: P[] = [];
  const seen = new Set<string>();
  const visit = (p: P): void => {
    if (seen.has(p.name)) return;
    seen.add(p.name);
    for (const c of p.contains) {
      const child = byName.get(c.partName);
      if (child) visit(child);
    }
    out.push(p);
  };
  for (const p of parts) visit(p);
  return out;
}
