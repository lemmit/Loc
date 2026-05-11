// ---------------------------------------------------------------------------
// Phase 7 — LiveView module emission per page.
//
// For each `PageIR` declared by the deployable's `ui:` block, emit:
//   - lib/<app>_web/live/<page_snake>_live.ex — a Phoenix LiveView module
//     with mount/3 (state init), handle_params/3 (route param bind +
//     `requires` guard), handle_event/3 (per onSubmit/Action lambda),
//     and render(assigns) — HEEx body emitted by the heex-walker.
//
// All pages (scaffold and custom) route through the HEEx walker.
// Scaffold pages have their `body` rewritten by `expandScaffoldPages()`
// (src/ir/lower.ts) before the emitter runs, so `page.body` is always
// a walker-stdlib `ExprIR` tree.  The walker (heex-walker.ts::walkBodyToHeex)
// emits HEEx directly — no pack templates for full pages.
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
import {
  defaultInitFor,
  renderRequiresGuard,
  walkBodyToHeex,
  type HandleEventClause,
} from "./heex-walker.js";
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

  // Workspace-wide aggregate registry — needed by the page-object
  // emitter's domain-method synthesis (fill, submit, expectRow).
  const aggregatesByName = new Map<string, AggregateIR>();
  const contextByAggName = new Map<string, BoundedContextIR>();
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      aggregatesByName.set(agg.name, agg);
      contextByAggName.set(agg.name, ctx);
    }
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
      ui,
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
  ui: UiIR;
}

function renderLiveView(a: RenderArgs): string {
  const { page, liveModule, appModule, ui } = a;
  const webModule = `${appModule}Web`;

  // All pages — scaffold and custom — route through the HEEx walker.
  // Scaffold pages have their bodies rewritten by expandScaffoldPages()
  // (src/ir/lower.ts) before the emitter runs, so page.body is always
  // populated with a walker-stdlib ExprIR tree.  The walker produces
  // handle_event clauses and alias lines from helper imports the body
  // actually references.
  const walked = walkBodyToHeex(page.body, page, ui, appModule);
  const heex = walked.heex;
  const handlers: HandleEventClause[] = walked.handlers;
  const aliasLines: string[] = walked.aliasLines;

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
