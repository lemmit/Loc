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
  EntityPart,
  EntityPartMember,
  Model,
  Subdomain,
  Operation,
  Repository,
  Statement,
  System,
  SystemMember,
  Workflow,
} from "../../../../src/language/generated/ast.js";
import { isWorkflowCreateDecl } from "../../../../src/language/generated/ast.js";
import { deployableContexts, deployableServes, deployableTargets, deployableUi } from "../system/deployable-bindings";
import { computeAggregateRelations, computeEntityPartRelations } from "./aggregate-edges";
import { computeContextRelations } from "./context-edges";

export type ViewKind =
  // containers (drillable)
  | "system"
  | "subdomain"
  | "context"
  | "aggregate"
  | "entity"
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
  /** True for the synthesised "title" node that re-states the current view
   *  root at the top of the canvas (e.g. the aggregate node above its own
   *  fields). Not drillable, not editable — the pane renders it as a
   *  banner-styled construct with no rename/delete affordances. */
  isRoot?: boolean;
  /** Optional advisory marker rendered as a dimmed/dashed style + a small
   *  ⚠ icon, used to flag nodes whose presence in the model isn't actually
   *  wired up — e.g. an event that is declared but never emitted, a value
   *  object never referenced by any aggregate, etc. */
  unused?: boolean;
  /** Override the drill target for this node. When set, clicking the node
   *  pushes `drillTo` onto the path instead of `{kind, name}`. Used by
   *  Containment leaves whose visible name is the field-like identifier
   *  ("lines") but whose drill target is the entity it references
   *  (`{kind:"entity", name:"OrderLine"}`). */
  drillTo?: ViewStep;
}

/** Visual + semantic discriminator on an edge:
 *
 *   - "binding"    : a deployable's modules/serves/ui/targets ref (system view)
 *   - "next"       : statement → next statement (operation/workflow flow view)
 *   - "reads"      : an operation/derived/invariant/function references a field
 *   - "writes"     : an operation assigns a field
 *   - "constrains" : an invariant references a field
 *   - "emits"      : an operation emits an event
 *   - "contains"   : the synthesised root node owns this child (structural —
 *                    rendered as a faint backdrop so semantic edges remain
 *                    visually dominant)
 *
 *  The pane renders different stroke/colour/dashing per kind. Defaulting to
 *  `undefined` keeps backwards compatibility with pre-aggregate-edges callers. */
export type EdgeKind = "binding" | "next" | "reads" | "writes" | "constrains" | "emits" | "contains";

export interface VEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  kind?: EdgeKind;
  /** Override the source-side handle. Used by `contains` edges so they leave
   *  the LEFT / RIGHT / BOTTOM of the root banner. Defaults to the source's
   *  unkeyed handle when omitted — but the root banner exposes multiple
   *  source handles, so callers are explicit. */
  sourceHandle?: "left" | "right" | "bottom";
}

export interface ViewGraph {
  /** Crumb label for the *current* level (the last path step, or "Model"). */
  title: string;
  nodes: VNode[];
  edges: VEdge[];
}

