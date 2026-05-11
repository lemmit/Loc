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
    });
    out.set(filePath, source);
    routes.push({ route: page.route, liveModule });
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
}

function renderLiveView(a: RenderArgs): string {
  const { page, liveModule, appModule, pack, aggregatesByName, contextByAggName } = a;
  const webModule = `${appModule}Web`;
  const heex = renderPageHeex(a);
  const mount = renderMount(page);
  const handleParams = renderHandleParams(page);

  return `# Auto-generated.
defmodule ${liveModule} do
  use ${webModule}, :live_view

${mount}

${handleParams}

  @impl true
  def render(assigns) do
    ~H"""
${indent(heex, 4)}
    """
  end
end
`;

  // Linting: aggregatesByName / contextByAggName are consumed inside
  // renderPageHeex via the closure above.  Keep them visible to
  // future expansions (operation event handlers, etc.).
  void aggregatesByName;
  void contextByAggName;
  void pack;
}

function renderPageHeex(a: RenderArgs): string {
  const { page, pack, aggregatesByName, contextByAggName } = a;
  const origin = page.scaffoldOrigin;
  if (!origin) {
    return `<!-- TODO: walker-driven body for explicit page '${page.name}' (Phase 7 follow-up) -->`;
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
    case "view-list":
    case "workflows-index":
    case "views-index":
    case "home":
      // v0 stub — Phase 7 follow-up wires preparers + pack templates
      // for these archetypes.  HEEx body is a placeholder so the
      // LiveView still mounts cleanly.
      return `<!-- TODO: ${origin.kind} HEEx (Phase 7 follow-up) -->\n<.header>${page.name}</.header>`;
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
    assigns.push(`      |> assign(:${snake(f.name)}, ${defaultElixirValueFor(f.type)})`);
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

function renderHandleParams(page: PageIR): string {
  const paramAssigns: string[] = [];
  for (const p of page.params) {
    paramAssigns.push(`      |> assign(:${snake(p.name)}, params["${camel(p.name)}"])`);
  }
  // `requires` lowering is a Phase 7 follow-up — for v0 we just bind
  // route params and acknowledge.  The grammar's `requires` predicate
  // would lower to a guard that push_navigate's home with a flash
  // on failure.
  if (paramAssigns.length === 0) {
    return `  @impl true
  def handle_params(_params, _uri, socket) do
    {:noreply, socket}
  end`;
  }
  return `  @impl true
  def handle_params(params, _uri, socket) do
    socket =
      socket
${paramAssigns.join("\n")}
    {:noreply, socket}
  end`;
}

function defaultElixirValueFor(t: { kind: string; name?: string; optional?: boolean }): string {
  if (t.optional) return "nil";
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
        case "decimal":
          return "0";
        case "bool":
          return "false";
        case "string":
          return `""`;
        case "datetime":
          return "DateTime.utc_now()";
        case "guid":
          return `""`;
        default:
          return "nil";
      }
    case "id-of":
      return "nil";
    case "array":
      return "[]";
    default:
      return "nil";
  }
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
