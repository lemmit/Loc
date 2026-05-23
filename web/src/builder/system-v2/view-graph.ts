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
  Deployable,
  Model,
  Module,
  Operation,
  Statement,
  System,
  SystemMember,
  Workflow,
} from "../../../../src/language/generated/ast.js";
import { deployableModules, deployableServes, deployableTargets, deployableUi } from "../system/deployable-bindings";

export type ViewKind =
  // containers (drillable)
  | "system"
  | "module"
  | "context"
  | "aggregate"
  | "operation"
  | "workflow"
  // statement-flow node (the leaf of an operation / workflow view)
  | "stmt"
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
  const deployables: Deployable[] = [];
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
        deployables.push(m as Deployable);
        break;
    }
  }
  // Surface each deployable's bindings as edges into its bound module(s) /
  // api(s) / ui / target deployable. Pure reflection of the AST refs — Phase
  // 4c2 makes them editable.
  const edges: VEdge[] = [];
  for (const d of deployables) {
    const src = nid("deployable", d.name);
    for (const mod of deployableModules(d))
      edges.push({ id: `bind:${src}->module:${mod}`, source: src, target: nid("module", mod), label: "modules" });
    for (const api of deployableServes(d))
      edges.push({ id: `bind:${src}->api:${api}`, source: src, target: nid("api", api), label: "serves" });
    const ui = deployableUi(d);
    if (ui) edges.push({ id: `bind:${src}->ui:${ui}`, source: src, target: nid("ui", ui), label: "ui" });
    const tgt = deployableTargets(d);
    if (tgt) edges.push({ id: `bind:${src}->deployable:${tgt}`, source: src, target: nid("deployable", tgt), label: "targets" });
  }
  return { title: `system ${name}`, nodes: layout(items, SYSTEM_ORDER), edges };
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

const STMT_ROW_H = 130;

export function findAggregate(ast: Model, name: string): Aggregate | undefined {
  for (const m of ast.members) {
    if (m.$type === "BoundedContext") {
      for (const cm of (m as BoundedContext).members)
        if (cm.$type === "Aggregate" && (cm as Aggregate).name === name) return cm as Aggregate;
    } else if (m.$type === "System") {
      for (const sm of (m as System).members) {
        if (sm.$type === "BoundedContext") {
          for (const cm of (sm as BoundedContext).members)
            if (cm.$type === "Aggregate" && (cm as Aggregate).name === name) return cm as Aggregate;
        }
        if (sm.$type === "Module") {
          for (const c of (sm as Module).contexts) {
            for (const cm of c.members)
              if (cm.$type === "Aggregate" && (cm as Aggregate).name === name) return cm as Aggregate;
          }
        }
      }
    }
  }
  return undefined;
}

function findWorkflow(ast: Model, name: string): Workflow | undefined {
  // Workflows are context members; search every reachable context.
  const visit = (members: ContextMember[]): Workflow | undefined => {
    for (const cm of members) {
      if (cm.$type === "Workflow" && (cm as Workflow).name === name) return cm as Workflow;
    }
    return undefined;
  };
  for (const m of ast.members) {
    if (m.$type === "BoundedContext") {
      const wf = visit((m as BoundedContext).members);
      if (wf) return wf;
    } else if (m.$type === "System") {
      for (const sm of (m as System).members) {
        if (sm.$type === "BoundedContext") {
          const wf = visit((sm as BoundedContext).members);
          if (wf) return wf;
        }
        if (sm.$type === "Module") {
          for (const c of (sm as Module).contexts) {
            const wf = visit(c.members);
            if (wf) return wf;
          }
        }
      }
    }
  }
  return undefined;
}

/** Lay out a statement body as a vertical column of `stmt` nodes connected by
 *  implicit "next" edges. The custom React Flow `stmt` node type (in the pane)
 *  renders each node's content; the view-graph just owns positions + topology. */
function stmtFlow(title: string, body: Statement[]): ViewGraph {
  const nodes: VNode[] = body.map((_, i) => ({
    id: `stmt:${i}`,
    kind: "stmt",
    name: String(i),
    x: 0,
    y: i * STMT_ROW_H,
    drillable: false,
  }));
  const edges: VEdge[] = body.slice(0, -1).map((_, i) => ({
    id: `next:${i}`,
    source: `stmt:${i}`,
    target: `stmt:${i + 1}`,
  }));
  return { title, nodes, edges };
}

function operationView(ast: Model, aggName: string, opName: string): ViewGraph {
  const agg = findAggregate(ast, aggName);
  const op = agg?.members.find(
    (m): m is Operation => m.$type === "Operation" && (m as Operation).name === opName,
  );
  if (!op) return { title: `${aggName}.${opName}`, nodes: [], edges: [] };
  return stmtFlow(`${aggName}.${opName}()`, op.body);
}

function workflowView(ast: Model, name: string): ViewGraph {
  const wf = findWorkflow(ast, name);
  if (!wf) return { title: `workflow ${name}`, nodes: [], edges: [] };
  return stmtFlow(`workflow ${name}()`, wf.body);
}

/** Dispatch on the last step of `path` to the per-level builder; empty path
 *  is the root view. Operation and workflow leaves render as a statement
 *  flow (the leaf node type the pane knows how to render). */
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
    case "operation": {
      // An operation only resolves below an aggregate step.
      const agg = path[path.length - 2];
      if (agg?.kind !== "aggregate") return { title: last.name, nodes: [], edges: [] };
      return operationView(ast, agg.name, last.name);
    }
    case "workflow":
      return workflowView(ast, last.name);
    default:
      // Other leaves (value object / event / repository / view / function / …)
      // still have no children to show — opt-in node-detail comes later.
      return { title: `${last.kind} ${last.name}`, nodes: [], edges: [] };
  }
}
