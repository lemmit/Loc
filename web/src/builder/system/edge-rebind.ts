import { rebindReference } from "./rebind";

// ---------------------------------------------------------------------------
// Repointing a graph edge by dragging its target endpoint onto another node.
//
// Only edges that map to a single, unambiguous cross-reference are drag-
// rebindable: a repository's `for` aggregate, and a `from` source (a view's
// aggregate, an api's module). All three go through `rebindReference`, which
// rewrites just the reference token and is parse-guarded. Multi-valued
// (deployable `modules` / `serves`) and derived (`emits`) edges, and the
// form-sensitive deployable `targets` / `ui` refs, stay inspector-only.
// ---------------------------------------------------------------------------

// `${ownerKind}:${label}` → the node kind the new target must be. The owner
// kind disambiguates the shared `from` label (view vs api).
const REBINDABLE: Record<string, "aggregate" | "module"> = {
  "repository:for": "aggregate",
  "view:from": "aggregate",
  "api:from": "module",
};

function splitId(id: string): { kind: string; name: string } {
  const i = id.indexOf(":");
  return i < 0 ? { kind: id, name: "" } : { kind: id.slice(0, i), name: id.slice(i + 1) };
}

/** Whether an edge owned by `ownerKind` with this `label` can be drag-rebound. */
export function isRebindableEdge(ownerKind: string, label: string): boolean {
  return `${ownerKind}:${label}` in REBINDABLE;
}

/** Repoint a drag-rebindable edge to a new target node, returning the new
 *  source — or null if the edge isn't rebindable, the dropped-on node is the
 *  wrong kind, or the rewrite wouldn't parse. `ownerId` / `newTargetId` are
 *  graph node ids (`<kind>:<name>`); `label` is the edge label. */
export function rebindEdgeTarget(
  source: string,
  label: string,
  ownerId: string,
  newTargetId: string,
): string | null {
  const owner = splitId(ownerId);
  const expectedTargetKind = REBINDABLE[`${owner.kind}:${label}`];
  if (!expectedTargetKind) return null;
  const target = splitId(newTargetId);
  if (target.kind !== expectedTargetKind) return null;
  // owner.kind is "repository" | "view" | "api" — all RebindKind.
  return rebindReference(source, owner.kind as "repository" | "view" | "api", owner.name, target.name);
}
