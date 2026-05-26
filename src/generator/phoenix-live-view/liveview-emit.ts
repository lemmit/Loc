// ---------------------------------------------------------------------------
// LiveView module emission per page.
//
// For each `PageIR` declared by the deployable's `ui:` block, emit:
//   - lib/<app>_web/live/<page_snake>_live.ex — a Phoenix LiveView module
//     with mount/3 (state init), handle_params/3 (route param bind +
//     `requires` guard), handle_event/3 (per onSubmit/Action lambda),
//     and render(assigns) — HEEx body emitted by the heex-walker.
//
// All pages (scaffold and custom) route through the HEEx walker.
// Scaffold pages emit canonical body primitives that
// `expandInlineScaffoldPrimitiveCalls` (src/ir/lower.ts) rewrites
// during lowering, so `page.body` is always
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
  TypeIR,
  UiIR,
} from "../../ir/loom-ir.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import {
  type ActionBinding,
  defaultInitFor,
  type HandleEventClause,
  renderRequiresGuard,
  walkBodyToHeex,
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
  // emitter's domain-method synthesis (fill, submit, expectRow) AND
  // by the form-binding lookup in renderForm (heex-walker.ts) so
  // `Form(of: Agg)` resolves to the aggregate's fields.
  const aggregatesByName = new Map<string, AggregateIR>();
  const contextByAggName = new Map<string, BoundedContextIR>();
  // Module-qualified context name per aggregate, e.g.
  // "PhoenixApp.Sales" — used by the LiveView mount stub to build
  // `AshPhoenix.Form.for_create(PhoenixApp.Sales.Customer, :create)`.
  const contextModuleByAggName = new Map<string, string>();
  for (const ctx of contexts) {
    const ctxModule = `${appModule}.${upperFirst(ctx.name)}`;
    for (const agg of ctx.aggregates) {
      aggregatesByName.set(agg.name, agg);
      contextByAggName.set(agg.name, ctx);
      contextModuleByAggName.set(agg.name, ctxModule);
    }
  }

  // Walk each user component once to capture its `Action` bindings +
  // nested component usage, so each page can hoist the handlers for the
  // components it renders (function components are stateless).
  const componentInfo = new Map<string, ComponentActionInfo>();
  for (const c of ui.components) {
    const synthPage = {
      name: c.name,
      params: c.params,
      state: c.state,
      body: c.body,
      source: "explicit",
    } as PageIR;
    const w = walkBodyToHeex(c.body, synthPage, ui, appModule, aggregatesByName);
    componentInfo.set(c.name, {
      actionBindings: w.actionBindings,
      usedComponents: w.usedComponents,
    });
  }

  for (const page of ui.pages) {
    if (!page.route) continue; // can't emit a router entry without one
    const liveModule = `${appModule}Web.${upperFirst(page.name)}Live`;
    const filePath = `lib/${appName}_web/live/${snake(page.name)}_live.ex`;
    const source = renderLiveView({
      page,
      liveModule,
      appName,
      appModule,
      ui,
      aggregatesByName,
      contextModuleByAggName,
      componentInfo,
    });
    out.set(filePath, source);
    routes.push({ route: page.route, liveModule });

    // Playwright page object emission.  Mirrors the React
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

  // User-defined components → one HEEx function component per
  // `ui.component`, in a shared `Components.UiComponents` module.
  // Page bodies invoke them fully-qualified, so no import wiring is
  // needed.  (Components hosting Form/Action need handler hoisting to
  // the page LiveView — deferred.)
  if (ui.components.length > 0) {
    out.set(
      `lib/${appName}_web/components/ui_components.ex`,
      renderUiComponents({ ui, appModule, aggregatesByName }),
    );
  }

  return { files: out, routes };
}

interface RenderArgs {
  page: PageIR;
  liveModule: string;
  appName: string;
  appModule: string;
  ui: UiIR;
  aggregatesByName: ReadonlyMap<string, AggregateIR>;
  /** Module-qualified name of the bounded context an aggregate lives in,
   *  keyed by aggregate PascalCase name.  Used to build the Ash
   *  `for_create(<Ctx>.<Agg>, :create)` call in mount/3. */
  contextModuleByAggName: ReadonlyMap<string, string>;
  /** Per-component action bindings + nested component usage, so a page
   *  LiveView can hoist the `handle_event` clauses for `Action`s inside
   *  the (stateless) components it renders. */
  componentInfo: ReadonlyMap<string, ComponentActionInfo>;
}

