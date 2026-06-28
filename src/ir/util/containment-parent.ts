import type { AggregateIR } from "../types/loom-ir.js";

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
