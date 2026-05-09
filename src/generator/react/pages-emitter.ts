// Slice 5 — page emitter.
//
// Walks `ui.pages` (post-Slice-4 expansion: explicit pages + scaffold
// rewrites + shared Home / WorkflowsIndex / ViewsIndex) and emits one
// TSX file per page, dispatching by `scaffoldOrigin.kind` to the
// existing per-archetype builders.  This is the byte-equivalence
// layer for the bulk-scaffold case — every legacy direct-walk
// invocation routes through here.
//
// What this slice does:
// - Replaces the per-aggregate / per-workflow / per-view PAGE
//   emission loops in `src/generator/react/index.ts` with one call
//   to `emitPagesForUi`.
// - Reuses the existing builders (`renderListPage`, `buildNewPage`,
//   `buildDetailPage`, `buildWorkflowFormPage`, `buildViewTablePage`,
//   `buildWorkflowsIndexPage`, `buildViewsIndexPage`, `homeTsx`)
//   verbatim — byte-equivalence comes for free.
//
// What this slice intentionally doesn't touch:
// - Per-aggregate api modules (`src/api/<agg>.ts`) — emitted by
//   `index.ts` via the existing aggregate iteration.
// - Per-aggregate / per-workflow / per-view Playwright page objects
//   under `e2e/pages/` — Slice 7 reroutes those to walk the page IR.
// - Project shell (App.tsx, main.tsx, vite.config.ts, package.json,
//   theme, smoke spec) — orthogonal to the page metamodel.
//
// What this slice intentionally doesn't yet handle:
// - Explicit pages (`source: "explicit"`).  The closed-stdlib
//   component emitter is part of Slice 6's broader page-emitter
//   work; for v0 the bulk-scaffold case has no explicit pages, so
//   they are silently skipped here and an explicit follow-up will
//   wire them in.

import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  PageIR,
  ScaffoldOriginIR,
  SystemIR,
  UiIR,
  ViewIR,
  WorkflowIR,
} from "../../ir/loom-ir.js";
import { camel, plural, snake } from "../../util/naming.js";
import {
  renderDetailPage,
  renderListPage,
  renderNewPage,
  renderViewTablePage,
  renderViewsIndex,
  renderWorkflowForm,
  renderWorkflowsIndex,
} from "./templating/render.js";
import type { LoadedPack } from "./templating/loader.js";
import { buildPageObjectModule } from "./page-objects-builder.js";
import { buildWorkflowPageObject } from "./workflow-builder.js";
import { buildViewPageObject } from "./view-builder.js";
import { isWalkableLayoutBody, renderCustomLayoutPage } from "./body-walker.js";

/** Inputs the page emitter needs in addition to the page IR.  Kept as
 *  a struct so additions (theme overrides, design-pack picks, sidebar
 *  spec) don't require re-threading every call site. */
export interface PageEmitContext {
  sys: SystemIR;
  deployable: DeployableIR;
  /** Pre-walked aggregates from the deployable's reachable contexts.
   *  Used by the per-aggregate builders to resolve `Id<X>` cross-
   *  references to display fields. */
  aggregatesByName: Map<string, AggregateIR>;
  /** Map context name → `BoundedContextIR` for fast `scaffoldOrigin`
   *  → ctx lookup. */
  contextsByName: Map<string, BoundedContextIR>;
  /** Loaded design pack (Phase 0 template-pack work).  Used by the
   *  list-page renderer; other archetypes use the legacy procedural
   *  builders. */
  pack: LoadedPack;
}

/** Emit `src/pages/<route>.tsx` per page in `ui.pages`.  Returns just
 *  the page-file map; api modules / page objects / shell files stay
 *  in `index.ts`. */
/** Slice 11.1 — collect the AppShell `extraRoutes` for non-
 *  conventional explicit pages.  Each one declared in the source
 *  with a body the dispatcher can recognise contributes one
 *  Route + import; conventional overrides (page name matches the
 *  scaffolded shape) are mounted at the conventional route by
 *  the existing per-aggregate / -workflow / -view loops in
 *  `prepareAppShellVM`. */