interface ComponentActionInfo {
  actionBindings: readonly ActionBinding[];
  usedComponents: readonly string[];
}

/** Transitive closure: every `ActionBinding` reachable from a page —
 *  its own body's bindings plus those of every component it renders
 *  (recursively).  Deduped by event name. */
function gatherActionBindings(
  seedBindings: readonly ActionBinding[],
  seedComponents: readonly string[],
  componentInfo: ReadonlyMap<string, ComponentActionInfo>,
): ActionBinding[] {
  const byEvent = new Map<string, ActionBinding>();
  for (const b of seedBindings) if (!byEvent.has(b.eventName)) byEvent.set(b.eventName, b);
  const seen = new Set<string>();
  const queue = [...seedComponents];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const info = componentInfo.get(name);
    if (!info) continue;
    for (const b of info.actionBindings) {
      if (!byEvent.has(b.eventName)) byEvent.set(b.eventName, b);
    }
    queue.push(...info.usedComponents);
  }
  return [...byEvent.values()];
}

/** A hoisted `Action` `handle_event` clause: load the instance by id,
 *  invoke the Ash action via the code interface, flash + optional
 *  navigate. */
function buildActionHandlers(
  bindings: readonly ActionBinding[],
  contextModuleByAggName: ReadonlyMap<string, string>,
): HandleEventClause[] {
  return bindings.map((b) => {
    const ctxModule = contextModuleByAggName.get(b.agg);
    const aggSnake = snake(b.agg);
    const navPipe = b.thenRoute ? ` |> push_navigate(to: ~p"${b.thenRoute}")` : "";
    return {
      name: b.eventName,
      paramsPattern: `%{"id" => id}`,
      body: [
        `    record = ${ctxModule}.get_${aggSnake}!(id)`,
        `    ${ctxModule}.${b.eventName}!(record)`,
        `    {:noreply, socket |> put_flash(:info, "${b.opHuman} succeeded")${navPipe}}`,
      ],
    };
  });
}

