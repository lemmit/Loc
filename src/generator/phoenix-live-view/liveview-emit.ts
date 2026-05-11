// ---------------------------------------------------------------------------
// Phase 7 — LiveView module emission per page.
//
// For each `PageIR` declared by the deployable's `ui:` block, emit:
//   - lib/<app>_web/live/<page_snake>_live.ex — a Phoenix LiveView module
//     with mount/3 (state init), handle_params/3 (route param bind +
//     `requires` guard), handle_event/3 (per onSubmit/Action lambda),
//     and render(assigns) (delegates to the ashPhoenix pack template
//     for that page's archetype).
//
// Scaffolded pages (the only kind acme.ddd uses today) have a
// `scaffoldOrigin` discriminator that tells us which pack template
// to render: `aggregate-list` → `page-list`, `aggregate-new` →
// `page-new`, etc.  The view-model is built from the same
// framework-neutral preparers the React generator uses
// (src/generator/react/templating/preparers/) — those preparers
// return rich VMs whose framework-specific fields the HEEx pack
// templates simply ignore.
//
// Custom pages with explicit `body:` expressions (no scaffoldOrigin)
// require the HEEx walker — deferred to the next iteration.  v0
// emits a stub `render` for them with a TODO comment.
//
// Also returns a list of `live "<route>", <Module>` entries the
// orchestrator splices into router.ex.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  PageIR,
  SystemIR,
  UiIR,
} from "../../ir/loom-ir.js";
import { camel, pascal, plural, snake } from "../../util/naming.js";
import { loadPack, resolvePackDir } from "../react/templating/loader-fs.js";
import type { LoadedPack } from "../react/templating/loader.js";
import { prepareDetailPageVM } from "../react/templating/preparers/detail.js";
import { prepareListPageVM } from "../react/templating/preparers/list.js";
import { prepareNewPageVM } from "../react/templating/preparers/new.js";
import {
  defaultInitFor,
  renderRequiresGuard,
  walkBodyToHeex,
  type HandleEventClause,
} from "./heex-walker.js";
import {
  renderHomeHeex,
  renderViewsIndexHeex,
  renderViewTableHeex,
  renderWorkflowFormHeex,
  renderWorkflowsIndexHeex,
} from "./extra-archetype-emit.js";
import { buildPlaywrightPageObject } from "./page-objects-emit.js";

/** One router entry the orchestrator splices into router.ex. */
export interface LiveRoute {
  route: string;
  liveModule: string;
}

export function emitLiveViewPages(args: {
  contexts: BoundedContextIR[];
  deployable: DeployableIR;
  sys: SystemIR;
  appName: string;
  appModule: string;
}): { files: Map<string, string>; routes: LiveRoute[] } {
  const { contexts, deployable, sys, appName, appModule } = args;
  const out = new Map<string, string>();
  const routes: LiveRoute[] = [];

  // Locate the UI block this deployable mounts.  Backends without a
  // `ui:` binding skip — they only emit the API surface.
  if (!deployable.uiName) return { files: out, routes };
  const ui = sys.uis.find((u) => u.name === deployable.uiName);
  if (!ui) return { files: out, routes };

  // Workspace-wide aggregate registry — needed by the preparers'
  // Id<X>-target lookups across bounded contexts.
  const aggregatesByName = new Map<string, AggregateIR>();
  const contextByAggName = new Map<string, BoundedContextIR>();
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      aggregatesByName.set(agg.name, agg);
      contextByAggName.set(agg.name, ctx);
    }
  }

  // Load the design pack (defaults to `ashPhoenix` for this platform —
  // src/ir/lower.ts populates `deployable.design` accordingly).
  const designName = deployable.design ?? "ashPhoenix";
  let pack: LoadedPack;
  try {
    pack = loadPack(resolvePackDir(designName));
  } catch (e) {
    // Pack load failures should be loud, not silent — but don't
    // abort the whole project emission; we'd rather see the partial
    // tree (router, layouts, domain) than nothing.
    const msg = e instanceof Error ? e.message : String(e);
    out.set(
      `lib/${appName}_web/live/_PACK_LOAD_ERROR.txt`,
      `# Pack '${designName}' failed to load: ${msg}\n`,
    );
    return { files: out, routes };
  }

  for (const page of ui.pages) {
    if (!page.route) continue; // can't emit a router entry without one
    const liveModule = `${appModule}Web.${pascal(page.name)}Live`;
    const filePath = `lib/${appName}_web/live/${snake(page.name)}_live.ex`;
    const source = renderLiveView({
      page,
      liveModule,
      appName,
      appModule,
      pack,
      aggregatesByName,
      contextByAggName,
      ui,
      contexts,
      sys,
    });
    out.set(filePath, source);
    routes.push({ route: page.route, liveModule });

    // Playwright page object — Batch C emission.  Mirrors the React
    // generator's per-page `e2e/pages/<page>.ts` so `test e2e ui`
    // blocks (src/system/ui-e2e-render.ts) drive the Phoenix
    // deployable identically to a React one.
    const pageObjectSource = buildPlaywrightPageObject({
      page,
      appName,
      aggregatesByName,
      contextByAggName,
    });
    out.set(`e2e/pages/${snake(page.name)}.ts`, pageObjectSource);
  }

  return { files: out, routes };
}

