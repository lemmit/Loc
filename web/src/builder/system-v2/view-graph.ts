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
  Repository,
  Statement,
  System,
  SystemMember,
  Workflow,
} from "../../../../src/language/generated/ast.js";
import { deployableModules, deployableServes, deployableTargets, deployableUi } from "../system/deployable-bindings";
import { computeAggregateRelations } from "./aggregate-edges";
import { computeContextRelations } from "./context-edges";

export type ViewKind =
  // containers (drillable)
  | "system"
  | "module"
  | "context"
  | "aggregate"
  | "operation"
  | "workflow"
  | "repository"
  // statement-flow node (the leaf of an operation / workflow view)
  | "stmt"
  // a single repository find — the leaf of a repository view
  | "find"
  // aggregate-level invariant — a synthetic node (Invariant has no name; the
  // node carries a preview of its expression as `name`)
  | "invariant"
  // aggregate-level derived property — has a name + an expression.
  | "derived"
  // leaves (still no drill below)
  | "valueobject"
  | "event"
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

/** Visual + semantic discriminator on an edge:
 *
 *   - "binding"    : a deployable's modules/serves/ui/targets ref (system view)
 *   - "next"       : statement → next statement (operation/workflow flow view)
 *   - "reads"      : an operation/derived/invariant/function references a field
 *   - "writes"     : an operation assigns a field
 *   - "constrains" : an invariant references a field
 *   - "emits"      : an operation emits an event
 *
 *  The pane renders different stroke/colour/dashing per kind. Defaulting to
 *  `undefined` keeps backwards compatibility with pre-aggregate-edges callers. */
export type EdgeKind = "binding" | "next" | "reads" | "writes" | "constrains" | "emits";

export interface VEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  kind?: EdgeKind;
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
  "repository",
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
      edges.push({ id: `bind:${src}->module:${mod}`, source: src, target: nid("module", mod), label: "modules", kind: "binding" });
    for (const api of deployableServes(d))
      edges.push({ id: `bind:${src}->api:${api}`, source: src, target: nid("api", api), label: "serves", kind: "binding" });
    const ui = deployableUi(d);
    if (ui) edges.push({ id: `bind:${src}->ui:${ui}`, source: src, target: nid("ui", ui), label: "ui", kind: "binding" });
    const tgt = deployableTargets(d);
    if (tgt) edges.push({ id: `bind:${src}->deployable:${tgt}`, source: src, target: nid("deployable", tgt), label: "targets", kind: "binding" });
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

// Column order for the context view: consumers (repository / view /
// workflow) on the left, aggregates in the centre, value-objects + events
// on the right. Edges flow LEFT-TO-RIGHT consistently — repo→aggregate,
// view→aggregate, workflow→aggregate, aggregate→event — which matches the
// downstream direction of each relationship.
const CONTEXT_ORDER: readonly ViewKind[] = [
  "repository",
  "view",
  "workflow",
  "aggregate",
  "valueobject",
  "event",
];

const CONTEXT_KIND: Partial<Record<string, ViewKind>> = {
  Aggregate: "aggregate",
  ValueObject: "valueobject",
  EventDecl: "event",
  Repository: "repository",
  View: "view",
  Workflow: "workflow",
};

const CTX_COL_W = 220;
const CTX_ROW_H = 90;

/** Per-column layout where consumers (left of aggregate) and outcomes
 *  (right of aggregate, currently events) align to the row of the
 *  aggregate they connect to. Mirrors aggregateLayout's read-row alignment
 *  trick — works for any column-against-pivot pattern. */
