// Slice 4 — scaffold expander.
//
// Walks each `ui` block's `scaffolds: ScaffoldIR[]` directives and
// synthesises explicit `PageIR` nodes per the spec §10 rewrite
// hierarchy:
//
//   modules → contexts → { aggregates ∪ workflows ∪ views }
//
// Per-leaf shape (matches the legacy generator's emitted file
// inventory — the byte-equivalence target for Slice 5):
//
//   `aggregates: <Name>`
//     → <Name>List   (route /<plural-snake>,         body List(of: Name))
//       <Name>New    (route /<plural-snake>/new,     body Form(creates: Name))
//       <Name>Detail (route /<plural-snake>/:id,     body Detail(of: Name, by: id))
//
//   `workflows: <name>`
//     → <Pascal>Workflow   (route /workflows/<snake>, body Form(runs: <name>))
//       (+ shared WorkflowsIndex page if any workflow scaffolded)
//
//   `views: <Name>`
//     → <Name>View  (route /views/<snake>, body List(of view <Name>))
//       (+ shared ViewsIndex page if any view scaffolded)
//
// Plus an unconditional Home page when at least one aggregate / workflow
// / view is scaffolded.
//
// Override-by-name resolution (spec §10): explicit `page <Name>` in
// the same ui displaces the scaffolded page with the matching name.
// The cross-directive double-scaffold case (`scaffold modules: M` +
// `scaffold aggregates: A` where A is in M) surfaces via the returned
// `diagnostics` list — the validator already catches the same-target-
// twice-within-one-directive case (rule 6 from Slice 3); cross-
// directive detection lives here because it's the place that can
// see the expanded page-name set.
//
// This module is pure over IR: no AST access, no Langium dependency.
// Both `enrichLoomModel` (during the lowering tail) and `validate.ts`
// (post-IR validation) consume it.

import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  MenuMetaIR,
  ModuleIR,
  PageIR,
  ParamIR,
  ScaffoldIR,
  ScaffoldOriginIR,
  StateFieldIR,
  SystemIR,
  UiIR,
  ViewIR,
  WorkflowIR,
} from "./loom-ir.js";
import { camel, pascal, plural, snake } from "../util/naming.js";

export interface ExpansionDiagnostic {
  /** Two scaffold directives produced the same generated page name.
   *  Typically: `scaffold modules: M` + `scaffold aggregates: A`
   *  where A is in M.  Slice 4 collapses to the first-source page;
   *  this diagnostic is forwarded to the validator. */
  kind: "double-scaffold";
  pageName: string;
  /** The ScaffoldIR directives that contributed.  First wins; the
   *  remainder are reported. */
  sources: ScaffoldIR[];
}

export interface ExpansionResult {
  /** Final canonical page list — explicit pages first (preserve user-
   *  declared order), then scaffolded pages in scaffold-directive
   *  order.  Ordering matters for stable test fixtures and stable
   *  default sidebar layouts. */
  pages: PageIR[];
  diagnostics: ExpansionDiagnostic[];
}

/** Pure expander over a single ui block.  Does not mutate `ui` or
 *  `sys`. */