const DRILLABLE: ReadonlySet<ViewKind> = new Set([
  "system",
  "subdomain",
  "context",
  "aggregate",
  "entity",
  "operation",
  "workflow",
  "repository",
  // Containment leaves drill into the entity they reference (see VNode.drillTo).
  "containment",
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

/** Pixel gap above row-0 where the title node sits. Sized so the smoothstep
 *  fork from the root banner (whose horizontal segment lands ~20-30 px below
 *  the source handle) is fully visible BEFORE the first child row — otherwise
 *  the topmost child (e.g. the workflow row in the context view) sits on top
 *  of the fork and hides where the contains edges branch out. */
const TITLE_Y_OFFSET = 200;

/** ViewKinds that act as the *structural pivot* of their containing view —
 *  the "core" children of the root (context → workflows + aggregates,
 *  aggregate → state fields, module → contexts, repository → finds,
 *  system → modules). These get centre-routed `contains` edges so the
 *  root↔pivot link forms the visible structural backbone; the supporting /
 *  infrastructure tiers (repos, views, events) side-route around. */
const PIVOT_CONTAINS_KINDS: ReadonlySet<ViewKind> = new Set<ViewKind>([
  "workflow",
  "aggregate",
  "field",
  "containment",
  "subdomain",
  "context",
  "find",
]);

/** ViewKinds for which we skip the `contains` backdrop entirely. These
 *  children belong to the container, but their position in the layout (left
 *  sidebar for repos/views) or their downstream relationship to another tree
 *  node (events are emitted by aggregates already) makes the root→child link
 *  visually redundant — drawing it just crowds the view. */
const NO_CONTAINS_KINDS: ReadonlySet<ViewKind> = new Set<ViewKind>([
  "event",
  "repository",
  "valueobject",
]);

/** Synthesize a "title" VNode for the current path leaf AND a backdrop of
 *  `contains` edges from it to its children — the structural cue that
 *  everything below is "inside" the current container. Children at the top
 *  tier get the full set; lower-tier children connect only if `connectAll`
 *  is true (most views set it, the linear stmtFlow leaves only stmt:0
 *  attached to keep the flow chain visually clean).
 *
 *  Centred over the children's bounding box and parked above row 0. The id is
 *  prefixed with `root:` so it can never collide with a real child id. */
function withRoot(
  g: ViewGraph,
  kind: ViewKind,
  name: string,
  opts: { connectAll?: boolean } = {},
): ViewGraph {
  const rootId = `root:${kind}:${name}`;
  if (g.nodes.length === 0) {
    return {
      ...g,
      nodes: [{ id: rootId, kind, name, x: 0, y: 0, drillable: false, isRoot: true }],
    };
  }
  const xs = g.nodes.map((n) => n.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...g.nodes.map((n) => n.y));
  const shifted = g.nodes.map((n) => ({ ...n, y: n.y - minY + TITLE_Y_OFFSET }));
  const rootNode: VNode = {
    id: rootId,
    kind,
    name,
    x: Math.round((minX + maxX) / 2),
    y: 0,
    drillable: false,
    isRoot: true,
  };
  // Decide which children get a containment edge from the root. The
  // `connectAll` option fans an edge out to every member (default for the
  // structural views — aggregate/context/system/module/repository); the
  // statement-flow views keep the chain visually clean by linking only the
  // first statement and letting `next` edges carry the rest.
  const targets = opts.connectAll
    ? shifted
    : shifted.filter((n) => n.y === Math.min(...shifted.map((s) => s.y)));
  // Two routing styles for the `contains` backdrop, plus a skip list for the
  // ones that would just add noise:
  //   - PIVOT children (workflow + aggregate + valueobject in the context view;
  //     fields / containments in the aggregate view; modules / contexts in the
  //     system view; finds in the repository view) get a straight-down edge
  //     from the root's BOTTOM handle. This keeps the primary structural link
  //     visually prominent in the centre column.
  //   - Anything else gets routed via the root's LEFT/RIGHT handle as a faint
  //     smoothstep tracing the periphery.
  //   - NO_CONTAINS kinds (events emitted by aggregates, repositories living
  //     in the side support column) are omitted entirely — their containment
  //     is already obvious from the layout / from the semantic edges
  //     converging on them.
  const containsEdges: VEdge[] = targets
    .filter((n) => !NO_CONTAINS_KINDS.has(n.kind))
    .map((n) => ({
      id: `contains:${rootId}->${n.id}`,
      source: rootId,
      target: n.id,
      kind: "contains",
      // Pivot children attach to the explicit BOTTOM handle (the structural
      // spine); the rest exit through LEFT / RIGHT. Being explicit avoids
      // React Flow guessing when several source handles are exposed.
      sourceHandle: PIVOT_CONTAINS_KINDS.has(n.kind)
        ? "bottom"
        : n.x < rootNode.x
          ? "left"
          : "right",
    }));
  return { ...g, nodes: [rootNode, ...shifted], edges: [...containsEdges, ...g.edges] };
}

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
  "subdomain",
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
      case "Subdomain":
        items.push({ id: nid("subdomain", childName), kind: "subdomain", name: childName });
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
    for (const ctx of deployableContexts(d))
      edges.push({ id: `bind:${src}->context:${ctx}`, source: src, target: nid("context", ctx), label: "contexts", kind: "binding" });
    for (const api of deployableServes(d))
      edges.push({ id: `bind:${src}->api:${api}`, source: src, target: nid("api", api), label: "serves", kind: "binding" });
    const ui = deployableUi(d);
    if (ui) edges.push({ id: `bind:${src}->ui:${ui}`, source: src, target: nid("ui", ui), label: "ui", kind: "binding" });
    const tgt = deployableTargets(d);
    if (tgt) edges.push({ id: `bind:${src}->deployable:${tgt}`, source: src, target: nid("deployable", tgt), label: "targets", kind: "binding" });
  }
  return withRoot(
    { title: `system ${name}`, nodes: layout(items, SYSTEM_ORDER), edges },
    "system",
    name,
    { connectAll: true },
  );
}

