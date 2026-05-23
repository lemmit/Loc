// Repointing a deployable binding by dragging its edge endpoint in the v2
// system view.
//
// `targets` and `ui` are single, unambiguous cross-refs — safe to repoint by
// drag through v1's `setDeployableTargets` / `setDeployableUi`. (`ui` is only
// included by `view-graph` when the deployable uses the sugar form via
// `deployableUi`, so we never end up coercing a compose/block form.) The
// multi-valued bindings (`modules` / `serves`) stay non-drag — they need a
// multi-select UI, which is a separate Phase 4d UI concern.

import { setDeployableTargets, setDeployableUi } from "../system/deployable-bindings";

function splitId(id: string): { kind: string; name: string } {
  const i = id.indexOf(":");
  return i < 0 ? { kind: id, name: "" } : { kind: id.slice(0, i), name: id.slice(i + 1) };
}

/** Whether the system-view edge with this label can be repointed by dragging
 *  its target endpoint to another node. */
export function isRebindableDeployableEdge(label: string): boolean {
  return label === "targets" || label === "ui";
}

/** Repoint a deployable binding edge to a new target, returning the new source
 *  or null when the edge isn't rebindable, the drop landed on the wrong kind,
 *  or the rewrite wouldn't parse. */
export function rebindDeployableEdgeTarget(
  source: string,
  label: string,
  ownerId: string,
  newTargetId: string,
): string | null {
  const owner = splitId(ownerId);
  if (owner.kind !== "deployable") return null;
  const target = splitId(newTargetId);
  if (label === "targets" && target.kind === "deployable" && target.name !== owner.name) {
    return setDeployableTargets(source, owner.name, target.name);
  }
  if (label === "ui" && target.kind === "ui") {
    return setDeployableUi(source, owner.name, target.name);
  }
  return null;
}