function contextLayout(
  items: { id: string; kind: ViewKind; name: string; anchor?: string }[],
): VNode[] {
  const byCol = new Map<number, typeof items>();
  for (const it of items) {
    const col = CONTEXT_ORDER.indexOf(it.kind);
    const list = byCol.get(col >= 0 ? col : CONTEXT_ORDER.length);
    if (list) list.push(it);
    else byCol.set(col >= 0 ? col : CONTEXT_ORDER.length, [it]);
  }
  // Pass 1: place aggregates (the pivot column).
  const aggCol = CONTEXT_ORDER.indexOf("aggregate");
  const aggregateRow = new Map<string, number>();
  const placed = new Map<string, { x: number; y: number }>();
  const aggs = byCol.get(aggCol) ?? [];
  for (let i = 0; i < aggs.length; i++) {
    const a = aggs[i]!;
    placed.set(a.id, { x: aggCol * CTX_COL_W, y: i * CTX_ROW_H });
    aggregateRow.set(a.name, i);
  }
  // Pass 2: place every other column, aligning to its anchor's row when set.
  for (const [col, bucket] of byCol) {
    if (col === aggCol) continue;
    const taken = new Set<number>();
    let nextRow = 0;
    for (const it of bucket) {
      const anchorRow = it.anchor ? aggregateRow.get(it.anchor) : undefined;
      let row: number;
      if (anchorRow !== undefined) {
        row = anchorRow;
        while (taken.has(row)) row++;
      } else {
        row = nextRow;
        while (taken.has(row)) row++;
      }
      taken.add(row);
      nextRow = Math.max(nextRow, row + 1);
      placed.set(it.id, { x: col * CTX_COL_W, y: row * CTX_ROW_H });
    }
  }
  return items.map((it) => ({
    id: it.id,
    kind: it.kind,
    name: it.name,
    x: placed.get(it.id)!.x,
    y: placed.get(it.id)!.y,
    drillable: DRILLABLE.has(it.kind),
  }));
}

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
  const rel = computeContextRelations(ctx);
  // Build the raw item list with optional `anchor` so non-aggregate nodes can
  // align to the aggregate row they reference (repo→agg, view→agg, agg→event).
  const items: { id: string; kind: ViewKind; name: string; anchor?: string }[] = [];
  for (const m of ctx.members as ContextMember[]) {
    const kind = CONTEXT_KIND[m.$type];
    const childName = (m as { name?: string }).name;
    if (!kind || !childName) continue;
    let anchor: string | undefined;
    if (kind === "repository") anchor = rel.repoFor.get(childName);
    else if (kind === "view") anchor = rel.viewSource.get(childName);
    // events anchor to the FIRST aggregate that emits them (when any) — picks
    // the source row so the edge from agg→event is roughly horizontal.
    if (kind === "event") {
      for (const [aggName, set] of rel.emits) {
        if (set.has(childName)) {
          anchor = aggName;
          break;
        }
      }
    }
    items.push({ id: nid(kind, childName), kind, name: childName, anchor });
  }

  const edges: VEdge[] = [];
  for (const [repo, agg] of rel.repoFor) {
    edges.push({
      id: `repo-for:${repo}->${agg}`,
      source: nid("repository", repo),
      target: nid("aggregate", agg),
      kind: "reads",
      label: "for",
    });
  }
  for (const [view, agg] of rel.viewSource) {
    edges.push({
      id: `view-src:${view}->${agg}`,
      source: nid("view", view),
      target: nid("aggregate", agg),
      kind: "reads",
      label: "of",
    });
  }
  for (const [agg, set] of rel.emits) {
    for (const ev of set) {
      edges.push({
        id: `emits:${agg}->${ev}`,
        source: nid("aggregate", agg),
        target: nid("event", ev),
        kind: "emits",
        label: "emits",
      });
    }
  }
  for (const [wf, set] of rel.workflowUses) {
    for (const agg of set) {
      edges.push({
        id: `wf-uses:${wf}->${agg}`,
        source: nid("workflow", wf),
        target: nid("aggregate", agg),
        kind: "reads",
        label: "uses",
      });
    }
  }
  for (const [wf, set] of rel.workflowEmits) {
    for (const ev of set) {
      edges.push({
        id: `wf-emits:${wf}->${ev}`,
        source: nid("workflow", wf),
        target: nid("event", ev),
        kind: "emits",
        label: "emits",
      });
    }
  }
  return { title: `context ${name}`, nodes: contextLayout(items), edges };
}

// Layered column order for the aggregate view. State (fields + containments)
// is the centre of gravity; invariants sit to its LEFT (constraints flow
// rightward into state), derived sits to its RIGHT (computed from state) and
// operations/functions sit further right (consumers of state). Read/write
// edges then visibly converge on the state column instead of crisscrossing.
const AGGREGATE_ORDER: readonly ViewKind[] = [
  "invariant",
  "field",
  "containment",
  "derived",
  "operation",
  "function",
];

