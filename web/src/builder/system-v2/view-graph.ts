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
  Apply,
  AuthBlock,
  BoundedContext,
  Capability,
  Channel,
  ChannelSource,
  CommandHandler,
  Containment,
  ContextMember,
  Create,
  Criterion,
  Deployable,
  Destroy,
  DomainService,
  EntityPart,
  EntityPartMember,
  EnumDecl,
  FilterDecl,
  ImplementsDecl,
  Layout,
  Migration,
  Model,
  PayloadDecl,
  PermissionsBlock,
  PolicyDecl,
  PolicyReadRule,
  Projection,
  ProjectionOn,
  Property,
  QueryHandler,
  Resource,
  Retrieval,
  Seed,
  StampDecl,
  Subdomain,
  Operation,
  Repository,
  Statement,
  System,
  SystemMember,
  TenancyDecl,
  TestBlock,
  TestE2E,
  ThemeBlock,
  TimerSource,
  Unique,
  UserBlock,
  Workflow,
} from "../../../../src/language/generated/ast.js";
import { spliceNodeIfParses } from "../edit-engine";
import { parseDdd } from "../parse";
import { listBodies, workflowBodyStatements, type BodyKey } from "../system/body";
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
  // read-only containers with a shallow drill-in of their own members
  | "domainservice"
  | "projection"
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
  | "deployable"
  // ---- read-only construct leaves (no drill-in, no edit affordances) ----
  //
  // Everything the language declares that used to be silently dropped by the
  // per-level collectors. They render as construct cards carrying a kind
  // label, the declared name and a few derived `summary` lines.
  //
  // context members:
  | "channel"
  | "criterion"
  | "retrieval"
  | "payload"
  | "enum"
  | "seed"
  | "commandhandler"
  | "queryhandler"
  | "policy"
  | "filter"
  | "stamp"
  | "implements"
  | "test"
  // system members:
  | "tenancy"
  | "auth"
  | "user"
  | "theme"
  | "resource"
  | "channelsource"
  | "timer"
  | "capability"
  | "layout"
  | "teste2e"
  // model (root) members:
  | "migration"
  // subdomain members:
  | "permissions"
  // aggregate members:
  | "create"
  | "destroy"
  | "apply"
  | "unique"
  | "with"
  // domain-service drill-in leaf:
  | "dsoperation";

/** A small chip pinned to a construct node — the visual cue that the
 *  construct carries an authorization gate (`requires` / `when`) or a
 *  field-level read redaction (`mask unless`). `detail` is the full source
 *  text of the guarding expression, surfaced as the chip's tooltip. */
export interface VBadge {
  label: "requires" | "when" | "mask";
  detail: string;
}

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
  /** Read-only detail lines rendered under the node's name — the derived
   *  summary of a construct that has no drill-in of its own (a projection's
   *  `from`/`join`/`select`, a channel's carried events, a policy's read
   *  ladder, …). Purely a function of the AST; never editable. */
  summary?: string[];
  /** Authorization / redaction chips (see `VBadge`). */
  badges?: VBadge[];
}

/** Pre-layout node record produced by the per-level collectors. The layout
 *  functions add coordinates + `drillable`; everything else passes through. */
interface RawItem {
  id: string;
  kind: ViewKind;
  name: string;
  summary?: string[];
  badges?: VBadge[];
}

/** Spread the pass-through detail of a `RawItem` onto a laid-out `VNode`,
 *  omitting the keys that carry nothing (so node objects stay comparable in
 *  the tests and React Flow doesn't see churny `undefined` props). */
const detailOf = (it: { summary?: string[]; badges?: VBadge[] }): Partial<VNode> => ({
  ...(it.summary && it.summary.length > 0 ? { summary: it.summary } : {}),
  ...(it.badges && it.badges.length > 0 ? { badges: it.badges } : {}),
});

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
  // Read-only drill-ins: a domain service opens its operation list, a
  // projection opens its row fields + `on(...)` folds. Both are leaf-only —
  // nothing below them is editable.
  "domainservice",
  "projection",
]);

const COL_W = 220;
const ROW_H = 90;

/** Place nodes in column-per-kind order; nodes of the same kind stack
 *  vertically. Stable, deterministic — Phase 1 is purely derived layout. */
function layout(raw: RawItem[], kindOrder: readonly ViewKind[]): VNode[] {
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
      ...detailOf(n),
    };
  });
}

const nid = (kind: ViewKind, name: string): string => `${kind}:${name}`;

