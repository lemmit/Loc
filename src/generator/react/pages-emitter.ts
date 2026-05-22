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
  ParamIR,
  SystemIR,
  UiIR,
  ViewIR,
  WorkflowIR,
} from "../../ir/loom-ir.js";
import { camel, snake } from "../../util/naming.js";
import type { LoadedPack } from "../_packs/loader.js";
import { buildPageObjectModule } from "./page-objects-builder.js";
import { buildWorkflowPageObject } from "./workflow-builder.js";
import { buildViewPageObject } from "./view-builder.js";
import { isWalkableLayoutBody, walkBodyToTsx } from "./body-walker.js";
import {
  renderCustomLayoutPage,
  renderUserComponentFile,
} from "./walker/page-shell.js";
import { buildWalkerPageObject } from "./walker-page-objects.js";

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

/** Slice C2 — compute the relative-path prefix from a page's emit
 *  path back to the `src/` root.  Used by the walker shell to
 *  rewrite per-pack `../api/X` and `../lib/format` imports so they
 *  resolve correctly regardless of how deep the page lives.
 *
 *    src/pages/x.tsx                 → "../"
 *    src/pages/orders/list.tsx       → "../../"
 *    src/pages/views/active_orders/x → "../../../"
 *
 *  Robust to the legacy `src/` prefix that some emitter call sites
 *  pass; the leading "src/" segment is stripped before counting. */
function computeSrcImportPrefix(emitPath: string): string {
  let path = emitPath;
  if (path.startsWith("src/")) path = path.slice(4);
  // Count directory hops from `src/` (root) to the file's parent.
  // `pages/x.tsx` has one segment of directories (`pages/`) → 1 hop.
  // `pages/orders/list.tsx` has two (`pages/orders/`) → 2 hops.
  const dirCount = path.split("/").length - 1;
  return "../".repeat(Math.max(dirCount, 1));
}

/** Slice A4 — derived map: aggregate name → owning bounded context.
 *  Required by `Form(of: <Agg>)` and `IdLink(of: <Agg>)` so the
 *  walker can resolve enum / value-object types declared alongside
 *  the aggregate.  Built from `ctx.contextsByName` once per emit
 *  so the walker doesn't repeatedly scan all contexts. */
function buildBcByAggregate(
  ctx: PageEmitContext,
): Map<string, BoundedContextIR> {
  const out = new Map<string, BoundedContextIR>();
  for (const bc of ctx.contextsByName.values()) {
    for (const agg of bc.aggregates) out.set(agg.name, bc);
  }
  return out;
}

/** Slice A12 — derived map: workflow name → workflow IR.  Powers
 *  `Form(runs: <wf>)` field dispatch in the walker. */
function buildWorkflowsByName(
  ctx: PageEmitContext,
): Map<string, import("../../ir/loom-ir.js").WorkflowIR> {
  const out = new Map<
    string,
    import("../../ir/loom-ir.js").WorkflowIR
  >();
  for (const bc of ctx.contextsByName.values()) {
    for (const wf of bc.workflows) out.set(wf.name, wf);
  }
  return out;
}

