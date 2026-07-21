import { setDeployableTargets } from "./deployable-bindings";
import { rebindReference } from "./rebind";

// ---------------------------------------------------------------------------
// Repointing a graph edge by dragging its target endpoint onto another node.
//
// Only edges that map to a single, unambiguous cross-reference are drag-
// rebindable: a repository's `for` aggregate, an api's `from` subdomain, and a
// deployable's `targets` deployable. The first two go through `rebindReference`
// (single token rewrite, parse-guarded); `targets` goes through
// `setDeployableTargets`, which reprints the
// Deployable from its AST — the deployable's `targets:` slot is a single ref
// that doesn't change the surrounding form. Multi-valued (deployable `contexts`
// / `serves`) and derived (`emits`) edges stay inspector-only, as does the
// form-sensitive deployable `ui` ref: `setDeployableUi` can convert between
// sugar / compose / block forms and so isn't a no-op surgical rewrite.
// ---------------------------------------------------------------------------

// `${ownerKind}:${label}` → the node kind the new target must be.
const REBINDABLE: Record<string, "aggregate" | "subdomain" | "deployable"> = {
  "repository:for": "aggregate",
  "api:from": "subdomain",
  "deployable:targets": "deployable",
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
  if (owner.kind === "deployable") {
    // `targets:` is single-ref; `setDeployableTargets` reprints the deployable
    // without touching the surrounding `modules:` / `serves:` / `ui:` slots.
    return setDeployableTargets(source, owner.name, target.name);
  }
  // owner.kind is "repository" | "api" — all RebindKind.
  return rebindReference(source, owner.kind as "repository" | "api", owner.name, target.name);
}