const AGG_COL_W = 240;
const AGG_ROW_H = 80;

interface RawAggNode {
  id: string;
  kind: ViewKind;
  name: string;
  /** field-name set this consumer reads (operations / derived / invariants /
   *  functions). Empty for fields/containments themselves. */
  readsOf: ReadonlySet<string>;
}

/** Per-column placement, with consumers vertically aligned to the average row
 *  of the fields they read. Drastically reduces edge crossings vs. naive
 *  column-stack ordering — and the alignment itself acts as a visual cue
 *  ("this operation touches *those* fields"). */
function aggregateLayout(items: RawAggNode[]): VNode[] {
  // Pass 1: fields + containments + invariants get plain stacked rows so the
  // state column is the visual baseline.
  const byCol = new Map<number, RawAggNode[]>();
  for (const it of items) {
    const col = AGGREGATE_ORDER.indexOf(it.kind);
    const list = byCol.get(col >= 0 ? col : AGGREGATE_ORDER.length);
    if (list) list.push(it);
    else byCol.set(col >= 0 ? col : AGGREGATE_ORDER.length, [it]);
  }
  const fieldRow = new Map<string, number>(); // field name → row index
  const placed = new Map<string, { x: number; y: number }>();
  // Place state first so consumers can align to it.
  const stateCol = AGGREGATE_ORDER.indexOf("field");
  const contCol = AGGREGATE_ORDER.indexOf("containment");
  const stateBuckets: Array<{ col: number; items: RawAggNode[] }> = [];
  if (byCol.get(stateCol)) stateBuckets.push({ col: stateCol, items: byCol.get(stateCol)! });
  if (byCol.get(contCol)) stateBuckets.push({ col: contCol, items: byCol.get(contCol)! });
  let stateRow = 0;
  for (const b of stateBuckets) {
    for (const it of b.items) {
      placed.set(it.id, { x: b.col * AGG_COL_W, y: stateRow * AGG_ROW_H });
      fieldRow.set(it.name, stateRow);
      stateRow++;
    }
  }
  // Place every other column. Consumers (with readsOf) align to the average
  // row of the fields they touch; nodes with no reads (or no matching field)
  // stack at the next free row in their column.
  for (const [col, bucket] of byCol) {
    if (col === stateCol || col === contCol) continue;
    let nextRow = 0;
    const taken = new Set<number>();
    for (const it of bucket) {
      const rows: number[] = [];
      for (const r of it.readsOf) {
        const idx = fieldRow.get(r);
        if (idx !== undefined) rows.push(idx);
      }
      let row: number;
      if (rows.length > 0) {
        row = Math.round(rows.reduce((a, b) => a + b, 0) / rows.length);
        while (taken.has(row)) row++;
      } else {
        row = nextRow;
        while (taken.has(row)) row++;
      }
      taken.add(row);
      nextRow = Math.max(nextRow, row + 1);
      placed.set(it.id, { x: col * AGG_COL_W, y: row * AGG_ROW_H });
    }
  }
  return items.map((it) => ({
    id: it.id,
    kind: it.kind,
    name: it.name,
    x: placed.get(it.id)!.x,
    y: placed.get(it.id)!.y,
    drillable: DRILLABLE.has(it.kind),
  }));
}

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
  const rel = computeAggregateRelations(agg);
  const items: RawAggNode[] = [];
  for (const m of agg.members as AggregateMember[]) {
    const childName = (m as { name?: string }).name;
    if (!childName && m.$type !== "Invariant") continue;
    switch (m.$type) {
      case "Operation":
        items.push({
          id: nid("operation", childName!),
          kind: "operation",
          name: childName!,
          readsOf: rel.reads.get(`operation:${childName}`) ?? EMPTY,
        });
        break;
      case "FunctionDecl":
        items.push({
          id: nid("function", childName!),
          kind: "function",
          name: childName!,
          readsOf: rel.reads.get(`function:${childName}`) ?? EMPTY,
        });
        break;
      case "DerivedProp":
        items.push({
          id: nid("derived", childName!),
          kind: "derived",
          name: childName!,
          readsOf: rel.reads.get(`derived:${childName}`) ?? EMPTY,
        });
        break;
      case "Property":
        items.push({ id: nid("field", childName!), kind: "field", name: childName!, readsOf: EMPTY });
        break;
      case "Containment":
        items.push({ id: nid("containment", childName!), kind: "containment", name: childName!, readsOf: EMPTY });
        break;
    }
  }
  // Invariants are unnamed (`invariant <expr>`); synthesise nodes carrying a
  // preview of the expression. The id encodes the index so the pane can
  // splice the right one out on delete.
  let invariantIndex = 0;
  for (const m of agg.members as AggregateMember[]) {
    if (m.$type === "Invariant") {
      const preview = m.$cstNode?.text?.replace(/^invariant\s+/, "").trim() ?? `inv ${invariantIndex + 1}`;
      const invId = `invariant:${invariantIndex}`;
      items.push({
        id: invId,
        kind: "invariant",
        name: preview,
        readsOf: rel.reads.get(invId) ?? EMPTY,
      });
      invariantIndex++;
    }
  }

  // Build edges from the relations. A state-name might resolve to a `field:`,
  // `containment:`, or `derived:` id — operations can write to any of those,
  // invariants can constrain any, derived can read any. Map name → id once,
  // then materialise edges with the correct target id.
  const stateIdByName = new Map<string, string>();
  for (const i of items) {
    if (i.kind === "field" || i.kind === "containment" || i.kind === "derived") {
      stateIdByName.set(i.name, i.id);
    }
  }
  const edges: VEdge[] = [];
  const pushFieldEdges = (
    rel: ReadonlyMap<string, Set<string>>,
    kind: "reads" | "writes" | "constrains",
  ): void => {
    for (const [src, set] of rel) {
      for (const f of set) {
        const target = stateIdByName.get(f);
        if (!target) continue;
        // Constraint edges are dashed-yellow ("invariant constrains field");
        // reads are dashed-gray, writes are solid-teal. Direction is consumer →
        // field, so the arrowhead lands on the state being touched.
        edges.push({ id: `${kind}:${src}->${target}`, source: src, target, label: kind, kind });
      }
    }
  };
  // Invariants emit `constrains` edges; everything else emits `reads`.
  const invariantReads = new Map<string, Set<string>>();
  const consumerReads = new Map<string, Set<string>>();
  for (const [src, set] of rel.reads) {
    (src.startsWith("invariant:") ? invariantReads : consumerReads).set(src, set);
  }
  pushFieldEdges(invariantReads, "constrains");
  pushFieldEdges(consumerReads, "reads");
  pushFieldEdges(rel.writes, "writes");

  return { title: `aggregate ${name}`, nodes: aggregateLayout(items), edges };
}