/** Slice A12 — derived map: workflow name → owning bounded context. */
function buildBcByWorkflow(
  ctx: PageEmitContext,
): Map<string, BoundedContextIR> {
  const out = new Map<string, BoundedContextIR>();
  for (const bc of ctx.contextsByName.values()) {
    for (const wf of bc.workflows) out.set(wf.name, bc);
  }
  return out;
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
  // Slice 11.18 — same name→params map the page emitter builds, so
  // route derivation recognises pages whose body is a user-component
  // invocation.
  const userComponents = new Map<string, readonly ParamIR[]>();
  for (const c of ui.components) userComponents.set(c.name, c.params);
  // Slice A6 — helper names are also a walker-eligibility signal.
  const helperNames = new Set(ui.helperImports.map((h) => h.name));
  for (const page of ui.pages) {
    if (!page.route) continue;
    // Slice D1 — scaffold-conventional pages keep their AppShell-
    // managed routes (handled by the per-aggregate / per-workflow
    // / per-view loop in `prepareAppShellVM`); only EXPLICIT
    // user-written pages contribute extra routes here.  An
    // explicit page named identically to a scaffold-synthesised
    // one (e.g. a hand-written `OrderList`) overrides — the
    // AppShell loop sees both and keeps the conventional route
    // active; the explicit page's body simply replaces the
    // default rendering.
    if (page.scaffoldOrigin) continue;
    if (isWalkableLayoutBody(page.body, userComponents, helperNames)) {
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
): Map<string, string> {
  const out = new Map<string, string>();

  // Slice 11.18 — emit one `src/components/<Name>.tsx` per
  // user-defined component, and build a name→params map the
  // walker uses to resolve cross-component invocations.
  const userComponents = new Map<string, readonly ParamIR[]>();
  for (const c of ui.components) userComponents.set(c.name, c.params);
  for (const c of ui.components) {
    out.set(
      `src/components/${c.name}.tsx`,
      renderUserComponentFile(c.name, c.params, c.state, c.body, ctx.pack, userComponents),
    );
  }
  // Slice A6 — helper names accumulated for walker-eligibility
  // checks (`isWalkableLayoutBody`).  Same `ui.helperImports`
  // array is threaded to the per-page render call below.
  const helperNames = new Set(ui.helperImports.map((h) => h.name));

  for (const page of ui.pages) {
    // Slice 11 — every page (scaffold OR explicit) routes through
    // Slice D1 — every page (scaffold OR explicit) routes through
    // the walker.  Scaffold-synthesised pages had their bodies
    // rewritten in `lowerSystem`'s `expandScaffoldPages` pass, so
    // by the time we're here the body is always walker-eligible.
    // `scaffoldOrigin` is preserved on rewritten pages so the
    // per-aggregate page-object emitter (later in this file) still
    // fires the rich `e2e/pages/<agg>.ts` helper classes.
    if (isWalkableLayoutBody(page.body, userComponents, helperNames)) {
      // Slice C1 — `page.emitPath` overrides the default
      // `src/pages/<page-snake>.tsx` location.  Set by the
      // scaffold expander to land rewritten pages at their
      // conventional archetype path (`src/pages/<plural>/<arch>.tsx`)
      // so URL/file shape stays stable across the C2 default flip.
      const emitPath = page.emitPath ?? `src/pages/${snake(page.name)}.tsx`;
      // Slice C2 — relative-path prefix from the emitted TSX back
      // to `src/`.  Default-located walker pages (`src/pages/<x>.tsx`)
      // need 1 hop (`"../"`); scaffold-expanded pages at
      // `src/pages/<plural>/<arch>.tsx` need 2 hops (`"../../"`).
      // Computed from the depth difference between emitPath and
      // `src/`.
      const srcImportPrefix = computeSrcImportPrefix(emitPath);
      out.set(
        emitPath,
        renderCustomLayoutPage(
          page.name,
          page.body!,
          ctx.pack,
          page.params,
          page.state,
          page.title,
          userComponents,
          ui.apiParams,
          ctx.aggregatesByName,
          buildBcByAggregate(ctx),
          ui.helperImports,
          srcImportPrefix,
          buildWorkflowsByName(ctx),
          buildBcByWorkflow(ctx),
        ),
      );
      continue;
    }
    // Bodies the v0 dispatcher doesn't recognise are silently
    // skipped (e.g. user-defined components composed of stdlib
    // bits).  Future slice expands the walker's component table.
  }
  return out;
}


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
    // Slice D1 — only scaffold-origin pages dispatch to the
    // per-aggregate / per-workflow / per-view page-object
    // builders.  Explicit pages (no `scaffoldOrigin`) get the
    // walker-side per-page page-object emitted later.
    const origin = page.scaffoldOrigin;
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
  // Slice A5 — walker-emitted pages (those whose bodies are
  // recognised by `isWalkableLayoutBody` but NOT by the scaffold
  // dispatcher) get a parallel page-object emission: one class
  // per page, exposing every static `testid:` literal the walker
  // captured + form-synthesised testids.
  //
  // Path-collision contract: scaffold-archetype pages own
  // `e2e/pages/<aggregate-camel>.ts`; walker pages emit at
  // `e2e/pages/<page-snake>.ts`.  These namespaces don't collide
  // by construction (camel vs snake, aggregate vs page name), but
  // we still guard against an explicit page named identically to
  // a scaffold-aggregate fragment by skipping any walker output
  // whose path is already in `out`.
  const userComponents = buildUserComponentsMap(ui);
  const bcByAggregate = buildBcByAggregate(ctx);
  const helperNames = new Set(ui.helperImports.map((h) => h.name));
  for (const page of ui.pages) {
    // Skip scaffold-origin pages; per-aggregate page-objects above
    // covered them (with their richer fill/submit/expectRow surface).
    if (page.scaffoldOrigin) continue;
    if (!isWalkableLayoutBody(page.body, userComponents, helperNames)) continue;
    if (!page.body) continue;
    const paramNames = new Set(page.params.map((p) => p.name));
    const stateNames = new Set(page.state.map((s) => s.name));
    const { collectedTestids } = walkBodyToTsx(
      page.body,
      ctx.pack,
      paramNames,
      stateNames,
      userComponents,
      ui.apiParams,
      ctx.aggregatesByName,
      bcByAggregate,
      ui.helperImports,
    );
    const path = `e2e/pages/${snake(page.name)}.ts`;
    if (out.has(path)) continue;
    out.set(
      path,
      buildWalkerPageObject({
        pageName: page.name,
        params: page.params,
        route: page.route ?? "",
        testids: collectedTestids,
      }),
    );
  }
  return out;
}

/** Slice A5 — UI's component-name → ParamIR map, mirroring how
 *  `emitPagesForUi` builds it.  `isWalkableLayoutBody` calls this
 *  to decide whether a body composed of user components is
 *  walker-eligible. */
function buildUserComponentsMap(
  ui: UiIR,
): Map<string, readonly ParamIR[]> {
  const map = new Map<string, readonly ParamIR[]>();
  for (const c of ui.components) map.set(c.name, c.params);
  return map;
}