export function expandScaffolds(ui: UiIR, sys: SystemIR): ExpansionResult {
  // Step 1: walk each scaffold directive and accumulate scaffold
  // hits in a Map<pageName, { page; sources }>.
  const hits = new Map<
    string,
    { page: PageIR; sources: ScaffoldIR[] }
  >();
  let anyAggregate = false;
  let anyWorkflow = false;
  let anyView = false;
  for (const sc of ui.scaffolds) {
    for (const target of sc.targets) {
      const expanded = expandOne(sc.selector, target, sys);
      for (const p of expanded) {
        const existing = hits.get(p.name);
        if (existing) {
          existing.sources.push(sc);
        } else {
          hits.set(p.name, { page: p, sources: [sc] });
        }
      }
      if (sc.selector === "aggregates") anyAggregate = true;
      else if (sc.selector === "workflows") anyWorkflow = true;
      else if (sc.selector === "views") anyView = true;
      else if (sc.selector === "modules" || sc.selector === "contexts") {
        // Whether a module/context contributes aggregates/workflows/
        // views depends on its content; mark conservatively.  These
        // flags drive synthesis of the shared Home / WorkflowsIndex /
        // ViewsIndex pages, which the legacy generator emits whenever
        // the corresponding category has at least one entry.
        const presence = directiveCoverage(sc.selector, target, sys);
        if (presence.hasAggregates) anyAggregate = true;
        if (presence.hasWorkflows) anyWorkflow = true;
        if (presence.hasViews) anyView = true;
      }
    }
  }

  // Step 2: synthesise shared index pages — Home / WorkflowsIndex /
  // ViewsIndex — for any category that has at least one scaffolded
  // entry.  Skip when an explicit page with the same name already
  // exists.  These don't carry a scaffold "source" (they're not
  // attributable to a single directive), so they sit alone in `hits`
  // with an empty sources array; the double-scaffold detector skips
  // them.
  const explicitNames = new Set(ui.pages.map((p) => p.name));
  const sharedScaffolded: PageIR[] = [];
  if (
    (anyAggregate || anyWorkflow || anyView) &&
    !explicitNames.has("Home") &&
    !hits.has("Home")
  ) {
    sharedScaffolded.push(makeHomePage());
  }
  if (anyWorkflow && !explicitNames.has("WorkflowsIndex") && !hits.has("WorkflowsIndex")) {
    sharedScaffolded.push(makeWorkflowsIndexPage());
  }
  if (anyView && !explicitNames.has("ViewsIndex") && !hits.has("ViewsIndex")) {
    sharedScaffolded.push(makeViewsIndexPage());
  }

  // Step 3: assemble the final page list.  Explicit pages first
  // (preserve declaration order), then scaffolded pages in scaffold
  // order, then the shared index pages.  Explicit names suppress
  // any scaffolded entry of the matching name.
  const merged: PageIR[] = [];
  for (const explicit of ui.pages) merged.push(explicit);
  for (const [name, hit] of hits) {
    if (explicitNames.has(name)) continue;
    merged.push(hit.page);
  }
  for (const shared of sharedScaffolded) merged.push(shared);

  // Step 4: collect double-scaffold diagnostics.  Only fire for the
  // hits map (per-target rewrites); shared index pages never
  // duplicate.
  const diagnostics: ExpansionDiagnostic[] = [];
  for (const [name, hit] of hits) {
    if (hit.sources.length > 1) {
      diagnostics.push({ kind: "double-scaffold", pageName: name, sources: hit.sources });
    }
  }

  return { pages: merged, diagnostics };
}

// ---------------------------------------------------------------------------
// Per-selector dispatch
// ---------------------------------------------------------------------------

function expandOne(
  selector: ScaffoldIR["selector"],
  target: string,
  sys: SystemIR,
): PageIR[] {
  switch (selector) {
    case "modules":
      return expandModule(target, sys);
    case "contexts":
      return expandContext(target, sys);
    case "aggregates":
      return expandAggregateByName(target, sys);
    case "workflows":
      return expandWorkflowByName(target, sys);
    case "views":
      return expandViewByName(target, sys);
  }
}

function expandModule(name: string, sys: SystemIR): PageIR[] {
  const m = sys.modules.find((m) => m.name === name);
  if (!m) return [];
  const out: PageIR[] = [];
  for (const ctx of m.contexts) out.push(...expandContextDirect(ctx));
  return out;
}

function expandContext(name: string, sys: SystemIR): PageIR[] {
  for (const m of sys.modules) {
    for (const ctx of m.contexts) {
      if (ctx.name === name) return expandContextDirect(ctx);
    }
  }
  return [];
}