// ---------------------------------------------------------------------------
// Read-only construct detail
//
// Everything below turns one declaration into a `RawItem` — kind label, name
// and a handful of derived summary lines. These are the constructs the
// per-level collectors used to drop on the floor: they have no drill-in tree
// of their own, so instead of a node with just a name they carry the two or
// three facts that make the declaration recognisable at a glance (a channel's
// carried events, a policy's read ladder, a retrieval's `where`).
//
// Detail is read STRAIGHT off the CST — every fragment we show already exists
// verbatim in the source, so there is no re-printing to keep in sync with the
// grammar (the `derive, don't stamp` rule applied to the canvas).
// ---------------------------------------------------------------------------

/** Structural view of "any AST node" for the CST-text helpers — avoids
 *  importing langium's `AstNode` just to read `$cstNode.text`. */
interface HasCst {
  readonly $cstNode?: { readonly text?: string };
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const cstText = (n: HasCst | undefined): string => oneLine(n?.$cstNode?.text ?? "");

/** Elide a source fragment to a single node-width line. */
function preview(text: string, max = 44): string {
  const t = oneLine(text);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const exprPreview = (e: HasCst | undefined): string => preview(cstText(e));

/** `(a: int, b: string): Money` — rebuilt from the CST of each part so a
 *  signature line reads exactly as the user wrote it. */
const signature = (params: readonly HasCst[], returnType?: HasCst): string =>
  `(${params.map((p) => cstText(p)).join(", ")})${returnType ? `: ${cstText(returnType)}` : ""}`;

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

const badgesOf = (...maybe: (VBadge | undefined)[]): VBadge[] | undefined => {
  const out = maybe.filter((b): b is VBadge => b !== undefined);
  return out.length > 0 ? out : undefined;
};

/** `requires <expr>` gate → a 🔒 chip whose tooltip is the whole predicate. */
const gateBadge = (gate: HasCst | undefined): VBadge | undefined =>
  gate ? { label: "requires", detail: cstText(gate) } : undefined;

/** `mask unless <expr>` field read-redaction → a chip on the field leaf, so a
 *  redacted field is distinguishable from a plainly-readable one at a glance. */
const maskBadges = (p: Property): VBadge[] | undefined =>
  badgesOf(p.maskUnless ? { label: "mask", detail: `unless ${cstText(p.maskUnless)}` } : undefined);

/** `allow write deep on Order` / `deny on Invoice` — one policy ladder rung. */
const policyRuleText = (r: PolicyReadRule): string =>
  [r.effect, r.verb, r.effect === "allow" ? r.level : undefined, "on", r.target]
    .filter((part): part is string => Boolean(part))
    .join(" ");

/** Monotonic per-kind counter, so the unnamed constructs (`filter`, `stamp`,
 *  a block-form `policy`, `seed`, `unique`, a hoisted `test`) get collision-free
 *  node ids without inventing a name the source doesn't have. */
function counter(): (kind: string) => number {
  const seen = new Map<string, number>();
  return (kind) => {
    const n = seen.get(kind) ?? 0;
    seen.set(kind, n + 1);
    return n;
  };
}

/** `filter <expr>` — a capability query-filter. Unnamed, so the node carries a
 *  preview of the predicate as its label (same convention as `invariant`). */
const filterItem = (m: FilterDecl, index: number): RawItem => ({
  id: `filter:${index}`,
  kind: "filter",
  name: exprPreview(m.expr),
});

/** `stamp onCreate { … }` — labelled by the lifecycle event it stamps on. */
const stampItem = (m: StampDecl, index: number): RawItem => ({
  id: `stamp:${index}`,
  kind: "stamp",
  name: m.event,
  summary: [plural(m.assignments.length, "assignment")],
});

/** `implements <Capability>` — the typed capability application. */
const implementsItem = (m: ImplementsDecl): RawItem => ({
  id: nid("implements", m.cap),
  kind: "implements",
  name: m.cap,
});

/** A unit `test "…" { … }` block, wherever it was hoisted to. */
const testItem = (m: TestBlock, index: number): RawItem => ({
  id: `test:${index}`,
  kind: "test",
  name: m.name,
  summary: [
    ...(m.target ? [`for ${m.target.$refText}`] : []),
    plural(m.body.length, "step"),
  ],
});

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

const ROOT_ORDER: readonly ViewKind[] = ["system", "context", "migration"];

function rootView(ast: Model): ViewGraph {
  const items: RawItem[] = [];
  for (const m of ast.members) {
    if (m.$type === "System") {
      items.push({ id: nid("system", (m as System).name), kind: "system", name: (m as System).name });
    } else if (m.$type === "BoundedContext") {
      items.push({
        id: nid("context", (m as BoundedContext).name),
        kind: "context",
        name: (m as BoundedContext).name,
      });
    } else if (m.$type === "Migration") {
      // `migration "…" { rename … }` is a file-scope ledger block, deliberately
      // isolated from the domain model — so it belongs at the ROOT view beside
      // the systems, not inside one.
      const mig = m as Migration;
      items.push({
        id: nid("migration", mig.name),
        kind: "migration",
        name: mig.name,
        summary: [plural(mig.steps.length, "step")],
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
  // The system-scope declarations that carry no children of their own — one
  // column each, to the right of the deployment tier.
  "tenancy",
  "auth",
  "user",
  "theme",
  "resource",
  "channelsource",
  "timer",
  "capability",
  "layout",
  "teste2e",
];

function systemView(ast: Model, name: string): ViewGraph {
  const sys = ast.members.find((m): m is System => m.$type === "System" && (m as System).name === name);
  if (!sys) return { title: name, nodes: [], edges: [] };
  const items: RawItem[] = [];
  const deployables: Deployable[] = [];
  const next = counter();
  for (const m of sys.members as SystemMember[]) {
    const childName = (m as { name?: string }).name;
    switch (m.$type) {
      case "Subdomain":
        if (childName) items.push({ id: nid("subdomain", childName), kind: "subdomain", name: childName });
        break;
      case "BoundedContext":
        if (childName) items.push({ id: nid("context", childName), kind: "context", name: childName });
        break;
      case "Api":
        if (childName) items.push({ id: nid("api", childName), kind: "api", name: childName });
        break;
      case "Storage":
        if (childName) items.push({ id: nid("storage", childName), kind: "storage", name: childName });
        break;
      case "Ui":
        if (childName) items.push({ id: nid("ui", childName), kind: "ui", name: childName });
        break;
      case "Deployable":
        if (childName) {
          items.push({ id: nid("deployable", childName), kind: "deployable", name: childName });
          deployables.push(m as Deployable);
        }
        break;
      // ---- read-only system-scope declarations ------------------------
      case "TenancyDecl": {
        const t = m as TenancyDecl;
        items.push({
          id: `tenancy:${next("tenancy")}`,
          kind: "tenancy",
          name: "tenancy",
          summary: [`by user.${t.claim?.$refText ?? "?"}`, `of ${t.registry?.$refText ?? "?"}`],
        });
        break;
      }
      case "AuthBlock": {
        const a = m as AuthBlock;
        items.push({
          id: `auth:${next("auth")}`,
          kind: "auth",
          name: "auth",
          summary: [
            `provider: ${a.provider ?? "—"}`,
            `enforcement: ${a.enforcement ?? "—"}`,
            ...(a.sessions ? [`sessions: ${a.sessions}`] : []),
            ...(a.oidc ? ["oidc configured"] : []),
          ],
        });
        break;
      }
      case "UserBlock": {
        const u = m as UserBlock;
        items.push({
          id: `user:${next("user")}`,
          kind: "user",
          name: "user",
          summary: [plural(u.fields.length, "claim")],
        });
        break;
      }
      case "ThemeBlock": {
        const t = m as ThemeBlock;
        items.push({
          id: `theme:${next("theme")}`,
          kind: "theme",
          name: "theme",
          summary: [plural(t.props.length, "token"), ...(t.props.length > 0 ? [t.props.map((p) => p.name).join(", ")] : [])],
        });
        break;
      }
      case "Resource": {
        const r = m as Resource;
        items.push({
          id: nid("resource", r.name),
          kind: "resource",
          name: r.name,
          summary: [
            `kind: ${r.kind ?? "—"}`,
            ...(r.context ? [`for ${r.context.$refText}`] : []),
            ...(r.use ? [`use ${r.use.$refText}`] : []),
          ],
        });
        break;
      }
      case "ChannelSource": {
        const c = m as ChannelSource;
        items.push({
          id: nid("channelsource", c.name),
          kind: "channelsource",
          name: c.name,
          summary: [`for ${c.channel}`, ...(c.use ? [`use ${c.use.$refText}`] : [])],
        });
        break;
      }
      case "TimerSource": {
        const t = m as TimerSource;
        items.push({
          id: nid("timer", t.name),
          kind: "timer",
          name: t.name,
          summary: [
            `for ${t.event?.$refText ?? "?"}`,
            t.cron ? `cron ${t.cron}` : t.every ? `every ${t.every}` : "no cadence",
          ],
        });
        break;
      }
      case "Capability": {
        const c = m as Capability;
        items.push({
          id: nid("capability", c.name),
          kind: "capability",
          name: c.name,
          summary: [plural(c.members.length, "member")],
        });
        break;
      }
      case "Layout": {
        const l = m as Layout;
        items.push({
          id: nid("layout", l.name),
          kind: "layout",
          name: l.name,
          summary: [
            `slots: ${l.slots.map((s) => (s.$type === "LayoutMainSlot" ? "main" : s.name)).join(", ")}`,
          ],
        });
        break;
      }
      case "TestE2E": {
        const t = m as TestE2E;
        items.push({
          id: `teste2e:${next("teste2e")}`,
          kind: "teste2e",
          name: t.name,
          summary: [`against ${t.deployable?.$refText ?? "?"}`, plural(t.body.length, "step")],
        });
        break;
      }
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
  const items: RawItem[] = sub.contexts.map((c) => ({
    id: nid("context", c.name),
    kind: "context" as const,
    name: c.name,
  }));
  // A subdomain's `permissions { … }` catalogue is the root of the whole
  // authorization layer — every `requires permissions.x` gate elsewhere in the
  // model resolves here — so it gets its own node listing the catalogue,
  // `implies` closure included.
  sub.permissions.forEach((block: PermissionsBlock, i) => {
    items.push({
      id: `permissions:${i}`,
      kind: "permissions",
      name: "permissions",
      summary: block.decls.map((d) =>
        d.implies.length > 0
          ? `${d.name} implies ${d.implies.length === 1 ? d.implies[0] : `[${d.implies.join(", ")}]`}`
          : d.name,
      ),
    });
  });
  return withRoot(
    { title: `subdomain ${name}`, nodes: layout(items, ["context", "permissions"]), edges: [] },
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
// Row 3: the read-only declaration shelf — everything a context can declare
//        that isn't part of the workflow → aggregate → event spine (read
//        models, application handlers, specifications, payload/enum
//        vocabulary, capability clauses, seeds, policies, hoisted tests).
const CONTEXT_TIER: Partial<Record<ViewKind, number>> = {
  workflow: 0,
  aggregate: 1,
  event: 2,
  projection: 3,
  domainservice: 3,
  channel: 3,
  criterion: 3,
  retrieval: 3,
  payload: 3,
  enum: 3,
  seed: 3,
  commandhandler: 3,
  queryhandler: 3,
  policy: 3,
  filter: 3,
  stamp: 3,
  implements: 3,
  test: 3,
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
interface RawCtxNode extends RawItem {
  anchors?: string[];
  unused?: boolean;
}

function contextLayout(items: RawCtxNode[]): VNode[] {
  // Split the children into the main tree vs the left-side support column.
  // Sidebar items (repositories) sit OUTSIDE the tree at a fixed X
  // offset; the tier layout below only runs over tree items, so workflows
  // and aggregates aren't pulled left by anchors pointing into the sidebar.
  const treeItems = items.filter((i) => !SIDEBAR_KINDS.has(i.kind));
  const sidebarItems = items.filter((i) => SIDEBAR_KINDS.has(i.kind));

  const byTier = new Map<number, RawCtxNode[]>();
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
    ...detailOf(it),
  }));
}

/** Read-only nodes for the `ContextMember` kinds that have no drill-down tree
 *  of their own. Returns `undefined` for the five kinds the context view
 *  already models structurally (`CONTEXT_KIND`) — those keep their existing
 *  anchoring / edge behaviour. `next` supplies collision-free indices for the
 *  unnamed forms. */
function contextExtraItem(m: ContextMember, next: (kind: string) => number): RawItem | undefined {
  switch (m.$type) {
    case "Projection": {
      const p = m as Projection;
      const folds = p.members.filter((x) => x.$type === "ProjectionOn").length;
      return {
        id: nid("projection", p.name),
        kind: "projection",
        name: p.name,
        summary: [
          ...(p.source ? [`from ${p.source.$refText}${p.sourceAlias ? ` as ${p.sourceAlias}` : ""}`] : []),
          ...p.joins.map((j) => `join ${j.aggregate?.$refText ?? "?"} as ${j.alias}`),
          ...(p.selects.length > 0 ? [`select ${p.selects.map((s) => s.field).join(", ")}`] : []),
          ...(p.key ? [`keyed by ${p.key}`] : []),
          ...(folds > 0 ? [plural(folds, "fold")] : []),
        ],
        badges: badgesOf(gateBadge(p.gate)),
      };
    }
    case "DomainService": {
      const d = m as DomainService;
      return {
        id: nid("domainservice", d.name),
        kind: "domainservice",
        name: d.name,
        summary: [
          d.operations.length > 0
            ? `operations: ${d.operations.map((o) => o.name).join(", ")}`
            : "no operations",
          ...(d.tests.length > 0 ? [plural(d.tests.length, "test")] : []),
        ],
      };
    }
    case "Channel": {
      const c = m as Channel;
      return {
        id: nid("channel", c.name),
        kind: "channel",
        name: c.name,
        summary: [
          `carries: ${c.carries.map((r) => r.$refText).join(", ") || "—"}`,
          `delivery: ${c.delivery ?? "broadcast"}`,
          ...(c.retention ? [`retention: ${c.retention}`] : []),
          ...(c.key ? [`key: ${c.key}`] : []),
        ],
      };
    }
    case "Criterion": {
      const c = m as Criterion;
      return {
        id: nid("criterion", c.name),
        kind: "criterion",
        name: c.name,
        summary: [
          `of ${cstText(c.target)}`,
          ...(c.alias ? [`as ${c.alias}`] : []),
          `= ${exprPreview(c.body)}`,
        ],
      };
    }
    case "Retrieval": {
      const r = m as Retrieval;
      return {
        id: nid("retrieval", r.name),
        kind: "retrieval",
        name: r.name,
        summary: [
          `of ${cstText(r.target)}`,
          `where ${exprPreview(r.where)}`,
          ...(r.sort.length > 0 ? [plural(r.sort.length, "sort term")] : []),
          ...(r.loads.length > 0 ? [plural(r.loads.length, "load path")] : []),
        ],
      };
    }
    case "PayloadDecl": {
      const p = m as PayloadDecl;
      return {
        id: nid("payload", p.name),
        kind: "payload",
        name: p.name,
        summary: [
          `kind: ${p.kind}`,
          p.variants.length > 0
            ? `= ${p.variants.map((v) => cstText(v)).join(" | ")}`
            : plural(p.fields.length, "field"),
        ],
      };
    }
    case "EnumDecl": {
      const e = m as EnumDecl;
      return {
        id: nid("enum", e.name),
        kind: "enum",
        name: e.name,
        summary: [`cases: ${e.values.map((v) => v.name).join(", ")}`],
      };
    }
    case "Seed": {
      const s = m as Seed;
      return {
        id: `seed:${next("seed")}`,
        kind: "seed",
        name: s.dataset ?? "seed",
        summary: [plural(s.rows.length, "row"), ...(s.raw ? ["raw inserts"] : [])],
      };
    }
    case "CommandHandler":
    case "QueryHandler": {
      const h = m as CommandHandler | QueryHandler;
      const kind = m.$type === "CommandHandler" ? "commandhandler" : "queryhandler";
      return {
        id: nid(kind, h.name),
        kind,
        name: h.name,
        summary: [
          signature(h.params, h.returnType),
          h.extern ? "extern" : plural(h.body.length, "stmt"),
        ],
      };
    }
    case "PolicyDecl": {
      const p = m as PolicyDecl;
      return {
        id: p.name ? nid("policy", p.name) : `policy:${next("policy")}`,
        kind: "policy",
        name: p.name ?? "policy",
        summary: [
          // Function form carries a signature + expression body; block form
          // carries the allow/deny read ladder.
          ...(p.returnType ? [signature(p.params, p.returnType)] : []),
          ...(p.body ? [`= ${exprPreview(p.body)}`] : []),
          ...p.rules.map(policyRuleText),
        ],
      };
    }
    case "FilterDecl":
      return filterItem(m as FilterDecl, next("filter"));
    case "StampDecl":
      return stampItem(m as StampDecl, next("stamp"));
    case "ImplementsDecl":
      return implementsItem(m as ImplementsDecl);
    case "TestBlock":
      return testItem(m as TestBlock, next("test"));
    default:
      return undefined;
  }
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

  const items: RawCtxNode[] = [];
  const next = counter();
  for (const m of ctx.members as ContextMember[]) {
    const kind = CONTEXT_KIND[m.$type];
    const childName = (m as { name?: string }).name;
    if (!kind || !childName) {
      // Everything outside the workflow → aggregate → event spine lands on the
      // read-only declaration shelf (tier 3) instead of being dropped.
      const extra = contextExtraItem(m, next);
      if (extra) items.push(extra);
      continue;
    }
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
//   Row 2:  unique | with | filter | stamp | implements | test  (declarations —
//           neither state nor behaviour, so they get their own shelf below)
const AGGREGATE_TIER: Partial<Record<ViewKind, number>> = {
  invariant: 0,
  operation: 0,
  function: 0,
  derived: 0,
  // Lifecycle behaviour sits on the same consumer tier as `operation` — same
  // shape (params + a statement body), same relationship to state.
  create: 0,
  destroy: 0,
  apply: 0,
  field: 1,
  containment: 1,
  unique: 2,
  with: 2,
  filter: 2,
  stamp: 2,
  implements: 2,
  test: 2,
};

const AGG_COL_W = 200;
const AGG_ROW_H = 200;

interface RawAggNode extends RawItem {
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
  // Pass 3: the declaration shelf (tier 2+) and any kind the tier map doesn't
  // know about. Neither state nor consumer, so there's nothing to align to —
  // they just fill their row left→right. Keyed off "not yet placed" rather
  // than the tier number so a future kind can never fall through unpositioned.
  const shelfCol = new Map<number, number>();
  for (const it of items) {
    if (placed.has(it.id)) continue;
    const tier = AGGREGATE_TIER[it.kind] ?? 2;
    const col = shelfCol.get(tier) ?? 0;
    shelfCol.set(tier, col + 1);
    placed.set(it.id, { x: col * AGG_COL_W, y: tier * AGG_ROW_H });
  }
  return items.map((it) => ({
    id: it.id,
    kind: it.kind,
    name: it.name,
    x: placed.get(it.id)!.x,
    y: placed.get(it.id)!.y,
    drillable: DRILLABLE.has(it.kind),
    ...(it.drillTo ? { drillTo: it.drillTo } : {}),
    ...detailOf(it),
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
  const next = counter();
  // `with auditable, tenantOwned(...)` on the aggregate header — one compact
  // node listing the capability mixins, so the members the macro layer splices
  // in aren't attributed to thin air.
  if (agg.withClause && agg.withClause.calls.length > 0) {
    items.push({
      id: "with:0",
      kind: "with",
      name: "with",
      readsOf: EMPTY,
      summary: agg.withClause.calls.map((c) => cstText(c)),
    });
  }
  for (const m of agg.members as AggregateMember[]) {
    const childName = (m as { name?: string }).name;
    switch (m.$type) {
      case "Operation": {
        const op = m as Operation;
        if (!childName) break;
        items.push({
          id: nid("operation", childName),
          kind: "operation",
          name: childName,
          readsOf: rel.reads.get(`operation:${childName}`) ?? EMPTY,
          // `requires <expr>` / `when <expr>` are the authorization + guard
          // clauses; both are invisible in the body statement flow, so they
          // surface as chips on the operation node itself.
          badges: badgesOf(
            gateBadge(op.gate),
            op.when ? { label: "when", detail: cstText(op.when) } : undefined,
          ),
        });
        break;
      }
      case "FunctionDecl":
        if (!childName) break;
        items.push({
          id: nid("function", childName),
          kind: "function",
          name: childName,
          readsOf: rel.reads.get(`function:${childName}`) ?? EMPTY,
        });
        break;
      case "DerivedProp":
        if (!childName) break;
        items.push({
          id: nid("derived", childName),
          kind: "derived",
          name: childName,
          readsOf: rel.reads.get(`derived:${childName}`) ?? EMPTY,
        });
        break;
      case "Property":
        if (!childName) break;
        items.push({
          id: nid("field", childName),
          kind: "field",
          name: childName,
          readsOf: EMPTY,
          badges: maskBadges(m as Property),
        });
        break;
      case "Containment": {
        if (!childName) break;
        // Show the entity type next to the field name so the user can see what
        // kind of thing the containment composes ("lines : OrderLine"). The
        // drill target is the entity itself, so clicking the containment
        // opens that entity's structure.
        const part = (m as { partType?: { $refText?: string } }).partType?.$refText;
        items.push({
          id: nid("containment", childName),
          kind: "containment",
          name: part ? `${childName} : ${part}` : childName,
          readsOf: EMPTY,
          ...(part ? { drillTo: { kind: "entity" as const, name: part } } : {}),
        });
        break;
      }
      // ---- lifecycle behaviour (read-only; bodies are addressable but not
      //      yet wired into the statement-flow view) ---------------------
      case "Create":
      case "Destroy": {
        const c = m as Create | Destroy;
        const kind = m.$type === "Create" ? "create" : "destroy";
        const label = c.name ?? kind;
        items.push({
          id: c.name ? nid(kind, c.name) : `${kind}:${next(kind)}`,
          kind,
          name: label,
          readsOf: EMPTY,
          summary: [
            `(${c.params.map((p) => cstText(p)).join(", ")})`,
            plural(c.body.length, "stmt"),
            ...(c.audited ? ["audited"] : []),
          ],
        });
        break;
      }
      case "Apply": {
        const a = m as Apply;
        const ev = a.event?.$refText ?? "?";
        items.push({
          id: `apply:${next("apply")}`,
          kind: "apply",
          name: `apply ${ev}`,
          readsOf: EMPTY,
          summary: [`(${a.param}: ${ev})`, plural(a.body.length, "stmt")],
        });
        break;
      }
      // ---- declaration shelf -----------------------------------------
      case "Unique": {
        const u = m as Unique;
        items.push({
          id: `unique:${next("unique")}`,
          kind: "unique",
          name: `(${u.columns.join(", ")})`,
          readsOf: EMPTY,
        });
        break;
      }
      case "FilterDecl":
        items.push({ ...filterItem(m as FilterDecl, next("filter")), readsOf: EMPTY });
        break;
      case "StampDecl":
        items.push({ ...stampItem(m as StampDecl, next("stamp")), readsOf: EMPTY });
        break;
      case "ImplementsDecl":
        items.push({ ...implementsItem(m as ImplementsDecl), readsOf: EMPTY });
        break;
      case "TestBlock":
        items.push({ ...testItem(m as TestBlock, next("test")), readsOf: EMPTY });
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
 *  under aggregates. `partType` refs are scoped by `ddd-scope.ts` to entity
 *  parts declared in the *same* aggregate, so a caller that knows which
 *  aggregate it's drilling from (the usual case — see `buildViewGraph`'s
 *  `"entity"` arm) should pass `aggName` to resolve the correct one even when
 *  two aggregates each declare an entity part with the same name. Without an
 *  `aggName` (or if it doesn't resolve), falls back to a global scan across
 *  every aggregate we can reach — first match wins, which can pick the wrong
 *  one under a cross-aggregate name collision. */
function findEntityPart(ast: Model, name: string, aggName?: string): EntityPart | undefined {
  if (aggName) {
    const agg = findAggregate(ast, aggName);
    if (agg) {
      for (const am of agg.members) if (am.$type === "EntityPart" && am.name === name) return am;
    }
  }
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
function entityView(ast: Model, name: string, aggName?: string): ViewGraph {
  const part = findEntityPart(ast, name, aggName);
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
        items.push({
          id: nid("field", childName!),
          kind: "field",
          name: childName!,
          readsOf: EMPTY,
          badges: maskBadges(m as Property),
        });
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

/** Delete a `contains <fieldName>: …` member from aggregate `aggName`, by
 *  splicing its own CST range to "" — the same construct-splice pattern the
 *  invariant delete handler in `SystemBuilderV2Pane.tsx` uses. Containment
 *  isn't a `Property`, so it can't go through `deleteField`
 *  (`system/fields.ts`) — that only reprints the Property-only sublist and
 *  would silently drop it. Self-contained (re-parses `source`, like the
 *  `system/*.ts` mutators) so callers don't have to keep a separately-parsed
 *  AST in sync with the source they're splicing over. Returns `null` if the
 *  source doesn't parse, or the aggregate / field isn't found. */
export function deleteContainment(source: string, aggName: string, fieldName: string): string | null {
  const { ast, parserErrors } = parseDdd(source);
  if (parserErrors.length > 0) return null;
  const agg = findAggregate(ast, aggName);
  if (!agg) return null;
  const target = agg.members.find(
    (m): m is Containment => m.$type === "Containment" && m.name === fieldName,
  );
  if (!target) return null;
  // Gated like every other builder write-back: the splice is re-parsed and
  // refused rather than committed if removing the member leaves text the
  // parser rejects (see `edit-engine.ts`).
  return spliceNodeIfParses(source, target, "");
}

export function findWorkflow(ast: Model, name: string): Workflow | undefined {
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

/** A workflow's statement flow, for ONE of its statement-bearing members.
 *  `member` is a `listBodies` key (`create` / `create:Name` / `handle:Name` /
 *  `on:Event` / `apply:Event`); omitted, it opens the primary `create(...)`
 *  starter — the historical single body, so the default view is unchanged. */
function workflowView(ast: Model, name: string, member?: BodyKey): ViewGraph {
  const wf = findWorkflow(ast, name);
  if (!wf) return { title: `workflow ${name}`, nodes: [], edges: [] };
  const stmts = workflowBodyStatements(wf, member);
  const label = member ? `${name}.${member}()` : `${name}()`;
  return stmtFlow(`workflow ${label}`, stmts, "workflow", label);
}

/** Every BoundedContext reachable in the model — declared at file top level
 *  (legacy single-context mode), directly in a system, or inside one of its
 *  subdomains. */
function allContexts(ast: Model): BoundedContext[] {
  const out: BoundedContext[] = [];
  for (const m of ast.members) {
    if (m.$type === "BoundedContext") out.push(m as BoundedContext);
    else if (m.$type === "System") {
      for (const sm of (m as System).members) {
        if (sm.$type === "BoundedContext") out.push(sm as BoundedContext);
        else if (sm.$type === "Subdomain") out.push(...(sm as Subdomain).contexts);
      }
    }
  }
  return out;
}

/** Find a named context member by AST `$type` across every reachable context. */
function findContextMember(ast: Model, type: string, name: string): ContextMember | undefined {
  for (const c of allContexts(ast)) {
    for (const m of c.members) {
      if (m.$type === type && (m as { name?: string }).name === name) return m;
    }
  }
  return undefined;
}

/** Read-only drill-in for a `domainService` — one leaf per stateless
 *  calculator operation (plus any unit tests it hosts). */
function domainServiceView(ast: Model, name: string): ViewGraph {
  const ds = findContextMember(ast, "DomainService", name) as DomainService | undefined;
  if (!ds) return { title: `domainservice ${name}`, nodes: [], edges: [] };
  const next = counter();
  const items: RawItem[] = [
    ...ds.operations.map((o) => ({
      id: nid("dsoperation", o.name),
      kind: "dsoperation" as const,
      name: o.name,
      summary: [signature(o.params, o.returnType), plural(o.stmts.length, "stmt")],
    })),
    ...ds.tests.map((t) => testItem(t, next("test"))),
  ];
  return withRoot(
    { title: `domainservice ${name}`, nodes: layout(items, ["dsoperation", "test"]), edges: [] },
    "domainservice",
    name,
    { connectAll: true },
  );
}

/** Read-only drill-in for a `projection` — its declared row fields plus the
 *  `on(e: Event) { … }` folds that maintain them. */
function projectionView(ast: Model, name: string): ViewGraph {
  const p = findContextMember(ast, "Projection", name) as Projection | undefined;
  if (!p) return { title: `projection ${name}`, nodes: [], edges: [] };
  const next = counter();
  const items: RawItem[] = [];
  for (const m of p.members) {
    if (m.$type === "Property") {
      const prop = m as Property;
      items.push({
        id: nid("field", prop.name),
        kind: "field",
        name: prop.name,
        summary: [cstText(prop.type)],
        badges: maskBadges(prop),
      });
    } else {
      const fold = m as ProjectionOn;
      const ev = fold.event?.$refText ?? "?";
      items.push({
        id: `apply:${next("apply")}`,
        kind: "apply",
        name: `on ${ev}`,
        summary: [`(${fold.param}: ${ev})`, plural(fold.body.length, "stmt")],
      });
    }
  }
  return withRoot(
    { title: `projection ${name}`, nodes: layout(items, ["apply", "field"]), edges: [] },
    "projection",
    name,
    { connectAll: true },
  );
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
  const items: RawItem[] = repo.finds.map((f) => ({
    id: nid("find", f.name),
    kind: "find" as const,
    name: f.name,
    // A `find … requires <expr>` gate is the read-side authorization check —
    // chip it so a gated read is visibly distinct from an open one.
    badges: badgesOf(gateBadge(f.gate)),
  }));
  return withRoot(
    { title: `repository ${name}`, nodes: layout(items, ["find"]), edges: [] },
    "repository",
    name,
    { connectAll: true },
  );
}

/** Per-call view options the drill path itself can't express. */
export interface ViewOptions {
  /** Which statement-bearing member of the workflow at the path leaf to open —
   *  a `listBodies` key (`create` / `handle:Approve` / `on:Placed` / …).
   *  Defaults to the primary `create(...)` starter. */
  workflowMember?: BodyKey;
}

/** Dispatch on the last step of `path` to the per-level builder; empty path
 *  is the root view. Operation and workflow leaves render as a statement
 *  flow (the leaf node type the pane knows how to render). */
export function buildViewGraph(ast: Model, path: ViewPath, opts: ViewOptions = {}): ViewGraph {
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
    case "entity": {
      // Entity-part names can collide across aggregates, and `partType` refs
      // are scoped by `ddd-scope.ts` to the same aggregate — so resolve
      // against the nearest "aggregate" ancestor in the drill path (entity
      // steps are only ever reached, directly or via other entity steps,
      // from an aggregate's containment) instead of scanning every aggregate.
      const aggStep = [...path].reverse().find((s) => s.kind === "aggregate");
      return entityView(ast, last.name, aggStep?.name);
    }
    case "operation": {
      // An operation only resolves below an aggregate step.
      const agg = path[path.length - 2];
      if (agg?.kind !== "aggregate") return { title: last.name, nodes: [], edges: [] };
      return operationView(ast, agg.name, last.name);
    }
    case "workflow":
      return workflowView(ast, last.name, opts.workflowMember);
    case "repository":
      return repositoryView(ast, last.name);
    case "domainservice":
      return domainServiceView(ast, last.name);
    case "projection":
      return projectionView(ast, last.name);
    default:
      // The remaining leaves (value object / event / function / and every
      // read-only construct on the declaration shelf) carry their whole story
      // in the node card's summary lines — there is nothing below to show.
      return { title: `${last.kind} ${last.name}`, nodes: [], edges: [] };
  }
}