function renderLiveView(a: RenderArgs): string {
  const {
    page,
    liveModule,
    appModule,
    ui,
    aggregatesByName,
    contextModuleByAggName,
    componentInfo,
  } = a;
  const webModule = `${appModule}Web`;

  // All pages — scaffold and custom — route through the HEEx walker.
  // Scaffold pages emit canonical body primitives that
  // expandInlineScaffoldPrimitiveCalls (src/ir/lower.ts) rewrites
  // during lowering, so page.body is always
  // populated with a walker-stdlib ExprIR tree.  The walker produces
  // handle_event clauses and alias lines from helper imports the body
  // actually references.
  const walked = walkBodyToHeex(page.body, page, ui, appModule, aggregatesByName);
  const heex = walked.heex;
  const handlers: HandleEventClause[] = walked.handlers;
  const aliasLines: string[] = walked.aliasLines;

  const mount = renderMount(page, walked.formBindings, contextModuleByAggName);
  const handleParams = renderHandleParams(
    page,
    ui,
    appModule,
    walked.queryBindings,
    walked.formBindings,
    contextModuleByAggName,
  );
  const detailBaseRoute = page.route ? page.route.replace(/\/:[^/]+$/, "") : null;
  // Hoist `Action(...)` handlers from the page body + every component
  // the page renders (transitively) into this page's LiveView.
  const actionHandlers = buildActionHandlers(
    gatherActionBindings(walked.actionBindings, walked.usedComponents, componentInfo),
    contextModuleByAggName,
  );
  const handleEventClauses =
    renderHandleEventClauses([...handlers, ...actionHandlers]) +
    renderOperationEventClauses(walked.formBindings, detailBaseRoute);
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

function renderMount(
  page: PageIR,
  formBindings: import("./heex-walker.js").FormBinding[],
  contextModuleByAggName: ReadonlyMap<string, string>,
): string {
  const assigns: string[] = [];
  for (const f of page.state) {
    // Type-aware default from the walker — single source of truth so
    // `state.field` defaults match across scaffold and custom pages.
    assigns.push(`      |> assign(:${snake(f.name)}, ${defaultInitFor(f.type)})`);
  }
  // @form assignment — one per Form(of:/runs:) call in the page body.
  // For aggregate-of: AshPhoenix.Form.for_create(<Ctx>.<Agg>, :create);
  // for workflow-runs: a placeholder for_action (workflow-form
  // resolution is wider and tracked separately).  Multiple forms on
  // one page collapse to a single @form; pages with >1 form should
  // split into nested LiveComponents.
  for (const fb of formBindings) {
    // Operation forms bind to a *loaded* record (`for_update`), so
    // they're assigned in handle_params after @data loads — never
    // in mount (no record here).  Skip.
    if (fb.kind === "operation") continue;
    if (fb.kind === "aggregate") {
      const ctxModule = contextModuleByAggName.get(fb.name);
      if (!ctxModule) continue; // unresolved — validator catches; silent skip
      assigns.push(
        `      |> assign(:form, AshPhoenix.Form.for_create(${ctxModule}.${upperFirst(fb.name)}, :create) |> to_form())`,
      );
      break; // single @form per page
    } else if (fb.kind === "workflow") {
      // Workflow form — placeholder until workflow-form mounting lands.
      // Keeps the page mountable (form is empty but the assigns shape
      // matches what the HEEx body expects).
      assigns.push(`      |> assign(:form, %{} |> to_form())`);
      break;
    }
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

function renderHandleParams(
  page: PageIR,
  ui: UiIR,
  appModule: string,
  queryBindings: import("./heex-walker.js").QueryBinding[],
  formBindings: import("./heex-walker.js").FormBinding[],
  contextModuleByAggName: ReadonlyMap<string, string>,
): string {
  const paramAssigns: string[] = [];
  for (const p of page.params) {
    paramAssigns.push(`assign(:${snake(p.name)}, params["${lowerFirst(p.name)}"])`);
  }

  // QueryView record loading.  The scaffold detail/list page reads
  // @data / @items in its `cond`, but nothing populates them unless
  // we load here (handle_params runs after @id is bound from the
  // route).  `single` → load one record via the `get_<agg>` code
  // interface (bang variant raises Ash.Error.Query.NotFound for a
  // missing id, which we map to the `:not_found` sentinel the
  // 4-way cond renders as the `empty:` slot).  `list` → the
  // collection via `list_<agg>s`.
  const loadBlocks: string[] = [];
  for (const qb of queryBindings) {
    const ctxModule = contextModuleByAggName.get(qb.aggregate);
    if (!ctxModule) continue; // unresolved — validator catches upstream
    const aggSnake = snake(qb.aggregate);
    if (qb.kind === "single") {
      // Operation forms for this aggregate bind to the loaded
      // record via `for_update` — assigned here, in the success
      // branch, where `record` is in scope.
      const opAssigns = formBindings
        .filter((fb) => fb.kind === "operation" && fb.name === qb.aggregate)
        .map(
          (fb) =>
            `        |> assign(:${fb.op}_form, AshPhoenix.Form.for_update(record, :${fb.op}, as: "${fb.op}") |> to_form())`,
        );
      loadBlocks.push(
        `    socket =
      try do
        record = ${ctxModule}.get_${aggSnake}!(socket.assigns.id)

        socket
        |> assign(:${qb.assign}, record)
${opAssigns.length > 0 ? opAssigns.join("\n") + "\n" : ""}      rescue
        Ash.Error.Query.NotFound -> assign(socket, :${qb.assign}, :not_found)
        Ash.Error.Invalid -> assign(socket, :${qb.assign}, :error)
      end`,
      );
    } else {
      loadBlocks.push(
        `    socket =
      try do
        assign(socket, :${qb.assign}, ${ctxModule}.list_${aggSnake}s!())
      rescue
        _ -> assign(socket, :${qb.assign}, :error)
      end`,
      );
    }
  }

  const hasParams = paramAssigns.length > 0;
  const hasLoad = loadBlocks.length > 0;

  // Core body (sans guard): param assigns, then record load(s).
  const bodyParts: string[] = [];
  if (hasParams) {
    bodyParts.push(
      `    socket =\n      socket\n${paramAssigns.map((a) => `      |> ${a}`).join("\n")}`,
    );
  }
  if (hasLoad) bodyParts.push(loadBlocks.join("\n\n"));
  bodyParts.push(`    {:noreply, socket}`);
  const coreBody = bodyParts.join("\n\n");

  // `requires <pred>` guard wraps the whole body.
  const guard = renderRequiresGuard(page, ui, appModule);
  const body = guard
    ? `    if not (${guard}) do
      {:noreply, socket |> put_flash(:error, "forbidden") |> push_navigate(to: "/")}
    else
${coreBody
  .split("\n")
  .map((l) => (l.length > 0 ? "  " + l : l))
  .join("\n")}
    end`
    : coreBody;

  // The function head binds `params` only when the body actually
  // reads it (route-param assigns do `params["x"]`).  Load blocks
  // reference `socket.assigns.id`, never `params`, so a load-only
  // page (e.g. a list page with no route params) must use
  // `_params` — otherwise `mix compile --warnings-as-errors`
  // fails on the unused variable.
  const headParamsVar = hasParams ? "params" : "_params";

  return `  @impl true
  def handle_params(${headParamsVar}, _uri, socket) do
${body}
  end`;
}

/** Per-operation `validate_<op>` / `submit_<op>` handle_event
 *  clauses.  Mirrors the AshPhoenix 3.x form lifecycle: validate
 *  on change, submit on submit; on success re-load the record into
 *  @data, rebuild the op form, flash, and push_patch back to the
 *  detail route (canonical re-load path).  One pair per
 *  `kind:"operation"` FormBinding. */
function renderOperationEventClauses(
  formBindings: import("./heex-walker.js").FormBinding[],
  /** The detail page's route with the trailing `/:id` stripped,
   *  e.g. "/customers" — used to push_patch back after submit. */
  detailBaseRoute: string | null,
): string {
  const ops = formBindings.filter((fb) => fb.kind === "operation");
  if (ops.length === 0) return "";
  return (
    "\n" +
    ops
      .map((fb) => {
        const op = fb.op!;
        const human = humanizeOp(op);
        const reload = detailBaseRoute
          ? `\n         |> push_patch(to: ~p"${detailBaseRoute}/#{record.id}")`
          : "";
        return `  @impl true
  def handle_event("validate_${op}", %{"${op}" => params}, socket) do
    form = AshPhoenix.Form.validate(socket.assigns.${op}_form, params)
    {:noreply, assign(socket, :${op}_form, form)}
  end

  @impl true
  def handle_event("submit_${op}", %{"${op}" => params}, socket) do
    case AshPhoenix.Form.submit(socket.assigns.${op}_form, params: params) do
      {:ok, record} ->
        {:noreply,
         socket
         |> put_flash(:info, "${human} succeeded")
         |> assign(:data, record)
         |> assign(:${op}_form, AshPhoenix.Form.for_update(record, :${op}, as: "${op}") |> to_form())${reload}}

      {:error, form} ->
        {:noreply, assign(socket, :${op}_form, form)}
    end
  end\n`;
      })
      .join("\n")
  );
}

/** "adjust_credit" → "Adjust credit" — sentence-case the snake op
 *  name for flash copy. */
function humanizeOp(opSnake: string): string {
  const s = opSnake.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

/** Phoenix `attr` type token for a component param's declared type. */
function attrType(t: TypeIR): string {
  switch (t.kind) {
    case "entity":
    case "valueobject":
      return ":map";
    case "array":
      return ":list";
    case "primitive":
      // money is :string for assign typing — Decimal serialises to
      // string for Jason / LiveView assigns; arithmetic happens inside
      // the LiveView event handler via Decimal.add/2 etc.
      return t.name === "int" || t.name === "decimal"
        ? ":integer"
        : t.name === "bool"
          ? ":boolean"
          : ":string";
    default:
      return ":any";
  }
}

/** Emit `lib/<app>_web/components/ui_components.ex` — one HEEx
 *  function component (`attr` declarations + `def <name>(assigns)`)
 *  per `ui.component`.  Each body is walked with the component's
 *  params/state in scope, so param refs resolve to `@assigns`. */
function renderUiComponents(args: {
  ui: UiIR;
  appModule: string;
  aggregatesByName: ReadonlyMap<string, AggregateIR>;
}): string {
  const { ui, appModule, aggregatesByName } = args;
  const webModule = `${appModule}Web`;
  const defs = ui.components.map((c) => {
    const synthPage = {
      name: c.name,
      params: c.params,
      state: c.state,
      body: c.body,
      source: "explicit",
    } as PageIR;
    const walked = walkBodyToHeex(c.body, synthPage, ui, appModule, aggregatesByName);
    const attrLines = c.params
      .map((p) => `  attr :${snake(p.name)}, ${attrType(p.type)}, required: true`)
      .join("\n");
    const attrBlock = attrLines.length > 0 ? `${attrLines}\n` : "";
    return `${attrBlock}  def ${snake(c.name)}(assigns) do
    ~H"""
${indent(walked.heex, 4)}
    """
  end`;
  });
  return `defmodule ${webModule}.Components.UiComponents do
  use ${webModule}, :html

${defs.join("\n\n")}
end
`;
}

// Suppress unused-import lints for re-exports.
void plural;
