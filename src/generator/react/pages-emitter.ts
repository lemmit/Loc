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
    // table fires.  Pages with a body the dispatcher doesn't
    // recognise (custom layouts, unknown stdlib component names)
    // are skipped silently for now — Slice 11.1 will route them
    // through a deeper component-table walker.
    const origin =
      page.scaffoldOrigin ?? inferBodyDispatch(page.body);
    if (!origin) continue;
    emitScaffoldPage(page, origin, ctx, ui, {
      aggregates: aggsForHome,
      workflows: wfsForHome,
      views: viewsForHome,
      home: homeRenderer,
    }).forEach((content, path) => out.set(path, content));
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
  _page: PageIR,
  origin: ScaffoldOriginIR,
  ctx: PageEmitContext,
  _ui: UiIR,
  shared: SharedRenderInputs,
): Map<string, string> {
  const out = new Map<string, string>();
  switch (origin.kind) {
    case "aggregate-list": {
      const { agg, ctxIR } = lookupAggregate(origin, ctx);
      void ctxIR;
      out.set(
        `src/pages/${snake(plural(agg.name))}/list.tsx`,
        renderListPage(agg, ctx.aggregatesByName, ctx.pack),
      );
      return out;
    }
    case "aggregate-new": {
      const { agg, ctxIR } = lookupAggregate(origin, ctx);
      out.set(
        `src/pages/${snake(plural(agg.name))}/new.tsx`,
        renderNewPage(agg, ctxIR, ctx.aggregatesByName, ctx.pack),
      );
      return out;
    }
    case "aggregate-detail": {
      const { agg, ctxIR } = lookupAggregate(origin, ctx);
      out.set(
        `src/pages/${snake(plural(agg.name))}/detail.tsx`,
        renderDetailPage(agg, ctxIR, ctx.aggregatesByName, ctx.pack),
      );
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
      out.set(
        `src/pages/workflows/${snake(wf.name)}.tsx`,
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
      out.set(
        `src/pages/views/${snake(view.name)}.tsx`,
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
