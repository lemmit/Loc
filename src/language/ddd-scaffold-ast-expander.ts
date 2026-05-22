// Pass 1 — AST-to-AST scaffold expansion.
//
// Runs as a `DocumentState.IndexedContent` listener on the shared
// `DocumentBuilder`.  By the time it fires, the document has been
// parsed and the IndexManager has registered the original AST's
// exported symbols.  We then walk every `Ui` block, expand each
// `Scaffold` directive into synthesised `Page` AST nodes (with
// route, body expression, menu metadata, and proper `$container`
// wiring), and append them to the ui's `members[]` array.
//
// Phase ordering after we mutate:
//   IndexedContent (=2) ← we run here, AFTER it
//   ComputedScopes (=3) — local scope walks `ui.members` and
//                          picks up synthesised pages by name
//   Linked        (=4) — `[Page:ID]` cross-references inside this
//                          document resolve through Langium's
//                          standard machinery; no IR-level shim
//   Validated     (=6)
//
// Intra-document `[Page:ID]` cross-references (the only kind a `ui`
// block needs — every page lives inside its containing ui) resolve
// cleanly because `ScopeComputation` re-walks the (now expanded)
// AST.  Cross-document references would need to mutate before
// IndexedContent — that's a future enhancement.
//
// Every synthesised page carries:
//   - `name`               — `<Aggregate>List` / `<Aggregate>New` /
//                            `<Aggregate>Detail` / `<Workflow>Workflow` /
//                            `<View>View` / `Home` / `WorkflowsIndex` /
//                            `ViewsIndex`
//   - `route`              — `/<plural-snake>` etc. via a `RouteProp`
//   - body expression      — `List(of: <Aggregate>)` etc. via a `BodyProp`
//                            with a `CallExpr` (name + named args)
//   - menu metadata        — `section`, `label`, `hidden`, `order` via
//                            a `PageMenuMeta` block
//
// `params`, `state`, `requires`, `title` are not synthesised today —
// the page emitter does its own type-driven inference (e.g. detail
// pages take `id: Id<T>` from the aggregate, not from a synthesised
// `Parameter` node).  Adding them is mechanical when needed.

import type { LangiumDocument } from "langium";
import { DocumentState } from "langium";
import type { LangiumSharedServices } from "langium/lsp";
import {
  type Aggregate,
  type BodyProp,
  type BoundedContext,
  type CallArg,
  type CallExpr,
  type Expression,
  isModule,
  isSystem,
  isUi,
  type LiteralExpr,
  type MenuMetaEntry,
  type Model,
  type Module as ModuleAst,
  type NameRef,
  type Page,
  type PageMenuMeta,
  type RouteProp,
  type Scaffold,
  type StateBlock,
  type Ui,
  type View,
  type Workflow,
} from "./generated/ast.js";

// ---------------------------------------------------------------------------
// Service registration
// ---------------------------------------------------------------------------

export function registerScaffoldAstExpander(shared: LangiumSharedServices): void {
  shared.workspace.DocumentBuilder.onDocumentPhase(DocumentState.IndexedContent, async (doc) => {
    const root = doc.parseResult.value as Model | undefined;
    if (!root) return;
    expandScaffoldsInModel(root, doc);
  });
}

// ---------------------------------------------------------------------------
// Walk + expand
// ---------------------------------------------------------------------------

function expandScaffoldsInModel(model: Model, doc: LangiumDocument): void {
  for (const m of model.members ?? []) {
    if (!isSystem(m)) continue;
    const inv = buildSystemInventory(m);
    const synthesisedHomeFlag = { addedHome: false };
    for (const sm of m.members ?? []) {
      if (!isUi(sm)) continue;
      expandUi(sm, inv, doc, synthesisedHomeFlag);
    }
  }
}

interface SystemInventory {
  modulesByName: Map<string, ModuleAst>;
  contextsByName: Map<string, BoundedContext>;
  aggregateByName: Map<string, Aggregate>;
  workflowByName: Map<string, Workflow>;
  viewByName: Map<string, View>;
}

