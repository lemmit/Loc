// Pure per-level view-graph builder for the Modeller v2.
//
// v2's central idea is that the canvas IS the navigator: at every drill level
// the React Flow shows just the children of the current node, and a breadcrumb
// tracks the path. This module owns the data side — given the parsed AST and
// the current path, return the nodes + edges (with deterministic positions)
// for that level. The pane wraps it with state + React Flow rendering.

import type {
  Aggregate,
  AggregateMember,
  BoundedContext,
  ContextMember,
  Model,
  Module,
  System,
  SystemMember,
} from "../../../../src/language/generated/ast.js";

export type ViewKind =
  // containers (drillable)
  | "system"
  | "module"
  | "context"
  | "aggregate"
  | "operation"
  | "workflow"
  // leaves (Phase 1: shown but not drillable)
  | "valueobject"
  | "event"
  | "repository"
  | "view"
  | "function"
  | "field"
  | "containment"
  | "api"
  | "storage"
  | "ui"
  | "deployable";

export interface ViewStep {
  kind: ViewKind;
  name: string;
}
export type ViewPath = ViewStep[];

export interface VNode {
  id: string;
  kind: ViewKind;
  name: string;
  x: number;
  y: number;
  /** Whether double-clicking / clicking the drill-in handle on this node
   *  pushes a new step onto the path (i.e. it has a meaningful sub-view). */
  drillable: boolean;
}

export interface VEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface ViewGraph {
  /** Crumb label for the *current* level (the last path step, or "Model"). */
  title: string;
  nodes: VNode[];
  edges: VEdge[];
}

const DRILLABLE: ReadonlySet<ViewKind> = new Set([
  "system",
  "module",
  "context",
  "aggregate",
  "operation",
  "workflow",
]);

const COL_W = 220;
const ROW_H = 90;

/** Place nodes in column-per-kind order; nodes of the same kind stack
 *  vertically. Stable, deterministic — Phase 1 is purely derived layout. */
function layout(
  raw: { id: string; kind: ViewKind; name: string }[],
  kindOrder: readonly ViewKind[],
): VNode[] {
  const perKindRow = new Map<ViewKind, number>();
  return raw.map((n) => {
    const col = kindOrder.indexOf(n.kind);
    const row = perKindRow.get(n.kind) ?? 0;
    perKindRow.set(n.kind, row + 1);
    return {
      id: n.id,
      kind: n.kind,
      name: n.name,
      x: (col >= 0 ? col : kindOrder.length) * COL_W,
      y: row * ROW_H,
      drillable: DRILLABLE.has(n.kind),
    };
  });
}

const nid = (kind: ViewKind, name: string): string => `${kind}:${name}`;

const ROOT_ORDER: readonly ViewKind[] = ["system", "context"];

function rootView(ast: Model): ViewGraph {
  const items: { id: string; kind: ViewKind; name: string }[] = [];
  for (const m of ast.members) {
    if (m.$type === "System") {
      items.push({ id: nid("system", (m as System).name), kind: "system", name: (m as System).name });
    } else if (m.$type === "BoundedContext") {
      items.push({
        id: nid("context", (m as BoundedContext).name),
        kind: "context",
        name: (m as BoundedContext).name,
      });
    }
  }
  return { title: "Model", nodes: layout(items, ROOT_ORDER), edges: [] };
}

const SYSTEM_ORDER: readonly ViewKind[] = [
  "module",
  "context",
  "api",
  "storage",
  "ui",
  "deployable",
];

function systemView(ast: Model, name: string): ViewGraph {
  const sys = ast.members.find((m): m is System => m.$type === "System" && (m as System).name === name);
  if (!sys) return { title: name, nodes: [], edges: [] };
  const items: { id: string; kind: ViewKind; name: string }[] = [];
  for (const m of sys.members as SystemMember[]) {
    const childName = (m as { name?: string }).name;
    if (!childName) continue;
    switch (m.$type) {
      case "Module":
        items.push({ id: nid("module", childName), kind: "module", name: childName });
        break;
      case "BoundedContext":
        items.push({ id: nid("context", childName), kind: "context", name: childName });
        break;
      case "Api":
        items.push({ id: nid("api", childName), kind: "api", name: childName });
        break;
      case "Storage":
        items.push({ id: nid("storage", childName), kind: "storage", name: childName });
        break;
      case "Ui":
        items.push({ id: nid("ui", childName), kind: "ui", name: childName });
        break;
      case "Deployable":
        items.push({ id: nid("deployable", childName), kind: "deployable", name: childName });
        break;
    }
  }
  return { title: `system ${name}`, nodes: layout(items, SYSTEM_ORDER), edges: [] };
}

