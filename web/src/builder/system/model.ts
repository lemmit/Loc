import { AstUtils, type AstNode } from "langium";
import type { LoomModel, TraceabilityIR, TypeIR, WireField } from "../../../../src/ir/types/loom-ir.js";
import type {
  Aggregate,
  Api,
  Deployable,
  EmitStmt,
  EventDecl,
  Subdomain,
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
  | "subdomain"
  | "context"
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
  "subdomain",
  "context",
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
      case "Subdomain": addNode("subdomain", (node as Subdomain).name, node); break;
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
        // `from <Subdomain>` is optional (a scaffoldApi macro may supply the
        // surface instead) — only draw the edge when it was written.
        if (a.source) addEdge(nodeId("api", a.name), nodeId("subdomain", a.source.$refText), "from");
        break;
      }
      case "Deployable": {
        const d = node as Deployable;
        const from = nodeId("deployable", d.name);
        for (const r of d.contextRefs) addEdge(from, nodeId("context", r.$refText), "context");
        for (const s of d.serves) addEdge(from, nodeId("api", s.$refText), "serves");
        if (d.targets) addEdge(from, nodeId("deployable", d.targets.$refText), "targets");
        const uiRef = d.uiSugar?.ref ?? d.uiCompose?.ref;
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

// A diagnostic's line span overlaps a node's, attributed to the *tightest*
// containing node — see `nodeDiagnostics`.
interface LineRanged {
  range: { start: { line: number }; end: { line: number } };
}

/** Attribute each diagnostic to the graph node whose source most tightly
 *  contains it (smallest line span), so a problem inside an aggregate marks the
 *  aggregate — not also its enclosing module. Diagnostics outside every node's
 *  span (e.g. system-level) are dropped (they still show in the Problems panel).
 *  Coordinates are 0-based LSP lines, shared by CST ranges and diagnostics. */
export function nodeDiagnostics<D extends LineRanged>(graph: SystemGraph, diagnostics: readonly D[]): Map<string, D[]> {
  const spans = graph.nodes.flatMap((n) => {
    const r = n.ast.$cstNode?.range;
    return r ? [{ id: n.id, start: r.start.line, end: r.end.line, size: r.end.line - r.start.line }] : [];
  });
  const out = new Map<string, D[]>();
  for (const d of diagnostics) {
    let best: { id: string; size: number } | null = null;
    for (const s of spans) {
      if (d.range.start.line < s.start || d.range.start.line > s.end) continue;
      if (!best || s.size < best.size) best = { id: s.id, size: s.size };
    }
    if (best) (out.get(best.id) ?? out.set(best.id, []).get(best.id)!).push(d);
  }
  return out;
}

// --- wire-shape (DTO) preview ----------------------------------------------

/** A compact, source-faithful label for an IR type (`Order id`, `Money[]`,
 *  `string?`), for showing a construct's wire shape in the inspector. */
export function typeLabel(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      return t.name;
    case "id":
      return `${t.targetName} id`;
    case "enum":
    case "valueobject":
    case "entity":
      return t.name;
    case "array":
      return `${typeLabel(t.element)}[]`;
    case "optional":
      return `${typeLabel(t.inner)}?`;
    case "slot":
      return "slot";
    case "action":
      return t.arg ? `action(${typeLabel(t.arg)})` : "action";
    case "genericInstance":
      return `${typeLabel(t.arg)} ${t.ctor}`;
    case "union":
      return t.variants.map(typeLabel).join(" or ");
    case "none":
      return "none";
    case "action":
      // Function-valued component-param marker; match the source-faithful
      // `action` / `action(<arg>)` label the AST printer emits.
      return t.arg ? `action(${typeLabel(t.arg)})` : "action";
  }
}

// Every wire-shape-bearing construct across explicit systems + legacy
// top-level contexts.
function* wireOwners(
  loom: LoomModel,
): Generator<{ kind: "aggregate" | "valueobject"; name: string; wireShape?: WireField[] }> {
  const contexts = [
    ...loom.contexts,
    ...loom.systems.flatMap((s) => s.subdomains.flatMap((m) => m.contexts)),
  ];
  for (const c of contexts) {
    for (const a of c.aggregates) yield { kind: "aggregate", name: a.name, wireShape: a.wireShape };
    for (const v of c.valueObjects) yield { kind: "valueobject", name: v.name, wireShape: v.wireShape };
  }
}

/** The enrichment-computed wire shape (canonical DTO field list) for an
 *  aggregate / value object by name, or null if it has none. */
export function wireShapeOf(loom: LoomModel, kind: string, name: string): WireField[] | null {
  for (const o of wireOwners(loom)) {
    if (o.kind === kind && o.name === name) return o.wireShape ?? null;
  }
  return null;
}

// --- traceability coverage overlay ----------------------------------------

export type CoverageStatus = "covered" | "uncovered" | "none";

// Graph node kind → the CodeRefKind used in traceability qualified names.
// storage / ui aren't `Targetable`, so they never carry coverage.
const NODE_KIND_TO_REF: Partial<Record<NodeKind, string>> = {
  subdomain: "subdomain",
  context: "context",
  aggregate: "aggregate",
  valueobject: "valueobject",
  event: "event",
  repository: "repository",
  view: "view",
  workflow: "workflow",
  deployable: "deployable",
  api: "api",
};

const lastSegment = (qn: string): string => qn.slice(qn.lastIndexOf(".") + 1);

/** Per-node coverage status from the traceability index: `covered` if the
 *  construct (or, for an aggregate, any operation under it) is referenced by a
 *  `solution`/`testCase` *and* has ≥1 covering testCase; `uncovered` if
 *  referenced but with no test; `none` if no artifact references it at all. */
export function coverageByNode(
  graph: SystemGraph,
  trace: Pick<TraceabilityIR, "codeElements" | "testsByCodeElement">,
): Map<string, CoverageStatus> {
  const tested = (qn: string): boolean => (trace.testsByCodeElement[qn] ?? []).length > 0;
  const out = new Map<string, CoverageStatus>();
  for (const node of graph.nodes) {
    const refKind = NODE_KIND_TO_REF[node.kind];
    if (!refKind) {
      out.set(node.id, "none");
      continue;
    }
    const owned = Object.entries(trace.codeElements)
      .filter(([qn, kind]) => {
        if (kind === refKind && lastSegment(qn) === node.name) return true;
        // An operation declared under this aggregate (`…Aggregate.op`).
        if (kind === "operation" && node.kind === "aggregate") {
          const parts = qn.split(".");
          return parts.length >= 2 && parts[parts.length - 2] === node.name;
        }
        return false;
      })
      .map(([qn]) => qn);
    out.set(node.id, owned.length === 0 ? "none" : owned.some(tested) ? "covered" : "uncovered");
  }
  return out;
}

/** Node ids matching a search query (case-insensitive substring over name +
 *  kind) and a kind filter. An empty query ignores text; an empty `kinds`
 *  ignores kind — so no query and no kinds matches every node (filter inactive).
 */
export function matchNodes(graph: SystemGraph, query: string, kinds: readonly NodeKind[]): Set<string> {
  const q = query.trim().toLowerCase();
  const kindSet = kinds.length ? new Set<NodeKind>(kinds) : null;
  const out = new Set<string>();
  for (const n of graph.nodes) {
    if (kindSet && !kindSet.has(n.kind)) continue;
    if (q && !n.name.toLowerCase().includes(q) && !n.kind.toLowerCase().includes(q)) continue;
    out.add(n.id);
  }
  return out;
}