const EMPTY: ReadonlySet<string> = new Set();

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
    kind: "next",
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

function findRepository(ast: Model, name: string): Repository | undefined {
  const visit = (members: ContextMember[]): Repository | undefined => {
    for (const cm of members) {
      if (cm.$type === "Repository" && (cm as Repository).name === name) return cm as Repository;
    }
    return undefined;
  };
  for (const m of ast.members) {
    if (m.$type === "BoundedContext") {
      const r = visit((m as BoundedContext).members);
      if (r) return r;
    } else if (m.$type === "System") {
      for (const sm of (m as System).members) {
        if (sm.$type === "BoundedContext") {
          const r = visit((sm as BoundedContext).members);
          if (r) return r;
        }
        if (sm.$type === "Module") {
          for (const c of (sm as Module).contexts) {
            const r = visit(c.members);
            if (r) return r;
          }
        }
      }
    }
  }
  return undefined;
}

function repositoryView(ast: Model, name: string): ViewGraph {
  const repo = findRepository(ast, name);
  if (!repo) return { title: `repository ${name}`, nodes: [], edges: [] };
  const items = repo.finds.map((f) => ({ id: nid("find", f.name), kind: "find" as const, name: f.name }));
  return { title: `repository ${name}`, nodes: layout(items, ["find"]), edges: [] };
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
    case "repository":
      return repositoryView(ast, last.name);
    default:
      // Other leaves (value object / event / repository / view / function / …)
      // still have no children to show — opt-in node-detail comes later.
      return { title: `${last.kind} ${last.name}`, nodes: [], edges: [] };
  }
}