interface RenderArgs {
  page: PageIR;
  liveModule: string;
  appName: string;
  appModule: string;
  pack: LoadedPack;
  aggregatesByName: Map<string, AggregateIR>;
  contextByAggName: Map<string, BoundedContextIR>;
  ui: UiIR;
  contexts: BoundedContextIR[];
  sys: SystemIR;
}

function renderLiveView(a: RenderArgs): string {
  const { page, liveModule, appModule, ui } = a;
  const webModule = `${appModule}Web`;

  // Scaffold pages render through the pack templates; non-scaffold
  // pages route through the HEEx walker (Batch B).  The walker also
  // produces handle_event clauses + alias lines from helper imports
  // that the body actually references.
  let heex: string;
  let handlers: HandleEventClause[] = [];
  let aliasLines: string[] = [];
  if (page.scaffoldOrigin) {
    heex = renderPageHeex(a);
  } else {
    const walked = walkBodyToHeex(page.body, page, ui, appModule);
    heex = walked.heex;
    handlers = walked.handlers;
    aliasLines = walked.aliasLines;
  }

  const mount = renderMount(page);
  const handleParams = renderHandleParams(page, ui, appModule);
  const handleEventClauses = renderHandleEventClauses(handlers);
  const aliasBlock = aliasLines.length > 0 ? aliasLines.join("\n") + "\n" : "";

  return `# Auto-generated.
defmodule ${liveModule} do
  use ${webModule}, :live_view
${aliasBlock}
${mount}

${handleParams}
${handleEventClauses}
  @impl true
  def render(assigns) do
    ~H"""
${indent(heex, 4)}
    """
  end
end
`;
}

function renderHandleEventClauses(handlers: HandleEventClause[]): string {
  if (handlers.length === 0) return "";
  return (
    "\n" +
    handlers
      .map(
        (h) =>
          `  @impl true
  def handle_event(${JSON.stringify(h.name)}, ${h.paramsPattern}, socket) do
${h.body.join("\n")}
  end\n`,
      )
      .join("\n")
  );
}