function buildSystemInventory(sys: import("./generated/ast.js").System): SystemInventory {
  const inv: SystemInventory = {
    modulesByName: new Map(),
    contextsByName: new Map(),
    aggregateByName: new Map(),
    workflowByName: new Map(),
    viewByName: new Map(),
  };
  const visitContext = (ctx: BoundedContext) => {
    inv.contextsByName.set(ctx.name, ctx);
    for (const cm of ctx.members ?? []) {
      if (cm.$type === "Aggregate")
        inv.aggregateByName.set((cm as Aggregate).name, cm as Aggregate);
      else if (cm.$type === "Workflow")
        inv.workflowByName.set((cm as Workflow).name, cm as Workflow);
      else if (cm.$type === "View") inv.viewByName.set((cm as View).name, cm as View);
    }
  };
  for (const sm of sys.members ?? []) {
    if (isModule(sm)) {
      inv.modulesByName.set(sm.name, sm);
      for (const ctx of sm.contexts ?? []) visitContext(ctx);
    } else if (sm.$type === "BoundedContext") {
      visitContext(sm as BoundedContext);
    }
  }
  return inv;
}

function expandUi(
  ui: Ui,
  inv: SystemInventory,
  _doc: LangiumDocument,
  homeFlag: { addedHome: boolean },
): void {
  // Collect explicit page names so override-by-name skips synthesis
  // for collisions (the user's explicit page wins).
  const explicitPageNames = new Set<string>();
  for (const m of ui.members ?? []) {
    if (m.$type === "Page") explicitPageNames.add((m as Page).name);
  }
  // Track within-this-ui synthesis to detect double-scaffold (same
  // generated page name from two scaffold directives).  We append
  // both — Langium's duplicate-symbol detection (or the validator)
  // will report the conflict downstream.
  const synthesisedNames = new Set<string>();
  let anyAggregate = false;
  let anyWorkflow = false;
  let anyView = false;
  const synthesised: Page[] = [];
  for (const m of ui.members ?? []) {
    if (m.$type !== "Scaffold") continue;
    const sc = m as Scaffold;
    for (const target of sc.targets ?? []) {
      const pages = expandOne(sc, target, inv);
      for (const p of pages) {
        if (explicitPageNames.has(p.name)) continue;
        if (synthesisedNames.has(p.name)) continue;
        synthesisedNames.add(p.name);
        synthesised.push(p);
      }
      // Coverage flags drive shared-page synthesis below.
      if (sc.selector === "aggregates") anyAggregate = true;
      else if (sc.selector === "workflows") anyWorkflow = true;
      else if (sc.selector === "views") anyView = true;
      else if (sc.selector === "modules" || sc.selector === "contexts") {
        const cov = directiveCoverage(sc.selector, target, inv);
        if (cov.hasAggregates) anyAggregate = true;
        if (cov.hasWorkflows) anyWorkflow = true;
        if (cov.hasViews) anyView = true;
      }
    }
  }

  // Shared pages — Home + WorkflowsIndex + ViewsIndex — synthesised
  // once per ui when their respective category has any coverage.
  if (
    (anyAggregate || anyWorkflow || anyView) &&
    !explicitPageNames.has("Home") &&
    !synthesisedNames.has("Home")
  ) {
    synthesised.push(synthesiseHomePage());
    synthesisedNames.add("Home");
    homeFlag.addedHome = true;
  }
  if (
    anyWorkflow &&
    !explicitPageNames.has("WorkflowsIndex") &&
    !synthesisedNames.has("WorkflowsIndex")
  ) {
    synthesised.push(synthesiseWorkflowsIndexPage());
    synthesisedNames.add("WorkflowsIndex");
  }
  if (anyView && !explicitPageNames.has("ViewsIndex") && !synthesisedNames.has("ViewsIndex")) {
    synthesised.push(synthesiseViewsIndexPage());
    synthesisedNames.add("ViewsIndex");
  }

  // Append synthesised pages to ui.members and wire `$container`
  // links so the AST tree invariants hold.
  for (const page of synthesised) attachToUi(page, ui);
}

function expandOne(sc: Scaffold, target: string, inv: SystemInventory): Page[] {
  switch (sc.selector) {
    case "modules": {
      const m = inv.modulesByName.get(target);
      if (!m) return [];
      const out: Page[] = [];
      for (const ctx of m.contexts ?? []) {
        out.push(...expandContext(ctx));
      }
      return out;
    }
    case "contexts": {
      const ctx = inv.contextsByName.get(target);
      return ctx ? expandContext(ctx) : [];
    }
    case "aggregates": {
      const agg = inv.aggregateByName.get(target);
      return agg ? expandAggregate(agg) : [];
    }
    case "workflows": {
      const wf = inv.workflowByName.get(target);
      return wf ? [synthesiseWorkflowPage(wf)] : [];
    }
    case "views": {
      const v = inv.viewByName.get(target);
      return v ? [synthesiseViewPage(v)] : [];
    }
    default:
      return [];
  }
}