function moduleView(ast: Model, name: string): ViewGraph {
  let mod: Module | undefined;
  for (const m of ast.members) {
    if (m.$type === "System") {
      for (const sm of (m as System).members) {
        if (sm.$type === "Module" && (sm as Module).name === name) mod = sm as Module;
      }
    }
  }
  if (!mod) return { title: name, nodes: [], edges: [] };
  const items = mod.contexts.map((c) => ({ id: nid("context", c.name), kind: "context" as const, name: c.name }));
  return { title: `module ${name}`, nodes: layout(items, ["context"]), edges: [] };
}

const CONTEXT_ORDER: readonly ViewKind[] = [
  "aggregate",
  "valueobject",
  "event",
  "repository",
  "view",
  "workflow",
];

const CONTEXT_KIND: Partial<Record<string, ViewKind>> = {
  Aggregate: "aggregate",
  ValueObject: "valueobject",
  EventDecl: "event",
  Repository: "repository",
  View: "view",
  Workflow: "workflow",
};

function contextView(ast: Model, name: string): ViewGraph {
  // Find by walking; contexts can live at Model level (legacy) or in a Module.
  let ctx: BoundedContext | undefined;
  for (const m of ast.members) {
    if (m.$type === "BoundedContext" && (m as BoundedContext).name === name) {
      ctx = m as BoundedContext;
    } else if (m.$type === "System") {
      for (const sm of (m as System).members) {
        if (sm.$type === "BoundedContext" && (sm as BoundedContext).name === name) ctx = sm as BoundedContext;
        if (sm.$type === "Module") {
          for (const c of (sm as Module).contexts) if (c.name === name) ctx = c;
        }
      }
    }
  }
  if (!ctx) return { title: name, nodes: [], edges: [] };
  const items: { id: string; kind: ViewKind; name: string }[] = [];
  for (const m of ctx.members as ContextMember[]) {
    const kind = CONTEXT_KIND[m.$type];
    const childName = (m as { name?: string }).name;
    if (!kind || !childName) continue;
    items.push({ id: nid(kind, childName), kind, name: childName });
  }
  return { title: `context ${name}`, nodes: layout(items, CONTEXT_ORDER), edges: [] };
}

const AGGREGATE_ORDER: readonly ViewKind[] = ["operation", "function", "field", "containment"];

function aggregateView(ast: Model, name: string): ViewGraph {
  let agg: Aggregate | undefined;
  for (const m of ast.members) {
    if (m.$type === "BoundedContext") {
      for (const cm of (m as BoundedContext).members)
        if (cm.$type === "Aggregate" && (cm as Aggregate).name === name) agg = cm as Aggregate;
    } else if (m.$type === "System") {
      for (const sm of (m as System).members) {
        if (sm.$type === "BoundedContext") {
          for (const cm of (sm as BoundedContext).members)
            if (cm.$type === "Aggregate" && (cm as Aggregate).name === name) agg = cm as Aggregate;
        }
        if (sm.$type === "Module") {
          for (const c of (sm as Module).contexts) {
            for (const cm of c.members)
              if (cm.$type === "Aggregate" && (cm as Aggregate).name === name) agg = cm as Aggregate;
          }
        }
      }
    }
  }
  if (!agg) return { title: name, nodes: [], edges: [] };
  const items: { id: string; kind: ViewKind; name: string }[] = [];
  for (const m of agg.members as AggregateMember[]) {
    const childName = (m as { name?: string }).name;
    if (!childName) continue;
    switch (m.$type) {
      case "Operation":
        items.push({ id: nid("operation", childName), kind: "operation", name: childName });
        break;
      case "FunctionDecl":
        items.push({ id: nid("function", childName), kind: "function", name: childName });
        break;
      case "Property":
        items.push({ id: nid("field", childName), kind: "field", name: childName });
        break;
      case "Containment":
        items.push({ id: nid("containment", childName), kind: "containment", name: childName });
        break;
    }
  }
  return { title: `aggregate ${name}`, nodes: layout(items, AGGREGATE_ORDER), edges: [] };
}

/** Dispatch on the last step of `path` to the per-level builder; empty path
 *  is the root view. Leaf kinds (operation / workflow / value object / …) get
 *  a placeholder graph in Phase 1; Phase 2 replaces operation/workflow with
 *  the statement-flow view. */
export function buildViewGraph(ast: Model, path: ViewPath): ViewGraph {
  const last = path[path.length - 1];
  if (!last) return rootView(ast);
  switch (last.kind) {
    case "system":
      return systemView(ast, last.name);
    case "module":
      return moduleView(ast, last.name);
    case "context":
      return contextView(ast, last.name);
    case "aggregate":
      return aggregateView(ast, last.name);
    default:
      // Leaves (Phase 1): no children to show yet. Phase 2 fills in operation/
      // workflow with the statement flow.
      return { title: `${last.kind} ${last.name}`, nodes: [], edges: [] };
  }
}