export function deriveExtraRoutesFromUi(
  ui: UiIR,
): import("./templating/preparers/app-shell.js").ExtraPageRoute[] {
  const out: import("./templating/preparers/app-shell.js").ExtraPageRoute[] = [];
  for (const page of ui.pages) {
    if (!page.route) continue;
    const origin = page.scaffoldOrigin ?? inferBodyDispatch(page.body);
    if (origin) {
      if (isConventionalOverride(page, origin)) continue;
      out.push({
        componentName: page.name,
        importFrom: `./pages/${snake(page.name)}`,
        route: page.route,
      });
      continue;
    }
    // Slice 11.3 — custom-layout pages (walker-rendered) also need
    // an App.tsx import + Route.
    if (isWalkableLayoutBody(page.body)) {
      out.push({
        componentName: page.name,
        importFrom: `./pages/${snake(page.name)}`,
        route: page.route,
      });
    }
  }
  return out;
}

export function emitPagesForUi(
  ui: UiIR,
  ctx: PageEmitContext,
  homeRenderer: (
    aggregates: AggregateIR[],
    workflows: WorkflowIR[],
    views: ViewIR[],
    systemName: string,
  ) => string,
): Map<string, string> {
  const out = new Map<string, string>();

  // The shared Home page wants the aggregate / workflow / view IRs
  // currently in scope; collect them once from `ui.pages` so
  // `homeRenderer` produces the same content the legacy direct-walk
  // produced.  Order: domain order from each context (matches the
  // legacy generator's `for (ctx of contexts) for (agg of ctx.aggregates)`
  // walk).
  const aggsForHome: AggregateIR[] = [];
  const wfsForHome: WorkflowIR[] = [];
  const viewsForHome: ViewIR[] = [];
  for (const ctxIR of ctx.contextsByName.values()) {
    for (const agg of ctxIR.aggregates) aggsForHome.push(agg);
    for (const wf of ctxIR.workflows) wfsForHome.push(wf);
    for (const v of ctxIR.views) viewsForHome.push(v);
  }

  for (const page of ui.pages) {
    // Slice 11 — every page (scaffold OR explicit) routes through
    // the same dispatch.  Synthesised pages already carry a
    // `scaffoldOrigin`; explicit pages with a recognisable body
    // (`body: List(of: Order)`, `body: Form(creates: T)`, etc.)
    // get one inferred from the body shape so the same renderer
    // table fires.
    const origin = page.scaffoldOrigin ?? inferBodyDispatch(page.body);
    if (origin) {
      emitScaffoldPage(page, origin, ctx, ui, {
        aggregates: aggsForHome,
        workflows: wfsForHome,
        views: viewsForHome,
        home: homeRenderer,
      }).forEach((content, path) => out.set(path, content));
      continue;
    }
    // Slice 11.3 — bodies that aren't a scaffold archetype but
    // ARE built from layout primitives (Stack / Heading / Text /
    // Button / Card) route through the recursive walker.  Output
    // goes to `src/pages/<name-snake>.tsx`; App.tsx routing comes
    // through `deriveExtraRoutesFromUi` (Slice 11.1).
    if (isWalkableLayoutBody(page.body)) {
      out.set(
        `src/pages/${snake(page.name)}.tsx`,
        // Slice 11.4 — pass the page's typed route params so the
        // walker can resolve refs to them and the page shell can
        // emit `useParams<{...}>()`.
        renderCustomLayoutPage(page.name, page.body!, page.params),
      );
      continue;
    }
    // Bodies the v0 dispatcher doesn't recognise are silently
    // skipped (e.g. user-defined components composed of stdlib
    // bits).  Future slice expands the walker's component table.
  }
  return out;
}

/** Recover a `ScaffoldOriginIR` from a page body's call shape.
 *  Scaffold-synthesised pages set this directly during lowering
 *  (`lowerPage` reads `body.kind === "call" && body.name === "List"`
 *  and produces the matching origin); for explicit pages we run the
 *  same inference at emit time so the dispatch table fires for both
 *  paths uniformly.  Returns `undefined` for bodies the v0
 *  dispatcher doesn't recognise — caller treats this as "skip
 *  emission."  When/if explicit pages need a deeper walker (custom
 *  layouts, nested components), this is the seam the v0.x slice
 *  swaps out. */