function expandContext(ctx: BoundedContext): Page[] {
  const out: Page[] = [];
  for (const cm of ctx.members ?? []) {
    if (cm.$type === "Aggregate") out.push(...expandAggregate(cm as Aggregate));
    else if (cm.$type === "Workflow") out.push(synthesiseWorkflowPage(cm as Workflow));
    else if (cm.$type === "View") out.push(synthesiseViewPage(cm as View));
  }
  return out;
}

interface DirectiveCoverage {
  hasAggregates: boolean;
  hasWorkflows: boolean;
  hasViews: boolean;
}

function directiveCoverage(
  selector: "modules" | "contexts",
  target: string,
  inv: SystemInventory,
): DirectiveCoverage {
  let hasAggregates = false;
  let hasWorkflows = false;
  let hasViews = false;
  const visit = (ctx: BoundedContext) => {
    for (const cm of ctx.members ?? []) {
      if (cm.$type === "Aggregate") hasAggregates = true;
      else if (cm.$type === "Workflow") hasWorkflows = true;
      else if (cm.$type === "View") hasViews = true;
    }
  };
  if (selector === "modules") {
    const m = inv.modulesByName.get(target);
    if (m) for (const ctx of m.contexts ?? []) visit(ctx);
  } else {
    const ctx = inv.contextsByName.get(target);
    if (ctx) visit(ctx);
  }
  return { hasAggregates, hasWorkflows, hasViews };
}

// ---------------------------------------------------------------------------
// Per-archetype synthesis
// ---------------------------------------------------------------------------

function expandAggregate(agg: Aggregate): Page[] {
  const pluralSnake = snake(plural(agg.name));
  const aggName = agg.name;
  const labelPlural = humanize(plural(aggName));
  return [
    makePage({
      name: `${aggName}List`,
      route: `/${pluralSnake}`,
      body: callExpr("List", [{ name: "of", value: nameRefExpr(aggName) }]),
      menu: makeMenuMeta([
        ["section", stringLit("Aggregates")],
        ["label", stringLit(labelPlural)],
      ]),
    }),
    makePage({
      name: `${aggName}New`,
      route: `/${pluralSnake}/new`,
      body: callExpr("Form", [{ name: "creates", value: nameRefExpr(aggName) }]),
      menu: makeMenuMeta([["hidden", boolLit(true)]]),
    }),
    makePage({
      name: `${aggName}Detail`,
      route: `/${pluralSnake}/:id`,
      body: callExpr("Detail", [
        { name: "of", value: nameRefExpr(aggName) },
        { name: "by", value: nameRefExpr("id") },
      ]),
      menu: makeMenuMeta([["hidden", boolLit(true)]]),
    }),
  ];
}

function synthesiseWorkflowPage(wf: Workflow): Page {
  const pasName = pascal(wf.name);
  return makePage({
    name: `${pasName}Workflow`,
    route: `/workflows/${snake(wf.name)}`,
    body: callExpr("Form", [{ name: "runs", value: nameRefExpr(wf.name) }]),
    menu: makeMenuMeta([
      ["section", stringLit("Workflows")],
      ["label", stringLit(humanize(wf.name))],
    ]),
  });
}

function synthesiseViewPage(view: View): Page {
  return makePage({
    name: `${view.name}View`,
    route: `/views/${snake(view.name)}`,
    body: callExpr("List", [{ name: "of", value: nameRefExpr(`view ${view.name}`) }]),
    menu: makeMenuMeta([
      ["section", stringLit("Views")],
      ["label", stringLit(humanize(view.name))],
    ]),
  });
}

function synthesiseHomePage(): Page {
  return makePage({
    name: "Home",
    route: "/",
    body: callExpr("Home", []),
    menu: makeMenuMeta([["hidden", boolLit(true)]]),
  });
}

function synthesiseWorkflowsIndexPage(): Page {
  return makePage({
    name: "WorkflowsIndex",
    route: "/workflows",
    body: callExpr("WorkflowsIndex", []),
    menu: makeMenuMeta([
      ["section", stringLit("Workflows")],
      ["label", stringLit("Index")],
    ]),
  });
}

function synthesiseViewsIndexPage(): Page {
  return makePage({
    name: "ViewsIndex",
    route: "/views",
    body: callExpr("ViewsIndex", []),
    menu: makeMenuMeta([
      ["section", stringLit("Views")],
      ["label", stringLit("Index")],
    ]),
  });
}

