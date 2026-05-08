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
    if (page.source !== "scaffold" || !page.scaffoldOrigin) {
      // Slice 6 will own the explicit-page emission via the closed-
      // stdlib component table.  For v0 the bulk-scaffold case has
      // no explicit pages.
      continue;
    }
    emitScaffoldPage(page, page.scaffoldOrigin, ctx, ui, {
      aggregates: aggsForHome,
      workflows: wfsForHome,
      views: viewsForHome,
      home: homeRenderer,
    }).forEach((content, path) => out.set(path, content));
  }
  return out;
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
      const ctxIR = ctx.contextsByName.get(origin.contextName);
      const wf = ctxIR?.workflows.find((w) => w.name === origin.workflowName);
      if (!wf || !ctxIR) return out;
      out.set(
        `src/pages/workflows/${snake(wf.name)}.tsx`,
        renderWorkflowForm(wf, ctxIR, ctx.aggregatesByName, ctx.pack),
      );
      return out;
    }
    case "view-list": {
      const ctxIR = ctx.contextsByName.get(origin.contextName);
      const view = ctxIR?.views.find((v) => v.name === origin.viewName);
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
  const ctxIR = ctx.contextsByName.get(origin.contextName)!;
  const agg = ctx.aggregatesByName.get(origin.aggregateName)!;
  return { agg, ctxIR };
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
    const origin = page.scaffoldOrigin;
    if (!origin) continue; // Explicit pages don't yet emit page objects.
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
        const ctxIR = ctx.contextsByName.get(origin.contextName);
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
        const ctxIR = ctx.contextsByName.get(origin.contextName);
        const wf = ctxIR?.workflows.find((w) => w.name === origin.workflowName);
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
        const ctxIR = ctx.contextsByName.get(origin.contextName);
        const view = ctxIR?.views.find((v) => v.name === origin.viewName);
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