function subdomainView(ast: Model, name: string): ViewGraph {
  let sub: Subdomain | undefined;
  for (const m of ast.members) {
    if (m.$type === "System") {
      for (const sm of (m as System).members) {
        if (sm.$type === "Subdomain" && (sm as Subdomain).name === name) sub = sm as Subdomain;
      }
    }
  }
  if (!sub) return { title: name, nodes: [], edges: [] };
  const items = sub.contexts.map((c) => ({ id: nid("context", c.name), kind: "context" as const, name: c.name }));
  return withRoot(
    { title: `subdomain ${name}`, nodes: layout(items, ["context"]), edges: [] },
    "subdomain",
    name,
    { connectAll: true },
  );
}

// Vertical (top→bottom) tier order for the context view's main tree.
// Repositories live OUTSIDE this tree in a left-side support column (see
// SIDEBAR_KINDS) — they're DDD infrastructure, not the centre of business
// behaviour, so the tree focuses on workflows → aggregates → events.
//
// Row 0: workflow      (orchestrators)
// Row 1: aggregate     (the core model — value objects float in the right side column)
// Row 2: event          (outcomes)
const CONTEXT_TIER: Partial<Record<ViewKind, number>> = {
  workflow: 0,
  aggregate: 1,
  event: 2,
};

/** ViewKinds rendered as side support columns instead of a tier of the main
 *  tree. The LEFT column holds infrastructure (repositories) that
 *  feeds the domain. The RIGHT column holds auxiliary domain types
 *  (value objects) — they tend to be widely re-used by aggregates, so
 *  inlining them into the tree would spray edges everywhere; parking them
 *  in a side column keeps the central tree readable. Semantic edges still
 *  cross from these sidebars into the tree, visibly showing what supports
 *  which aggregate. */
const LEFT_SIDEBAR_KINDS: ReadonlySet<ViewKind> = new Set<ViewKind>([
  "repository",
]);
const RIGHT_SIDEBAR_KINDS: ReadonlySet<ViewKind> = new Set<ViewKind>([
  "valueobject",
]);
const SIDEBAR_KINDS: ReadonlySet<ViewKind> = new Set<ViewKind>([
  ...LEFT_SIDEBAR_KINDS,
  ...RIGHT_SIDEBAR_KINDS,
]);

const CONTEXT_KIND: Partial<Record<string, ViewKind>> = {
  Aggregate: "aggregate",
  ValueObject: "valueobject",
  EventDecl: "event",
  Repository: "repository",
  Workflow: "workflow",
};

const CTX_COL_W = 220;
const CTX_ROW_H = 160;

/** Tier-rowed layout: nodes group into horizontal rows by `CONTEXT_TIER` and
 *  are spread along X. Pivot column is `aggregate` (tier 1); consumers (tier 0)
 *  and outcomes (tier 2) align their X to the average X of the aggregates
 *  they reference. Same row-alignment trick as before, just rotated 90°. */