function inferBodyDispatch(
  body: import("../../ir/loom-ir.js").ExprIR | undefined,
): ScaffoldOriginIR | undefined {
  if (!body || body.kind !== "call") return undefined;
  const argNames = body.argNames ?? [];
  const argRef = (i: number): string | undefined => {
    const arg = body.args[i];
    if (!arg) return undefined;
    if (arg.kind === "ref") return arg.name;
    if (arg.kind === "literal" && arg.lit === "string") return arg.value;
    return undefined;
  };
  switch (body.name) {
    case "List": {
      if (argNames[0] !== "of") return undefined;
      const target = argRef(0);
      if (!target) return undefined;
      if (target.startsWith("view ")) {
        return {
          kind: "view-list",
          viewName: target.slice(5),
          contextName: "",
        };
      }
      return {
        kind: "aggregate-list",
        aggregateName: target,
        contextName: "",
      };
    }
    case "Form": {
      if (argNames[0] === "creates") {
        const target = argRef(0);
        if (!target) return undefined;
        return {
          kind: "aggregate-new",
          aggregateName: target,
          contextName: "",
        };
      }
      if (argNames[0] === "runs") {
        const target = argRef(0);
        if (!target) return undefined;
        return {
          kind: "workflow-form",
          workflowName: target,
          contextName: "",
        };
      }
      return undefined;
    }
    case "Detail": {
      if (argNames[0] !== "of") return undefined;
      const target = argRef(0);
      if (!target) return undefined;
      return {
        kind: "aggregate-detail",
        aggregateName: target,
        contextName: "",
      };
    }
    case "Home":
      return { kind: "home" };
    case "WorkflowsIndex":
      return { kind: "workflows-index" };
    case "ViewsIndex":
      return { kind: "views-index" };
    default:
      return undefined;
  }
}

interface SharedRenderInputs {
  aggregates: AggregateIR[];
  workflows: WorkflowIR[];
  views: ViewIR[];
  home: (
    aggregates: AggregateIR[],
    workflows: WorkflowIR[],
    views: ViewIR[],
    systemName: string,
  ) => string;
}

function emitScaffoldPage(
  page: PageIR,
  origin: ScaffoldOriginIR,
  ctx: PageEmitContext,
  _ui: UiIR,
  shared: SharedRenderInputs,
): Map<string, string> {
  const out = new Map<string, string>();
  // Slice 11.1 — file path for explicit pages with non-conventional
  // names (e.g. `page OrderConsole { route: "/custom/orders", body:
  // List(of: Order) }`) goes to `src/pages/<name-snake>.tsx` instead
  // of the conventional `src/pages/<plural>/list.tsx`.  Override-by-
  // name (page name == expected scaffolded name) keeps the
  // conventional path so it cleanly replaces the synthesised file.
  const conventional = isConventionalOverride(page, origin);
  switch (origin.kind) {
    case "aggregate-list": {
      const { agg, ctxIR } = lookupAggregate(origin, ctx);
      void ctxIR;
      const path = conventional
        ? `src/pages/${snake(plural(agg.name))}/list.tsx`
        : `src/pages/${snake(page.name)}.tsx`;
      out.set(path, renderListPage(agg, ctx.aggregatesByName, ctx.pack));
      return out;
    }
    case "aggregate-new": {
      const { agg, ctxIR } = lookupAggregate(origin, ctx);
      const path = conventional
        ? `src/pages/${snake(plural(agg.name))}/new.tsx`
        : `src/pages/${snake(page.name)}.tsx`;
      out.set(path, renderNewPage(agg, ctxIR, ctx.aggregatesByName, ctx.pack));
      return out;
    }
    case "aggregate-detail": {
      const { agg, ctxIR } = lookupAggregate(origin, ctx);
      const path = conventional
        ? `src/pages/${snake(plural(agg.name))}/detail.tsx`
        : `src/pages/${snake(page.name)}.tsx`;
      out.set(path, renderDetailPage(agg, ctxIR, ctx.aggregatesByName, ctx.pack));
      return out;
    }
    case "workflow-form": {
      // Slice 10 — `contextName` may be empty when the page was
      // synthesised by the AST expander; fall back to searching.
      let ctxIR = ctx.contextsByName.get(origin.contextName);
      let wf = ctxIR?.workflows.find((w) => w.name === origin.workflowName);
      if (!wf) {
        for (const c of ctx.contextsByName.values()) {
          const found = c.workflows.find((w) => w.name === origin.workflowName);
          if (found) {
            ctxIR = c;
            wf = found;
            break;
          }
        }
      }
      if (!wf || !ctxIR) return out;
      const wfPath = conventional
        ? `src/pages/workflows/${snake(wf.name)}.tsx`
        : `src/pages/${snake(page.name)}.tsx`;
      out.set(
        wfPath,
        renderWorkflowForm(wf, ctxIR, ctx.aggregatesByName, ctx.pack),
      );
      return out;
    }
    case "view-list": {
      let ctxIR = ctx.contextsByName.get(origin.contextName);
      let view = ctxIR?.views.find((v) => v.name === origin.viewName);
      if (!view) {
        for (const c of ctx.contextsByName.values()) {
          const found = c.views.find((v) => v.name === origin.viewName);
          if (found) {
            ctxIR = c;
            view = found;
            break;
          }
        }
      }
      if (!view || !ctxIR) return out;
      const viewPath = conventional
        ? `src/pages/views/${snake(view.name)}.tsx`
        : `src/pages/${snake(page.name)}.tsx`;
      out.set(
        viewPath,
        renderViewTablePage(view, ctxIR, ctx.aggregatesByName, ctx.pack),
      );
      return out;
    }
    case "workflows-index": {
      // The legacy generator's index page consumes the full context
      // list to enumerate every workflow's slug + label.  We replay
      // that input from `contextsByName` — order matches the legacy
      // walk.
      const contexts = [...ctx.contextsByName.values()];
      out.set(
        "src/pages/workflows/index.tsx",
        renderWorkflowsIndex(contexts, ctx.pack),
      );
      return out;
    }
    case "views-index": {
      const contexts = [...ctx.contextsByName.values()];
      out.set(
        "src/pages/views/index.tsx",
        renderViewsIndex(contexts, ctx.pack),
      );
      return out;
    }
    case "home": {
      out.set(
        "src/pages/home.tsx",
        shared.home(
          shared.aggregates,
          shared.workflows,
          shared.views,
          ctx.sys.name,
        ),
      );
      return out;
    }
  }
}

