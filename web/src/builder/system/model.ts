import { AstUtils, type AstNode } from "langium";
import type {
  Aggregate,
  Api,
  Deployable,
  EmitStmt,
  EventDecl,
  Module,
  Repository,
  Storage,
  Ui,
  ValueObject,
  View,
  Workflow,
} from "../../../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// AST → graph model for the System / Model Builder.
//
// Maps the structural model to nodes (one per construct) and edges (the clear
// cross-references: repository→aggregate, api→module, deployable→module/ui/api,
// view→aggregate).  The pane lays these out and renders them with React Flow;
// edits splice the backing AST node's CST range via the structural printer.
//
// Node positions are layout, not model — they're derived deterministically here
// and not written back to source.
// ---------------------------------------------------------------------------

export type NodeKind =
  | "module"
  | "aggregate"
  | "valueobject"
  | "event"
  | "repository"
  | "view"
  | "workflow"
  | "deployable"
  | "api"
  | "storage"
  | "ui";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  /** Backing AST node — carries the CST range edits splice over. */
  ast: AstNode;
  x: number;
  y: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
}

export interface SystemGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const nodeId = (kind: NodeKind, name: string): string => `${kind}:${name}`;

/** The graph node that owns an `emit` statement — the nearest aggregate or
 *  workflow ancestor (operations live inside aggregates). */
function emitterId(node: AstNode): string | null {
  let cur = node.$container;
  while (cur) {
    if (cur.$type === "Aggregate") return nodeId("aggregate", (cur as Aggregate).name);
    if (cur.$type === "Workflow") return nodeId("workflow", (cur as Workflow).name);
    cur = cur.$container;
  }
  return null;
}

// Column-per-kind layout — deterministic so re-seeding doesn't jump nodes
// around; the user can drag from here.  Domain kinds on the left, deployment
// kinds on the right.
const COLUMN_ORDER: NodeKind[] = [
  "module",
  "aggregate",
  "valueobject",
  "event",
  "repository",
  "view",
  "workflow",
  "api",
  "ui",
  "deployable",
  "storage",
];
const COL_WIDTH = 220;
const ROW_HEIGHT = 90;

export function buildSystemGraph(ast: AstNode): SystemGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const perKindCount = new Map<NodeKind, number>();

  const addNode = (kind: NodeKind, name: string, node: AstNode): void => {
    const id = nodeId(kind, name);
    if (seen.has(id)) return;
    seen.add(id);
    const col = COLUMN_ORDER.indexOf(kind);
    const row = perKindCount.get(kind) ?? 0;
    perKindCount.set(kind, row + 1);
    nodes.push({ id, kind, name, ast: node, x: col * COL_WIDTH, y: row * ROW_HEIGHT });
  };

  // First pass — every construct becomes a node.
  for (const node of AstUtils.streamAst(ast)) {
    switch (node.$type) {
      case "Module": addNode("module", (node as Module).name, node); break;
      case "Aggregate": addNode("aggregate", (node as Aggregate).name, node); break;
      case "ValueObject": addNode("valueobject", (node as ValueObject).name, node); break;
      case "EventDecl": addNode("event", (node as EventDecl).name, node); break;
      case "Repository": addNode("repository", (node as Repository).name, node); break;
      case "View": addNode("view", (node as View).name, node); break;
      case "Workflow": addNode("workflow", (node as Workflow).name, node); break;
      case "Deployable": addNode("deployable", (node as Deployable).name, node); break;
      case "Api": addNode("api", (node as Api).name, node); break;
      case "Storage": addNode("storage", (node as Storage).name, node); break;
      case "Ui": addNode("ui", (node as Ui).name, node); break;
      default: break;
    }
  }

  const has = (id: string): boolean => seen.has(id);
  const addEdge = (sourceId: string, targetId: string, label: string): void => {
    if (!has(sourceId) || !has(targetId)) return;
    const id = `${sourceId}->${targetId}:${label}`;
    if (edges.some((e) => e.id === id)) return;
    edges.push({ id, source: sourceId, target: targetId, label });
  };

  // Second pass — resolve the clear references into edges.
  for (const node of AstUtils.streamAst(ast)) {
    switch (node.$type) {
      case "Repository": {
        const r = node as Repository;
        addEdge(nodeId("repository", r.name), nodeId("aggregate", r.aggregate.$refText), "for");
        break;
      }
      case "View": {
        const v = node as View;
        if (v.source) addEdge(nodeId("view", v.name), nodeId("aggregate", v.source.$refText), "from");
        break;
      }
      case "Api": {
        const a = node as Api;
        addEdge(nodeId("api", a.name), nodeId("module", a.source.$refText), "from");
        break;
      }
      case "Deployable": {
        const d = node as Deployable;
        const from = nodeId("deployable", d.name);
        for (const b of d.moduleBindings) addEdge(from, nodeId("module", b.name.$refText), "module");
        for (const s of d.serves) addEdge(from, nodeId("api", s.$refText), "serves");
        if (d.targets) addEdge(from, nodeId("deployable", d.targets.$refText), "targets");
        const uiRef = d.uiSugar?.ref ?? d.uiCompose?.ref ?? d.uiBlock?.ref;
        if (uiRef) addEdge(from, nodeId("ui", uiRef.$refText), "ui");
        break;
      }
      case "EmitStmt": {
        // `emit E { … }` in an operation/workflow body wires its owner → event.
        const src = emitterId(node);
        if (src) addEdge(src, nodeId("event", (node as EmitStmt).event.$refText), "emits");
        break;
      }
      default: break;
    }
  }

  return { nodes, edges };
}
