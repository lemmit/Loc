import type { AstNode } from "langium";
import type { SystemGraph } from "./model";

// ---------------------------------------------------------------------------
// Hierarchical (nested) layout for the system Model graph: modules and bounded
// contexts become React Flow parent ("group") nodes, with their member
// constructs laid out in a grid inside their context. Pure + deterministic:
// given a graph it returns group boxes and per-node placements (positions are
// relative to the parent group, as React Flow expects for child nodes).
//
// Infra / orphan constructs (api / storage / ui / deployable, or anything not
// inside a context) aren't grouped — they're placed in a row beneath the
// modules with no parent.
// ---------------------------------------------------------------------------

export interface GroupBox {
  id: string;
  kind: "subdomain" | "context";
  name: string;
  /** Parent group id (a context's module), or null for a top-level group. */
  parentId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Placement {
  /** Owning group id, or null when the node is ungrouped (absolute coords). */
  parentId: string | null;
  x: number;
  y: number;
}

export interface GroupedLayout {
  groups: GroupBox[];
  placements: Map<string, Placement>;
}

const NODE_W = 150;
const NODE_H = 54;
const GAP = 16;
const PAD = 14;
const PAD_TOP = 30; // room for the group's label
const COLS = 2;

const contextGroupId = (name: string): string => `group:context:${name}`;
const subdomainGroupId = (name: string): string => `group:module:${name}`;

/** Name of the nearest ancestor of `node` with the given `$type`. */
function ancestorName(node: AstNode, type: string): string | undefined {
  let p: AstNode | undefined = node.$container;
  while (p) {
    if (p.$type === type) return (p as { name?: string }).name;
    p = p.$container;
  }
  return undefined;
}

interface CtxAcc {
  name: string;
  module?: string;
  members: string[];
}

export function groupedLayout(graph: SystemGraph): GroupedLayout {
  // 1. Bucket leaf nodes by their containing context (in document order).
  const ctxByName = new Map<string, CtxAcc>();
  const ungrouped: string[] = [];
  for (const n of graph.nodes) {
    if (n.kind === "subdomain") continue; // modules become group containers
    const ctx = ancestorName(n.ast, "BoundedContext");
    if (!ctx) {
      ungrouped.push(n.id);
      continue;
    }
    let acc = ctxByName.get(ctx);
    if (!acc) {
      acc = { name: ctx, module: ancestorName(n.ast, "Subdomain"), members: [] };
      ctxByName.set(ctx, acc);
    }
    acc.members.push(n.id);
  }

  const groups: GroupBox[] = [];
  const placements = new Map<string, Placement>();

  // 2. Size each context from its member grid, and place the members inside it.
  const ctxSize = new Map<string, { width: number; height: number }>();
  for (const acc of ctxByName.values()) {
    const cols = Math.max(1, Math.min(COLS, acc.members.length));
    const rows = Math.max(1, Math.ceil(acc.members.length / cols));
    acc.members.forEach((id, i) => {
      placements.set(id, {
        parentId: contextGroupId(acc.name),
        x: PAD + (i % cols) * (NODE_W + GAP),
        y: PAD_TOP + Math.floor(i / cols) * (NODE_H + GAP),
      });
    });
    ctxSize.set(acc.name, {
      width: 2 * PAD + cols * NODE_W + (cols - 1) * GAP,
      height: PAD_TOP + PAD + rows * NODE_H + (rows - 1) * GAP,
    });
  }

  // 3. Group contexts under their module (or leave module-less contexts as
  //    top-level groups). Compute module sizes from stacked contexts.
  const subdomainOf = new Map<string, string[]>(); // module name → context names
  const topLevelContexts: string[] = [];
  for (const acc of ctxByName.values()) {
    if (acc.module) {
      const list = subdomainOf.get(acc.module) ?? [];
      list.push(acc.name);
      subdomainOf.set(acc.module, list);
    } else {
      topLevelContexts.push(acc.name);
    }
  }

  // Lay contexts out vertically inside a module; returns the module's size.
  const placeContextsInSubdomain = (subdomainName: string): { width: number; height: number } => {
    let y = PAD_TOP;
    let maxW = 0;
    for (const ctxName of subdomainOf.get(subdomainName) ?? []) {
      const size = ctxSize.get(ctxName)!;
      groups.push({
        id: contextGroupId(ctxName),
        kind: "context",
        name: ctxName,
        parentId: subdomainGroupId(subdomainName),
        x: PAD,
        y,
        width: size.width,
        height: size.height,
      });
      y += size.height + GAP;
      maxW = Math.max(maxW, size.width);
    }
    return { width: 2 * PAD + maxW, height: y - GAP + PAD };
  };

  // 4. Arrange the top-level groups (modules + module-less contexts) in a row.
  let x = 0;
  let rowHeight = 0;
  for (const subdomainName of subdomainOf.keys()) {
    const size = placeContextsInSubdomain(subdomainName);
    groups.push({
      id: subdomainGroupId(subdomainName),
      kind: "subdomain",
      name: subdomainName,
      parentId: null,
      x,
      y: 0,
      width: size.width,
      height: size.height,
    });
    x += size.width + GAP * 2;
    rowHeight = Math.max(rowHeight, size.height);
  }
  for (const ctxName of topLevelContexts) {
    const size = ctxSize.get(ctxName)!;
    groups.push({
      id: contextGroupId(ctxName),
      kind: "context",
      name: ctxName,
      parentId: null,
      x,
      y: 0,
      width: size.width,
      height: size.height,
    });
    x += size.width + GAP * 2;
    rowHeight = Math.max(rowHeight, size.height);
  }

  // 5. Ungrouped (infra / orphan) nodes go in a row beneath everything.
  const infraY = rowHeight + GAP * 3;
  ungrouped.forEach((id, i) => {
    placements.set(id, { parentId: null, x: i * (NODE_W + GAP), y: infraY });
  });

  return { groups, placements };
}