/** Return true when an explicit page is overriding a scaffold-
 *  synthesised one of the same archetype — i.e. the page name
 *  matches the conventional name the scaffold expander would
 *  generate.  Conventional overrides emit at the conventional
 *  file path (so they cleanly replace the synthesised file in
 *  App.tsx imports); non-conventional explicit pages emit at
 *  `src/pages/<name-snake>.tsx`. */
function isConventionalOverride(
  page: PageIR,
  origin: ScaffoldOriginIR,
): boolean {
  switch (origin.kind) {
    case "aggregate-list":
      return page.name === `${origin.aggregateName}List`;
    case "aggregate-new":
      return page.name === `${origin.aggregateName}New`;
    case "aggregate-detail":
      return page.name === `${origin.aggregateName}Detail`;
    case "workflow-form": {
      const wfName = origin.workflowName;
      const expected =
        wfName.length === 0
          ? "Workflow"
          : `${wfName[0]!.toUpperCase()}${wfName.slice(1)}Workflow`;
      return page.name === expected;
    }
    case "view-list":
      return page.name === `${origin.viewName}View`;
    case "home":
      return page.name === "Home";
    case "workflows-index":
      return page.name === "WorkflowsIndex";
    case "views-index":
      return page.name === "ViewsIndex";
  }
}

function lookupAggregate(
  origin: ScaffoldOriginIR & { kind: `aggregate-${string}` },
  ctx: PageEmitContext,
): { agg: AggregateIR; ctxIR: BoundedContextIR } {
  const agg = ctx.aggregatesByName.get(origin.aggregateName)!;
  // Slice 10 — `contextName` is `""` for pages synthesised by the
  // AST-to-AST expander (it doesn't track per-aggregate context
  // ownership).  Fall back to searching `contextsByName` for the
  // first context that contains this aggregate.
  let ctxIR = ctx.contextsByName.get(origin.contextName);
  if (!ctxIR) {
    for (const c of ctx.contextsByName.values()) {
      if (c.aggregates.some((a) => a.name === origin.aggregateName)) {
        ctxIR = c;
        break;
      }
    }
  }
  return { agg, ctxIR: ctxIR! };
}

// Re-export for callers that want to type-check `homeRenderer`'s
// signature without importing it from `index.ts` directly.
export type HomeRenderer = (
  aggregates: AggregateIR[],
  workflows: WorkflowIR[],
  views: ViewIR[],
  systemName: string,
) => string;