function contextLayout(
  items: { id: string; kind: ViewKind; name: string; anchors?: string[]; unused?: boolean }[],
): VNode[] {
  // Split the children into the main tree vs the left-side support column.
  // Sidebar items (repositories) sit OUTSIDE the tree at a fixed X
  // offset; the tier layout below only runs over tree items, so workflows
  // and aggregates aren't pulled left by anchors pointing into the sidebar.
  const treeItems = items.filter((i) => !SIDEBAR_KINDS.has(i.kind));
  const sidebarItems = items.filter((i) => SIDEBAR_KINDS.has(i.kind));

  const byTier = new Map<number, typeof items>();
  for (const it of treeItems) {
    const tier = CONTEXT_TIER[it.kind] ?? 0;
    const list = byTier.get(tier);
    if (list) list.push(it);
    else byTier.set(tier, [it]);
  }
  // Pass 1: place the aggregate-tier first — it defines the X coordinates
  // everyone else aligns to. Aggregates come first so they sit to the left of
  // any value objects in the same tier.
  const aggregateTier = CONTEXT_TIER.aggregate ?? 1;
  const aggregates = (byTier.get(aggregateTier) ?? []).filter((i) => i.kind === "aggregate");
  const peers = (byTier.get(aggregateTier) ?? []).filter((i) => i.kind !== "aggregate");
  const placed = new Map<string, { x: number; y: number }>();
  // Name → X for every node already placed (not just aggregates). Anchors
  // resolve against this so a workflow can centre over a repo, an event can
  // centre over an aggregate, etc.
  const placedX = new Map<string, number>();
  let col = 0;
  for (const a of aggregates) {
    placed.set(a.id, { x: col * CTX_COL_W, y: aggregateTier * CTX_ROW_H });
    placedX.set(a.name, col * CTX_COL_W);
    col++;
  }
  for (const p of peers) {
    placed.set(p.id, { x: col * CTX_COL_W, y: aggregateTier * CTX_ROW_H });
    placedX.set(p.name, col * CTX_COL_W);
    col++;
  }
  // Pass 2: place each non-pivot tier in order of distance from pivot so an
  // outer-tier anchor (e.g. workflow → repository) lands on already-placed X.
  // Tiers ABOVE the pivot snap their X into HALF-COLUMN slots offset from the
  // aggregate grid (so a workflow centred over Account doesn't sit on the
  // same column the pivot's `contains` edge needs to drop through to reach
  // Account). Tiers BELOW the pivot (events) align to the same column grid
  // as their anchor — the agg→event edge then comes straight down.
  const otherTiers = [...byTier.keys()]
    .filter((t) => t !== aggregateTier)
    .sort((a, b) => Math.abs(a - aggregateTier) - Math.abs(b - aggregateTier));
  for (const tier of otherTiers) {
    const bucket = byTier.get(tier)!;
    const taken = new Set<number>();
    let nextCol = 0;
    const useHalfOffset = tier < aggregateTier;
    const snapOffset = useHalfOffset ? CTX_COL_W / 2 : 0;
    // Anchored first so they grab their preferred X; free nodes fill gaps.
    const ordered = [...bucket].sort((a, b) =>
      Number(Boolean(b.anchors?.length)) - Number(Boolean(a.anchors?.length)),
    );
    for (const it of ordered) {
      let x: number;
      const anchored = it.anchors?.map((n) => placedX.get(n)).filter((v): v is number => v !== undefined) ?? [];
      if (anchored.length > 0) {
        const avg = Math.round(anchored.reduce((a, b) => a + b, 0) / anchored.length);
        // Snap to an unused slot near `avg`. For above-pivot tiers the slots
        // sit at (n + 0.5) × CTX_COL_W so workflow centres land BETWEEN
        // aggregate columns instead of on top of them.
        let slot = Math.round((avg - snapOffset) / CTX_COL_W);
        while (taken.has(slot)) slot++;
        x = slot * CTX_COL_W + snapOffset;
        taken.add(slot);
      } else {
        while (taken.has(nextCol)) nextCol++;
        x = nextCol * CTX_COL_W + snapOffset;
        taken.add(nextCol);
        nextCol++;
      }
      placed.set(it.id, { x, y: tier * CTX_ROW_H });
      placedX.set(it.name, x);
    }
  }
  // Pass 3: the supporting sidebar columns. Left holds infrastructure (repos
  // / views) feeding the domain; right holds widely-reused auxiliary domain
  // types (value objects). Both stack vertically at a fixed offset from the
  // tree, centred over the tree's vertical mid-line. Their X becomes
  // available to anchors (e.g. workflow→repo semantic edges), but they
  // weren't included in tree placement so workflows stay centred over the
  // aggregates they touch rather than being pulled toward a sidebar.
  const treeXs = [...placed.values()].map((p) => p.x);
  const treeYs = [...placed.values()].map((p) => p.y);
  const treeMidY = treeYs.length > 0 ? (Math.min(...treeYs) + Math.max(...treeYs)) / 2 : 0;
  const treeMaxX = treeXs.length > 0 ? Math.max(...treeXs) : 0;
  const placeSidebar = (
    bucket: { id: string; name: string }[],
    sideX: number,
  ): void => {
    if (bucket.length === 0) return;
    const height = (bucket.length - 1) * CTX_ROW_H;
    const startY = Math.round(treeMidY - height / 2);
    for (let i = 0; i < bucket.length; i++) {
      const it = bucket[i]!;
      const y = startY + i * CTX_ROW_H;
      placed.set(it.id, { x: sideX, y });
      placedX.set(it.name, sideX);
    }
  };
  placeSidebar(
    sidebarItems.filter((i) => LEFT_SIDEBAR_KINDS.has(i.kind)),
    -Math.round(CTX_COL_W * 1.4),
  );
  placeSidebar(
    sidebarItems.filter((i) => RIGHT_SIDEBAR_KINDS.has(i.kind)),
    treeMaxX + Math.round(CTX_COL_W * 1.4),
  );
  return items.map((it) => ({
    id: it.id,
    kind: it.kind,
    name: it.name,
    x: placed.get(it.id)!.x,
    y: placed.get(it.id)!.y,
    drillable: DRILLABLE.has(it.kind),
    ...(it.unused ? { unused: true } : {}),
  }));
}