function expandContextDirect(ctx: BoundedContextIR): PageIR[] {
  const out: PageIR[] = [];
  for (const agg of ctx.aggregates) out.push(...expandAggregateDirect(agg, ctx.name));
  for (const wf of ctx.workflows) out.push(expandWorkflowDirect(wf, ctx.name));
  for (const view of ctx.views) out.push(expandViewDirect(view, ctx.name));
  return out;
}

function expandAggregateByName(name: string, sys: SystemIR): PageIR[] {
  for (const m of sys.modules) {
    for (const ctx of m.contexts) {
      const agg = ctx.aggregates.find((a) => a.name === name);
      if (agg) return expandAggregateDirect(agg, ctx.name);
    }
  }
  return [];
}

function expandWorkflowByName(name: string, sys: SystemIR): PageIR[] {
  for (const m of sys.modules) {
    for (const ctx of m.contexts) {
      const wf = ctx.workflows.find((w) => w.name === name);
      if (wf) return [expandWorkflowDirect(wf, ctx.name)];
    }
  }
  return [];
}

function expandViewByName(name: string, sys: SystemIR): PageIR[] {
  for (const m of sys.modules) {
    for (const ctx of m.contexts) {
      const v = ctx.views.find((v) => v.name === name);
      if (v) return [expandViewDirect(v, ctx.name)];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Per-archetype synthesis — produces a `PageIR` with body expression
// shaped like what the user would write (`List(of: T)`, etc.).  The
// `scaffoldOrigin` discriminator carries the same intent for Slice 5's
// emitter to fast-path the legacy per-aggregate / per-workflow / per-
// view builder.
// ---------------------------------------------------------------------------

function expandAggregateDirect(agg: AggregateIR, contextName: string): PageIR[] {
  const pluralSnake = snake(plural(agg.name));
  return [
    makeScaffoldPage({
      name: `${agg.name}List`,
      route: `/${pluralSnake}`,
      body: callExpr("List", [{ name: "of", value: nameRef(agg.name) }]),
      menuMeta: { entries: [
        { name: "section", value: stringLit("Aggregates") },
        { name: "label",   value: stringLit(humanize(plural(agg.name))) },
      ] },
      origin: { kind: "aggregate-list", aggregateName: agg.name, contextName },
    }),
    makeScaffoldPage({
      name: `${agg.name}New`,
      route: `/${pluralSnake}/new`,
      body: callExpr("Form", [{ name: "creates", value: nameRef(agg.name) }]),
      menuMeta: hiddenMenu(),
      origin: { kind: "aggregate-new", aggregateName: agg.name, contextName },
    }),
    makeScaffoldPage({
      name: `${agg.name}Detail`,
      route: `/${pluralSnake}/:id`,
      params: [{ name: "id", type: { kind: "id", targetName: agg.name, valueType: agg.idValueType } }],
      body: callExpr("Detail", [
        { name: "of", value: nameRef(agg.name) },
        { name: "by", value: { kind: "ref", name: "id", refKind: "param" } },
      ]),
      menuMeta: hiddenMenu(),
      origin: { kind: "aggregate-detail", aggregateName: agg.name, contextName },
    }),
  ];
}

function expandWorkflowDirect(wf: WorkflowIR, contextName: string): PageIR {
  return makeScaffoldPage({
    name: `${pascal(wf.name)}Workflow`,
    route: `/workflows/${snake(wf.name)}`,
    body: callExpr("Form", [{ name: "runs", value: nameRef(wf.name) }]),
    menuMeta: { entries: [
      { name: "section", value: stringLit("Workflows") },
      { name: "label",   value: stringLit(humanize(wf.name)) },
    ] },
    origin: { kind: "workflow-form", workflowName: wf.name, contextName },
  });
}

function expandViewDirect(view: ViewIR, contextName: string): PageIR {
  return makeScaffoldPage({
    name: `${view.name}View`,
    route: `/views/${snake(view.name)}`,
    body: callExpr("List", [{ name: "of", value: nameRef(`view ${view.name}`) }]),
    menuMeta: { entries: [
      { name: "section", value: stringLit("Views") },
      { name: "label",   value: stringLit(humanize(view.name)) },
    ] },
    origin: { kind: "view-list", viewName: view.name, contextName },
  });
}

function makeHomePage(): PageIR {
  return makeScaffoldPage({
    name: "Home",
    route: "/",
    body: callExpr("Home", []),
    menuMeta: { entries: [
      { name: "section", value: stringLit("") },
      { name: "label",   value: stringLit("Home") },
    ] },
    origin: { kind: "home" },
  });
}

function makeWorkflowsIndexPage(): PageIR {
  return makeScaffoldPage({
    name: "WorkflowsIndex",
    route: "/workflows",
    body: callExpr("WorkflowsIndex", []),
    menuMeta: { entries: [
      { name: "section", value: stringLit("Workflows") },
      { name: "label",   value: stringLit("Index") },
    ] },
    origin: { kind: "workflows-index" },
  });
}

function makeViewsIndexPage(): PageIR {
  return makeScaffoldPage({
    name: "ViewsIndex",
    route: "/views",
    body: callExpr("ViewsIndex", []),
    menuMeta: { entries: [
      { name: "section", value: stringLit("Views") },
      { name: "label",   value: stringLit("Index") },
    ] },
    origin: { kind: "views-index" },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ScaffoldPageInput {
  name: string;
  route: string;
  params?: ParamIR[];
  body: ExprIR;
  menuMeta?: MenuMetaIR;
  origin: ScaffoldOriginIR;
}

function makeScaffoldPage(p: ScaffoldPageInput): PageIR {
  return {
    name: p.name,
    params: p.params ?? [],
    route: p.route,
    state: [] as StateFieldIR[],
    body: p.body,
    menuMeta: p.menuMeta,
    source: "scaffold",
    scaffoldOrigin: p.origin,
  };
}

function callExpr(
  name: string,
  named: { name: string; value: ExprIR }[],
): ExprIR {
  const args = named.map((n) => n.value);
  const argNames = named.map((n) => n.name as string | undefined);
  return {
    kind: "call",
    callKind: "free",
    name,
    args,
    ...(argNames.some((n) => n !== undefined) ? { argNames } : {}),
  };
}

function nameRef(name: string): ExprIR {
  return { kind: "ref", name, refKind: "unknown" };
}

function stringLit(value: string): ExprIR {
  return { kind: "literal", lit: "string", value };
}

function hiddenMenu(): MenuMetaIR {
  return {
    entries: [{ name: "hidden", value: { kind: "literal", lit: "bool", value: "true" } }],
  };
}

function humanize(s: string): string {
  // "place_order" / "placeOrder" / "PlaceOrder" → "Place Order"
  // Cheap implementation: split on _ or camelCase boundaries, title-case.
  const parts = s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

interface DirectiveCoverage {
  hasAggregates: boolean;
  hasWorkflows: boolean;
  hasViews: boolean;
}

function directiveCoverage(
  selector: "modules" | "contexts",
  target: string,
  sys: SystemIR,
): DirectiveCoverage {
  let hasAggregates = false;
  let hasWorkflows = false;
  let hasViews = false;
  const visit = (ctx: BoundedContextIR) => {
    if (ctx.aggregates.length > 0) hasAggregates = true;
    if (ctx.workflows.length > 0) hasWorkflows = true;
    if (ctx.views.length > 0) hasViews = true;
  };
  if (selector === "modules") {
    const m = sys.modules.find((m) => m.name === target);
    if (m) for (const ctx of m.contexts) visit(ctx);
  } else if (selector === "contexts") {
    for (const m of sys.modules) {
      for (const ctx of m.contexts) {
        if (ctx.name === target) visit(ctx);
      }
    }
  }
  return { hasAggregates, hasWorkflows, hasViews };
}

// Re-exports so callers can import the diagnostics shape without
// pulling the whole module.
export type { PageIR, ScaffoldIR, ScaffoldOriginIR, UiIR } from "./loom-ir.js";