// ---------------------------------------------------------------------------
// AST node constructors
// ---------------------------------------------------------------------------

interface PageInput {
  name: string;
  route: string;
  body: CallExpr;
  menu?: PageMenuMeta;
}

function makePage(input: PageInput): Page {
  const props: Page["props"] = [];
  const route = makeRouteProp(input.route);
  props.push(route as unknown as Page["props"][number]);
  const body = makeBodyProp(input.body);
  props.push(body as unknown as Page["props"][number]);
  if (input.menu) {
    props.push(input.menu as unknown as Page["props"][number]);
  }
  // Construct page; $container etc. are set by `attachToUi`.
  const page: Page = {
    $type: "Page",
    name: input.name,
    params: [],
    props,
  } as unknown as Page;
  // Wire prop $containers back to the page.
  for (let i = 0; i < props.length; i++) {
    const p = props[i] as unknown as Record<string, unknown>;
    p["$container"] = page;
    p["$containerProperty"] = "props";
    p["$containerIndex"] = i;
  }
  return page;
}

function makeRouteProp(value: string): RouteProp {
  return {
    $type: "RouteProp",
    value,
  } as unknown as RouteProp;
}

function makeBodyProp(expr: CallExpr): BodyProp {
  const bp: BodyProp = {
    $type: "BodyProp",
    expr: expr as unknown as Expression,
  } as unknown as BodyProp;
  // expr's $container becomes the BodyProp.
  setContainer(expr, bp, "expr");
  return bp;
}

function callExpr(name: string, named: { name?: string; value: Expression }[]): CallExpr {
  const callee = nameRefExpr(name);
  const args: CallArg[] = named.map((n) => {
    const arg: CallArg = {
      $type: "CallArg",
      name: n.name,
      value: n.value,
    } as unknown as CallArg;
    setContainer(n.value, arg, "value");
    return arg;
  });
  const ce: CallExpr = {
    $type: "CallExpr",
    callee: callee as unknown as Expression,
    args,
  } as unknown as CallExpr;
  setContainer(callee, ce, "callee");
  for (let i = 0; i < args.length; i++) {
    setContainer(args[i] as unknown as Record<string, unknown>, ce, "args", i);
  }
  return ce;
}

function nameRefExpr(name: string): NameRef {
  return {
    $type: "NameRef",
    name,
  } as unknown as NameRef;
}

function stringLit(value: string): LiteralExpr {
  return {
    $type: "StringLit",
    value,
  } as unknown as LiteralExpr;
}

function boolLit(value: boolean): LiteralExpr {
  return {
    $type: "BoolLit",
    value: String(value),
  } as unknown as LiteralExpr;
}

function makeMenuMeta(entries: [string, Expression][]): PageMenuMeta {
  const meta: PageMenuMeta = {
    $type: "PageMenuMeta",
    entries: [],
  } as unknown as PageMenuMeta;
  const entryNodes: MenuMetaEntry[] = entries.map(([n, v]) => {
    const e: MenuMetaEntry = {
      $type: "MenuMetaEntry",
      name: n,
      value: v,
    } as unknown as MenuMetaEntry;
    setContainer(v, e, "value");
    return e;
  });
  for (let i = 0; i < entryNodes.length; i++) {
    setContainer(entryNodes[i]!, meta, "entries", i);
  }
  // `entries` is a regular array on PageMenuMeta in the AST.
  (meta as unknown as { entries: MenuMetaEntry[] }).entries = entryNodes;
  return meta;
}

// ---------------------------------------------------------------------------
// Container wiring
// ---------------------------------------------------------------------------

function attachToUi(page: Page, ui: Ui): void {
  setContainer(page, ui, "members", ui.members.length);
  ui.members.push(page);
}

function setContainer(child: unknown, parent: object, property: string, index?: number): void {
  const c = child as Record<string, unknown>;
  c["$container"] = parent;
  c["$containerProperty"] = property;
  if (index !== undefined) c["$containerIndex"] = index;
}

// ---------------------------------------------------------------------------
// Naming utilities (avoid ../util/naming.js to keep this module
// dependency-free of project structure).
// ---------------------------------------------------------------------------

function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function plural(s: string): string {
  if (s.endsWith("y")) return s.slice(0, -1) + "ies";
  if (s.endsWith("s")) return s + "es";
  return s + "s";
}

function pascal(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function humanize(s: string): string {
  const parts = s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export const __spike__expandScaffoldsInModel = expandScaffoldsInModel;
export const __spike__buildSystemInventory = buildSystemInventory;