function contextView(ast: Model, name: string): ViewGraph {
  // Find by walking; contexts can live at Model level (legacy) or in a Subdomain.
  let ctx: BoundedContext | undefined;
  for (const m of ast.members) {
    if (m.$type === "BoundedContext" && (m as BoundedContext).name === name) {
      ctx = m as BoundedContext;
    } else if (m.$type === "System") {
      for (const sm of (m as System).members) {
        if (sm.$type === "BoundedContext" && (sm as BoundedContext).name === name) ctx = sm as BoundedContext;
        if (sm.$type === "Subdomain") {
          for (const c of (sm as Subdomain).contexts) if (c.name === name) ctx = c;
        }
      }
    }
  }
  if (!ctx) return { title: name, nodes: [], edges: [] };
  const rel = computeContextRelations(ctx);
  // Build the raw item list with optional `anchors` (multi-valued) so non-
  // aggregate nodes can centre over the aggregate(s) they reference: repos
  // to their single source aggregate, workflows to every aggregate they
  // touch, events to every aggregate that emits them.
  // Set of every event name reached by an `emits` edge — either from an
  // aggregate operation or from a workflow body. Anything declared but absent
  // here is "unused" and gets a dimmed/dashed style in the layout below.
  const emittedEvents = new Set<string>();
  for (const set of rel.emits.values()) for (const ev of set) emittedEvents.add(ev);
  for (const set of rel.workflowEmits.values()) for (const ev of set) emittedEvents.add(ev);

  const items: { id: string; kind: ViewKind; name: string; anchors?: string[]; unused?: boolean }[] = [];
  for (const m of ctx.members as ContextMember[]) {
    const kind = CONTEXT_KIND[m.$type];
    const childName = (m as { name?: string }).name;
    if (!kind || !childName) continue;
    let anchors: string[] | undefined;
    let unused: boolean | undefined;
    if (kind === "repository") {
      const a = rel.repoFor.get(childName);
      if (a) anchors = [a];
    } else if (kind === "workflow") {
      // Anchor a workflow over the aggregates it touches — directly via
      // `workflowUses`, and transitively via `workflowUsesRepo` (a repo
      // `Accounts.getById(x)` resolves to `Account` via `repoFor`). Repos
      // themselves live in the sidebar; anchoring straight to them would
      // pull the workflow sideways out of the tree, so we follow the repo
      // through to the aggregate it serves instead.
      const anchorSet = new Set<string>();
      for (const a of rel.workflowUses.get(childName) ?? []) anchorSet.add(a);
      for (const r of rel.workflowUsesRepo.get(childName) ?? []) {
        const agg = rel.repoFor.get(r);
        if (agg) anchorSet.add(agg);
      }
      if (anchorSet.size > 0) anchors = [...anchorSet];
    } else if (kind === "event") {
      // Anchor an event to every aggregate that emits it — the layout
      // averages their X so the event sits between its sources.
      const emitters: string[] = [];
      for (const [aggName, set] of rel.emits) if (set.has(childName)) emitters.push(aggName);
      if (emitters.length > 0) anchors = emitters;
      // Mark events that are declared but never emitted by any aggregate
      // operation or workflow. Surfaces dead-event holes in the model.
      if (!emittedEvents.has(childName)) unused = true;
    }
    items.push({ id: nid(kind, childName), kind, name: childName, anchors, unused });
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
  for (const [wf, set] of rel.workflowUsesRepo) {
    for (const repo of set) {
      edges.push({
        id: `wf-uses-repo:${wf}->${repo}`,
        source: nid("workflow", wf),
        target: nid("repository", repo),
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
  return withRoot(
    { title: `context ${name}`, nodes: contextLayout(items), edges },
    "context",
    name,
    { connectAll: true },
  );
}

// Vertical (top→bottom) tier order for the aggregate view. Consumers feed
// *down* into state; the React Flow nodes' Top/Bottom handles produce
// natural vertical edges with no curl.
//
//   Row 0:  invariant | operation | function | derived  (consumers / constraints)
//   Row 1:  field | containment                          (state — the leaf of every edge)
//
// Consumers' X aligns to the average X of the fields they touch — same
// row-alignment trick as the context view, rotated to use X instead of Y.
const AGGREGATE_TIER: Partial<Record<ViewKind, number>> = {
  invariant: 0,
  operation: 0,
  function: 0,
  derived: 0,
  field: 1,
  containment: 1,
};

const AGG_COL_W = 200;
const AGG_ROW_H = 200;

interface RawAggNode {
  id: string;
  kind: ViewKind;
  name: string;
  /** field-name set this consumer reads (operations / derived / invariants /
   *  functions). Empty for fields/containments themselves. */
  readsOf: ReadonlySet<string>;
  /** Override drill target — Containment nodes drill into the entity their
   *  `partType` references rather than into themselves. */
  drillTo?: ViewStep;
}

/** Tier-rowed layout with consumer-to-state X alignment. State (row 1) is
 *  placed first to fix the X grid; consumers (row 0) centre over the average
 *  X of the fields they read, with column collisions bumped to the next free
 *  slot. */
function aggregateLayout(items: RawAggNode[]): VNode[] {
  const placed = new Map<string, { x: number; y: number }>();
  const fieldX = new Map<string, number>();
  // Pass 1: state tier (fields then containments) along the bottom row.
  const stateNodes = items.filter((i) => AGGREGATE_TIER[i.kind] === 1);
  let col = 0;
  for (const s of stateNodes) {
    const x = col * AGG_COL_W;
    placed.set(s.id, { x, y: 1 * AGG_ROW_H });
    fieldX.set(s.name, x);
    col++;
  }
  // Pass 2: consumer tier (top row), aligned to fields they touch.
  const consumers = items.filter((i) => AGGREGATE_TIER[i.kind] === 0);
  const taken = new Set<number>();
  // Anchored consumers first so they grab their preferred X; free consumers
  // fill the remaining slots from the left.
  const ordered = [...consumers].sort((a, b) => b.readsOf.size - a.readsOf.size);
  let nextCol = 0;
  for (const c of ordered) {
    const xs: number[] = [];
    for (const r of c.readsOf) {
      const x = fieldX.get(r);
      if (x !== undefined) xs.push(x);
    }
    let slot: number;
    if (xs.length > 0) {
      const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
      slot = Math.round(avg / AGG_COL_W);
      while (taken.has(slot)) slot++;
    } else {
      while (taken.has(nextCol)) nextCol++;
      slot = nextCol;
      nextCol++;
    }
    taken.add(slot);
    placed.set(c.id, { x: slot * AGG_COL_W, y: 0 });
  }
  return items.map((it) => ({
    id: it.id,
    kind: it.kind,
    name: it.name,
    x: placed.get(it.id)!.x,
    y: placed.get(it.id)!.y,
    drillable: DRILLABLE.has(it.kind),
    ...(it.drillTo ? { drillTo: it.drillTo } : {}),
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
        if (sm.$type === "Subdomain") {
          for (const c of (sm as Subdomain).contexts) {
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
      case "Containment": {
        // Show the entity type next to the field name so the user can see what
        // kind of thing the containment composes ("lines : OrderLine"). The
        // drill target is the entity itself, so clicking the containment
        // opens that entity's structure.
        const part = (m as { partType?: { $refText?: string } }).partType?.$refText;
        items.push({
          id: nid("containment", childName!),
          kind: "containment",
          name: part ? `${childName} : ${part}` : childName!,
          readsOf: EMPTY,
          ...(part ? { drillTo: { kind: "entity" as const, name: part } } : {}),
        });
        break;
      }
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
  // then materialise edges with the correct target id. We parse the canonical
  // identifier out of the node id (after the kind prefix) since some display
  // names — containments render as `"lines : OrderLine"` — diverge from it.
  const stateIdByName = new Map<string, string>();
  for (const i of items) {
    if (i.kind === "field" || i.kind === "containment" || i.kind === "derived") {
      const canonical = i.id.slice(i.id.indexOf(":") + 1);
      stateIdByName.set(canonical, i.id);
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

  return withRoot(
    { title: `aggregate ${name}`, nodes: aggregateLayout(items), edges },
    "aggregate",
    name,
    { connectAll: true },
  );
}

const EMPTY: ReadonlySet<string> = new Set();

/** Walk the model to find an EntityPart by name. Entity parts live directly
 *  under aggregates; we search every aggregate we can reach. (Names can
 *  collide across aggregates — the drill path establishes which aggregate
 *  we're inside, but for v1 we just take the first match, which is right in
 *  every example we ship.) */
function findEntityPart(ast: Model, name: string): EntityPart | undefined {
  for (const m of ast.members) {
    if (m.$type === "BoundedContext") {
      for (const cm of m.members) {
        if (cm.$type === "Aggregate") {
          for (const am of cm.members) if (am.$type === "EntityPart" && am.name === name) return am;
        }
      }
    } else if (m.$type === "System") {
      for (const sm of m.members) {
        if (sm.$type === "BoundedContext") {
          for (const cm of sm.members) {
            if (cm.$type === "Aggregate") {
              for (const am of cm.members) if (am.$type === "EntityPart" && am.name === name) return am;
            }
          }
        } else if (sm.$type === "Subdomain") {
          for (const c of sm.contexts) {
            for (const cm of c.members) {
              if (cm.$type === "Aggregate") {
                for (const am of cm.members) if (am.$type === "EntityPart" && am.name === name) return am;
              }
            }
          }
        }
      }
    }
  }
  return undefined;
}

/** Mirror of `aggregateView` for an EntityPart. Entities have no operations
 *  (no writes / emits), but their `derived` / `invariant` / `function`
 *  bodies still read fields/containments — those edges are computed by
 *  `computeEntityPartRelations`. Layout / containment rules are identical
 *  to aggregateView. */
function entityView(ast: Model, name: string): ViewGraph {
  const part = findEntityPart(ast, name);
  if (!part) return { title: `entity ${name}`, nodes: [], edges: [] };
  const rel = computeEntityPartRelations(part);
  const items: RawAggNode[] = [];
  for (const m of part.members as EntityPartMember[]) {
    const childName = (m as { name?: string }).name;
    if (!childName && m.$type !== "Invariant") continue;
    switch (m.$type) {
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
      case "Containment": {
        const partType = (m as { partType?: { $refText?: string } }).partType?.$refText;
        items.push({
          id: nid("containment", childName!),
          kind: "containment",
          name: partType ? `${childName} : ${partType}` : childName!,
          readsOf: EMPTY,
          ...(partType ? { drillTo: { kind: "entity" as const, name: partType } } : {}),
        });
        break;
      }
    }
  }
  let invariantIndex = 0;
  for (const m of part.members as EntityPartMember[]) {
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

  const stateIdByName = new Map<string, string>();
  for (const i of items) {
    if (i.kind === "field" || i.kind === "containment" || i.kind === "derived") {
      const canonical = i.id.slice(i.id.indexOf(":") + 1);
      stateIdByName.set(canonical, i.id);
    }
  }
  const edges: VEdge[] = [];
  const pushFieldEdges = (
    rel: ReadonlyMap<string, Set<string>>,
    kind: "reads" | "constrains",
  ): void => {
    for (const [src, set] of rel) {
      for (const f of set) {
        const target = stateIdByName.get(f);
        if (!target) continue;
        edges.push({ id: `${kind}:${src}->${target}`, source: src, target, label: kind, kind });
      }
    }
  };
  const invariantReads = new Map<string, Set<string>>();
  const consumerReads = new Map<string, Set<string>>();
  for (const [src, set] of rel.reads) {
    (src.startsWith("invariant:") ? invariantReads : consumerReads).set(src, set);
  }
  pushFieldEdges(invariantReads, "constrains");
  pushFieldEdges(consumerReads, "reads");

  return withRoot(
    { title: `entity ${name}`, nodes: aggregateLayout(items), edges },
    "entity",
    name,
    { connectAll: true },
  );
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
        if (sm.$type === "Subdomain") {
          for (const c of (sm as Subdomain).contexts) {
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
        if (sm.$type === "Subdomain") {
          for (const c of (sm as Subdomain).contexts) {
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
function stmtFlow(title: string, body: Statement[], rootKind: ViewKind, rootName: string): ViewGraph {
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
  return withRoot({ title, nodes, edges }, rootKind, rootName);
}

function operationView(ast: Model, aggName: string, opName: string): ViewGraph {
  const agg = findAggregate(ast, aggName);
  const op = agg?.members.find(
    (m): m is Operation => m.$type === "Operation" && (m as Operation).name === opName,
  );
  if (!op) return { title: `${aggName}.${opName}`, nodes: [], edges: [] };
  return stmtFlow(`${aggName}.${opName}()`, op.body, "operation", `${aggName}.${opName}()`);
}

function workflowView(ast: Model, name: string): ViewGraph {
  const wf = findWorkflow(ast, name);
  if (!wf) return { title: `workflow ${name}`, nodes: [], edges: [] };
  // A2-S5f: sequential statements live in the primary `create(...)` starter.
  const creates = wf.members.filter(isWorkflowCreateDecl);
  const stmts = (creates.find((c) => !c.name) ?? creates[0])?.body ?? [];
  return stmtFlow(`workflow ${name}()`, stmts, "workflow", `${name}()`);
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
        if (sm.$type === "Subdomain") {
          for (const c of (sm as Subdomain).contexts) {
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
  return withRoot(
    { title: `repository ${name}`, nodes: layout(items, ["find"]), edges: [] },
    "repository",
    name,
    { connectAll: true },
  );
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
    case "subdomain":
      return subdomainView(ast, last.name);
    case "context":
      return contextView(ast, last.name);
    case "aggregate":
      return aggregateView(ast, last.name);
    case "entity":
      return entityView(ast, last.name);
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
      // Other leaves (value object / event / repository / function / …)
      // still have no children to show — opt-in node-detail comes later.
      return { title: `${last.kind} ${last.name}`, nodes: [], edges: [] };
  }
}