function renderPageHeex(a: RenderArgs): string {
  const { page, pack, aggregatesByName, contextByAggName, contexts, sys } = a;
  const origin = page.scaffoldOrigin;
  if (!origin) {
    // Custom page bodies are handled by the HEEx walker (Batch B) at
    // the renderLiveView level — this function is only called for
    // scaffold-origin pages.
    return `<!-- non-scaffold page should route through the walker -->`;
  }
  switch (origin.kind) {
    case "aggregate-list": {
      const agg = aggregatesByName.get(origin.aggregateName);
      if (!agg) return `<!-- aggregate '${origin.aggregateName}' not found -->`;
      const vm = prepareListPageVM(agg, aggregatesByName);
      return safeRender(pack, "page-list", vm, page.name);
    }
    case "aggregate-new": {
      const agg = aggregatesByName.get(origin.aggregateName);
      const ctx = contextByAggName.get(origin.aggregateName);
      if (!agg || !ctx) return `<!-- aggregate '${origin.aggregateName}' not found -->`;
      const vm = prepareNewPageVM(agg, ctx, aggregatesByName);
      return safeRender(pack, "page-new", vm, page.name);
    }
    case "aggregate-detail": {
      const agg = aggregatesByName.get(origin.aggregateName);
      const ctx = contextByAggName.get(origin.aggregateName);
      if (!agg || !ctx) return `<!-- aggregate '${origin.aggregateName}' not found -->`;
      const vm = prepareDetailPageVM(agg, ctx, aggregatesByName);
      return safeRender(pack, "page-detail", vm, page.name);
    }
    case "workflow-form":
      return renderWorkflowFormHeex({
        workflowName: origin.workflowName,
        contextName: origin.contextName,
        contexts,
        aggregatesByName,
        pack,
      });
    case "view-list":
      return renderViewTableHeex({
        viewName: origin.viewName,
        contextName: origin.contextName,
        contexts,
        aggregatesByName,
        pack,
      });
    case "workflows-index":
      return renderWorkflowsIndexHeex({ contexts, pack });
    case "views-index":
      return renderViewsIndexHeex({ contexts, pack });
    case "home":
      return renderHomeHeex({ contexts, sysName: sys.name, pack });
  }
}

function safeRender(pack: LoadedPack, templateName: string, vm: unknown, pageName: string): string {
  try {
    return pack.render(templateName, vm);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `<!-- pack template '${templateName}' for page '${pageName}' failed: ${msg.replace(/-->/g, "--&gt;")} -->`;
  }
}

function renderMount(page: PageIR): string {
  const assigns: string[] = [];
  for (const f of page.state) {
    // Type-aware default from the walker — single source of truth so
    // `state.field` defaults match across scaffold and custom pages.
    assigns.push(`      |> assign(:${snake(f.name)}, ${defaultInitFor(f.type)})`);
  }
  if (assigns.length === 0) {
    return `  @impl true
  def mount(_params, _session, socket) do
    {:ok, socket}
  end`;
  }
  return `  @impl true
  def mount(_params, _session, socket) do
    socket =
      socket
${assigns.join("\n")}
    {:ok, socket}
  end`;
}

function renderHandleParams(page: PageIR, ui: UiIR, appModule: string): string {
  const paramAssigns: string[] = [];
  for (const p of page.params) {
    paramAssigns.push(`      |> assign(:${snake(p.name)}, params["${camel(p.name)}"])`);
  }
  // `requires <pred>` lowers to a guard that push_navigates to the
  // root and flashes "forbidden" when the predicate is false.  The
  // walker renders the predicate in handler position (so state refs
  // resolve to `socket.assigns.…`).
  const guard = renderRequiresGuard(page, ui, appModule);
  const guardBlock = guard
    ? `    if not (${guard}) do
      {:noreply, socket |> put_flash(:error, "forbidden") |> push_navigate(to: "/")}
    else
`
    : "";
  const guardClose = guard ? `    end` : "";
  const noParamsBody = guard
    ? `${guardBlock}      {:noreply, socket}
${guardClose}`
    : `    {:noreply, socket}`;
  const withParamsBody = guard
    ? `${guardBlock}      socket =
        socket
${paramAssigns.map((l) => "  " + l).join("\n")}
      {:noreply, socket}
${guardClose}`
    : `    socket =
      socket
${paramAssigns.join("\n")}
    {:noreply, socket}`;
  if (paramAssigns.length === 0) {
    return `  @impl true
  def handle_params(_params, _uri, socket) do
${noParamsBody}
  end`;
  }
  return `  @impl true
  def handle_params(params, _uri, socket) do
${withParamsBody}
  end`;
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

// Suppress unused-import lints for re-exports.
void plural;