// camel is exported for legacy file paths (e2e/pages/<camel>.ts) that
// still live in index.ts; re-exported here so the page-objects
// builder can move in Slice 7 without re-importing naming utils.
export { camel };

// ---------------------------------------------------------------------------
// Slice 7 — Playwright page-object emission walked from `ui.pages`.
//
// Each scaffold-synthesised page contributes to its archetype's
// page-object file:
//
//   aggregate-list / aggregate-new / aggregate-detail
//     → one shared `e2e/pages/<camel-agg>.ts` per aggregate
//       (covers all three classes ListPage / NewPage / DetailPage)
//   workflow-form
//     → `e2e/pages/workflows/<snake-name>.ts` per workflow
//   view-list
//     → `e2e/pages/views/<snake-name>.ts` per view
//
// Output is byte-identical to the legacy aggregate-walked path for
// the bulk-scaffold case — same file paths, same content (the
// existing `buildPageObjectModule` / `buildWorkflowPageObject` /
// `buildViewPageObject` builders are reused verbatim).  The reroute
// is purely structural: page-IR drives iteration, builders unchanged.
// ---------------------------------------------------------------------------

export function emitPageObjectsForUi(
  ui: UiIR,
  ctx: PageEmitContext,
): Map<string, string> {
  const out = new Map<string, string>();
  const seenAggregates = new Set<string>();
  const seenWorkflows = new Set<string>();
  const seenViews = new Set<string>();

  for (const page of ui.pages) {
    // Slice 11 — explicit pages with recognisable bodies route
    // through the same dispatch as scaffold-synthesised pages.
    const origin = page.scaffoldOrigin ?? inferBodyDispatch(page.body);
    if (!origin) continue;
    switch (origin.kind) {
      case "aggregate-list":
      case "aggregate-new":
      case "aggregate-detail": {
        // One file per aggregate, regardless of how many of its
        // archetypes appear — the legacy `buildPageObjectModule`
        // covers ListPage / NewPage / DetailPage classes in one go.
        if (seenAggregates.has(origin.aggregateName)) break;
        seenAggregates.add(origin.aggregateName);
        const agg = ctx.aggregatesByName.get(origin.aggregateName);
        let ctxIR = ctx.contextsByName.get(origin.contextName);
        if (!ctxIR && agg) {
          // Slice 10 fallback: AST expander leaves `contextName: ""`.
          for (const c of ctx.contextsByName.values()) {
            if (c.aggregates.some((a) => a.name === agg.name)) {
              ctxIR = c;
              break;
            }
          }
        }
        if (!agg || !ctxIR) break;
        out.set(
          `e2e/pages/${camel(agg.name)}.ts`,
          buildPageObjectModule(agg, ctxIR),
        );
        break;
      }
      case "workflow-form": {
        if (seenWorkflows.has(origin.workflowName)) break;
        seenWorkflows.add(origin.workflowName);
        let ctxIR = ctx.contextsByName.get(origin.contextName);
        let wf = ctxIR?.workflows.find((w) => w.name === origin.workflowName);
        if (!wf) {
          for (const c of ctx.contextsByName.values()) {
            const found = c.workflows.find((w) => w.name === origin.workflowName);
            if (found) { ctxIR = c; wf = found; break; }
          }
        }
        if (!ctxIR || !wf) break;
        out.set(
          `e2e/pages/workflows/${snake(wf.name)}.ts`,
          buildWorkflowPageObject(wf, ctxIR),
        );
        break;
      }
      case "view-list": {
        if (seenViews.has(origin.viewName)) break;
        seenViews.add(origin.viewName);
        let ctxIR = ctx.contextsByName.get(origin.contextName);
        let view = ctxIR?.views.find((v) => v.name === origin.viewName);
        if (!view) {
          for (const c of ctx.contextsByName.values()) {
            const found = c.views.find((v) => v.name === origin.viewName);
            if (found) { ctxIR = c; view = found; break; }
          }
        }
        if (!ctxIR || !view) break;
        out.set(
          `e2e/pages/views/${snake(view.name)}.ts`,
          buildViewPageObject(view, ctxIR),
        );
        break;
      }
      // Index pages and Home don't produce page objects (no
      // testable form / table; the index pages are tested via
      // their child links, the home page via its summary cards).
      case "workflows-index":
      case "views-index":
      case "home":
        break;
    }
  }
  return out;
}
