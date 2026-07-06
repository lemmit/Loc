// Page emitter — SvelteKit file-based routing edition.
//
// Walks `ui.pages` (post scaffold expansion) and emits one
// `+page.svelte` per routable page under `src/routes/…`, mapping the
// page metamodel's route strings + layout selectors onto SvelteKit's
// conventions:
//
//   route "/orders"        → src/routes/(app)/orders/+page.svelte
//   route "/orders/:id"    → src/routes/(app)/orders/[id]/+page.svelte
//   route "/"              → src/routes/(app)/+page.svelte
//   layout: none           → the (bare) group (root layout only — no chrome)
//   layout: <Name>         → the (app) group for now (named-layout
//                            parity is a follow-up slice; the page
//                            still renders inside the default chrome)
//
// Route groups `(app)` / `(bare)` don't contribute URL segments —
// the chrome lives at src/routes/(app)/+layout.svelte while the root
// layout owns the query-client provider + toaster, so `layout: none`
// pages skip the chrome but keep the app plumbing.
//
// Sibling of src/generator/react/pages-emitter.ts; the per-page
// module assembly lives in walker/page-shell.ts.

import type {
  AggregateIR,
  BoundedContextIR,
  ComponentIR,
  DeployableIR,
  PageIR,
  ParamIR,
  SystemIR,
  UiIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { classifyPage, type PageNameCtx, pageConstructId } from "../../ir/util/page-kind.js";
import { lowerFirst, plural, snake } from "../../util/naming.js";
import {
  buildExternFunctionShim,
  buildExternFunctionSignature,
} from "../_frontend/extern-functions.js";
import { buildPageObjectModule } from "../_frontend/page-objects-builder.js";
import { buildViewPageObject } from "../_frontend/view-page-object.js";
import { buildWalkerPageObject } from "../_frontend/walker-page-objects.js";
import { buildWorkflowPageObject } from "../_frontend/workflow-page-object.js";
import type { LoadedPack } from "../_packs/loader.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import { isWalkableLayoutBody, walkBody } from "../_walker/walker-core.js";
import { svelteLayoutGroup } from "./layouts-emitter.js";
import {
  renderSvelteComponentFile,
  renderSvelteExternComponentProps,
  renderSvelteExternComponentShim,
  renderSveltePage,
} from "./walker/page-shell.js";
import { svelteTarget } from "./walker/svelte-target.js";

export interface SveltePageEmitContext {
  sys: SystemIR;
  deployable: DeployableIR;
  aggregatesByName: Map<string, AggregateIR>;
  contextsByName: Map<string, BoundedContextIR>;
  pack: LoadedPack;
  topLevelComponents: readonly ComponentIR[];
  /** True when the frontend opts into `auth: ui` — a page's `requires` gate
   *  then renders a client-side `{#if}`-guarded `<Forbidden/>` against the
   *  verified session claims.  Optional: absent ⇒ ungated. */
  authUi?: boolean;
  /** Generate-time source-map recorder (`--sourcemap`) — see
   *  `PlatformSurface.emitProject`'s doc comment.  Absent means "record
   *  nothing" (the default, flag-off shape). */
  sourcemap?: SourceMapRecorder;
}

/** Translate a page-metamodel route to a SvelteKit route directory
 *  (no group segment).  `:param` segments become `[param]`; the root
 *  route maps to the group directory itself. */
export function routeToKitDir(route: string): string {
  const segs = route.split("/").filter((s) => s.length > 0);
  return segs.map((s) => (s.startsWith(":") ? `[${s.slice(1)}]` : s)).join("/");
}

/** The route group a page's layout selector maps to:
 *   - `layout: none`     → `(bare)` (root layout only, no chrome)
 *   - `layout: <Name>`   → `(<name>)` (the named layout's group, whose
 *     `+layout.svelte` is emitted by layouts-emitter)
 *   - default            → `(app)` (the default chrome) */
function groupForLayout(page: PageIR): string {
  if (page.layout?.kind === "preset" && page.layout.name === "none") return "(bare)";
  if (page.layout?.kind === "named") return svelteLayoutGroup(page.layout.ref);
  return "(app)";
}

/** Emit path for a routable page. */
export function sveltePagePath(page: PageIR): string | undefined {
  if (!page.route) return undefined;
  const dir = routeToKitDir(page.route);
  const group = groupForLayout(page);
  return dir === ""
    ? `src/routes/${group}/+page.svelte`
    : `src/routes/${group}/${dir}/+page.svelte`;
}

function buildBcByAggregate(ctx: SveltePageEmitContext): Map<string, BoundedContextIR> {
  const out = new Map<string, BoundedContextIR>();
  for (const bc of ctx.contextsByName.values()) {
    for (const agg of bc.aggregates) out.set(agg.name, bc);
  }
  return out;
}

function buildWorkflowsByName(ctx: SveltePageEmitContext): Map<string, WorkflowIR> {
  const out = new Map<string, WorkflowIR>();
  for (const bc of ctx.contextsByName.values()) {
    for (const wf of bc.workflows) out.set(wf.name, wf);
  }
  return out;
}

function buildBcByWorkflow(ctx: SveltePageEmitContext): Map<string, BoundedContextIR> {
  const out = new Map<string, BoundedContextIR>();
  for (const bc of ctx.contextsByName.values()) {
    for (const wf of bc.workflows) out.set(wf.name, bc);
  }
  return out;
}

export function emitSveltePagesForUi(ui: UiIR, ctx: SveltePageEmitContext): Map<string, string> {
  const out = new Map<string, string>();

  const userComponents = new Map<string, readonly ParamIR[]>();
  for (const c of ctx.topLevelComponents) userComponents.set(c.name, c.params);
  for (const c of ui.components) userComponents.set(c.name, c.params);
  const pageRoutes = new Map<string, string>();
  for (const page of ui.pages) {
    if (page.route) pageRoutes.set(page.name, page.route);
  }

  // Extern frontend functions (extern-function-hook-escape-hatch.md §3):
  // same two machine-owned files as react — the wire-DTO-typed
  // signature (`src/lib/extern/<name>.signature.ts`, api modules at
  // `../api` on SvelteKit) and the conformance shim
  // (`src/lib/<name>.ts`); body calls register through
  // `externFunctionNames` and the page / component shells import each
  // used shim as `$lib/<name>`.
  const externFunctionNames = new Set<string>();
  for (const fn of ui.functions ?? []) {
    externFunctionNames.add(fn.name);
    out.set(`src/lib/extern/${fn.name}.signature.ts`, buildExternFunctionSignature(fn, "../api"));
    out.set(`src/lib/${fn.name}.ts`, buildExternFunctionShim(fn));
  }

  // User components — `src/lib/components/<Name>.svelte`, ui-scope
  // shadowing top-level on name collision.  Extern components are a
  // follow-up parity slice for svelte; surface loudly rather than
  // emit a broken import.
  const emittedComponents = new Map<string, ComponentIR>();
  for (const c of ctx.topLevelComponents) emittedComponents.set(c.name, c);
  for (const c of ui.components) emittedComponents.set(c.name, c);
  for (const c of emittedComponents.values()) {
    const componentConstruct = `${ui.name}.${c.name}`;
    // Extern component: Loom owns a re-export wrapper at
    // `src/lib/components/<Name>.svelte` (so call sites import
    // `$lib/components/<Name>.svelte` unchanged) + a typed
    // `<Name>.props.ts`; the user owns the hand-written module at the
    // `from` path.  No body is walked.
    if (c.extern) {
      const shimPath = `src/lib/components/${c.name}.svelte`;
      const shimContent = renderSvelteExternComponentShim(c.name, c.externPath ?? "");
      out.set(shimPath, shimContent);
      ctx.sourcemap?.file(shimPath, shimContent, c.origin, componentConstruct);
      const propsPath = `src/lib/components/${c.name}.props.ts`;
      const propsContent = renderSvelteExternComponentProps(
        c.name,
        [...c.params],
        ctx.aggregatesByName,
      );
      out.set(propsPath, propsContent);
      ctx.sourcemap?.file(propsPath, propsContent, c.origin, componentConstruct);
      continue;
    }
    const componentPath = `src/lib/components/${c.name}.svelte`;
    const componentContent = renderSvelteComponentFile(
      c.name,
      [...c.params],
      c.state,
      c.body!,
      ctx.pack,
      userComponents,
      ctx.aggregatesByName,
      buildBcByAggregate(ctx),
      pageRoutes,
      externFunctionNames,
      c.derived,
      // `auth: ui` enables currentUser-only operation-`requires` gating on
      // `Action(...)` buttons in this component.
      ctx.authUi,
      // Named, typed component event handlers (Proposal A Stage 1).
      c.actions,
      // Shared client-side stores (Stage 5) — for store-import + bindings.
      ui.stores,
    );
    out.set(componentPath, componentContent);
    ctx.sourcemap?.file(componentPath, componentContent, c.origin, componentConstruct);
  }

  const seenPaths = new Map<string, string>();
  for (const page of ui.pages) {
    if (!isWalkableLayoutBody(page.body, userComponents)) continue;
    const emitPath = sveltePagePath(page);
    if (!emitPath) continue;
    const prior = seenPaths.get(emitPath);
    if (prior) {
      throw new Error(
        `svelte: pages '${prior}' and '${page.name}' both route to ${emitPath} — SvelteKit file routing needs distinct routes per page.`,
      );
    }
    seenPaths.set(emitPath, page.name);
    const pageContent = renderSveltePage(
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
      buildWorkflowsByName(ctx),
      buildBcByWorkflow(ctx),
      pageRoutes,
      externFunctionNames,
      page.derived,
      // `page { requires <expr> }` UI gate — only when a verified session is
      // available to evaluate it against.
      ctx.authUi ? page.requires : undefined,
      // `auth: ui` also enables currentUser-only operation-`requires` gating
      // on `Action(...)` buttons inside the body.
      ctx.authUi,
      // Named, typed page event handlers (Proposal A Stage 1).
      page.actions,
      // Shared client-side stores (Stage 5) — for store-import + bindings.
      ui.stores,
    );
    out.set(emitPath, pageContent);
    ctx.sourcemap?.file(emitPath, pageContent, page.origin, pageConstructId(ui.name, page));
  }
  return out;
}

/** Nav-entry data for the app-shell template — the default grouped
 *  sidebar (Aggregates / Workflows / Views) mirroring the react
 *  shell's hardcoded grouping, overridden by an explicit `ui.menu`
 *  via the shared `deriveSidebarFromUi`. */
export function defaultNavSections(
  scaffoldedAggregates: readonly AggregateIR[],
  scaffoldedWorkflows: readonly WorkflowIR[],
  scaffoldedViewNames: readonly string[],
  hasWorkflowsIndex: boolean,
  hasViewsIndex: boolean,
): Array<{ label: string; entries: Array<{ to: string; label: string; testId: string }> }> {
  const sections: Array<{
    label: string;
    entries: Array<{ to: string; label: string; testId: string }>;
  }> = [];
  if (scaffoldedAggregates.length > 0) {
    sections.push({
      label: "Aggregates",
      entries: scaffoldedAggregates.map((a) => {
        const slug = snake(plural(a.name));
        return { to: `/${slug}`, label: plural(a.name), testId: `nav-${slug}` };
      }),
    });
  }
  const wfEntries: Array<{ to: string; label: string; testId: string }> = [];
  if (hasWorkflowsIndex) {
    wfEntries.push({ to: "/workflows", label: "All workflows", testId: "nav-workflows" });
  }
  for (const wf of scaffoldedWorkflows) {
    wfEntries.push({
      to: `/workflows/${snake(wf.name)}`,
      label: wf.name,
      testId: `nav-workflow-${snake(wf.name)}`,
    });
  }
  if (wfEntries.length > 0) sections.push({ label: "Workflows", entries: wfEntries });
  const viewEntries: Array<{ to: string; label: string; testId: string }> = [];
  if (hasViewsIndex) {
    viewEntries.push({ to: "/views", label: "All views", testId: "nav-views" });
  }
  for (const v of scaffoldedViewNames) {
    viewEntries.push({ to: `/views/${snake(v)}`, label: v, testId: `nav-view-${snake(v)}` });
  }
  if (viewEntries.length > 0) sections.push({ label: "Views", entries: viewEntries });
  return sections;
}

/** Playwright page-object emission — same dispatch rules as the
 *  react pages-emitter (scaffold-origin pages route to the shared
 *  per-aggregate / per-workflow / per-view builders; custom walker
 *  pages get a per-page class from their collected testids).  Only
 *  the api-module import root differs (`src/lib/api` in SvelteKit
 *  projects). */
/** Served decl names for `classifyPage` (slice 3c — replaces stamped `origin`). */
function sveltePageNameCtx(ctx: SveltePageEmitContext): PageNameCtx {
  const workflowNames: string[] = [];
  const viewNames: string[] = [];
  for (const bc of ctx.contextsByName.values()) {
    for (const wf of bc.workflows) workflowNames.push(wf.name);
    for (const v of bc.views) viewNames.push(v.name);
  }
  return { aggregateNames: [...ctx.aggregatesByName.keys()], workflowNames, viewNames };
}

export function emitSveltePageObjectsForUi(
  ui: UiIR,
  ctx: SveltePageEmitContext,
): Map<string, string> {
  const out = new Map<string, string>();
  const pageCtx = sveltePageNameCtx(ctx);
  const seenAggregates = new Set<string>();
  const seenWorkflows = new Set<string>();
  const seenViews = new Set<string>();

  for (const page of ui.pages) {
    const origin = classifyPage(page, pageCtx);
    if (origin.kind === "custom") continue;
    switch (origin.kind) {
      case "aggregate-list":
      case "aggregate-new":
      case "aggregate-detail": {
        if (seenAggregates.has(origin.aggregateName)) break;
        seenAggregates.add(origin.aggregateName);
        const agg = ctx.aggregatesByName.get(origin.aggregateName);
        let ctxIR = ctx.contextsByName.get(origin.contextName);
        if (!ctxIR && agg) {
          for (const c of ctx.contextsByName.values()) {
            if (c.aggregates.some((a) => a.name === agg.name)) {
              ctxIR = c;
              break;
            }
          }
        }
        if (!agg || !ctxIR) break;
        out.set(
          `e2e/pages/${lowerFirst(agg.name)}.ts`,
          buildPageObjectModule(agg, ctxIR, "../../src/lib/api", "native"),
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
            if (found) {
              ctxIR = c;
              wf = found;
              break;
            }
          }
        }
        if (!ctxIR || !wf) break;
        out.set(
          `e2e/pages/workflows/${snake(wf.name)}.ts`,
          buildWorkflowPageObject(wf, ctxIR, "../../../src/lib/api", "native"),
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
            if (found) {
              ctxIR = c;
              view = found;
              break;
            }
          }
        }
        if (!ctxIR || !view) break;
        out.set(`e2e/pages/views/${snake(view.name)}.ts`, buildViewPageObject(view, ctxIR));
        break;
      }
      case "workflows-index":
      case "views-index":
      case "home":
        break;
    }
  }

  // Custom walker pages — per-page class over the collected testids.
  const userComponents = new Map<string, readonly ParamIR[]>();
  for (const c of ctx.topLevelComponents) userComponents.set(c.name, c.params);
  for (const c of ui.components) userComponents.set(c.name, c.params);
  const bcByAggregate = buildBcByAggregate(ctx);
  for (const page of ui.pages) {
    if (classifyPage(page, pageCtx).kind !== "custom") continue;
    if (!isWalkableLayoutBody(page.body, userComponents)) continue;
    if (!page.body) continue;
    const paramNames = new Set(page.params.map((p) => p.name));
    const stateNames = new Set(page.state.map((st) => st.name));
    const { collectedTestids } = walkBody(
      page.body,
      svelteTarget,
      ctx.pack,
      paramNames,
      stateNames,
      userComponents,
      ui.apiParams,
      ctx.aggregatesByName,
      bcByAggregate,
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
