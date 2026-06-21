// ---------------------------------------------------------------------------
// LiveView module emission per page.
//
// For each `PageIR` declared by the deployable's `ui:` block, emit:
//   - lib/<app>_web/live/<page_snake>_live.ex — a Phoenix LiveView module
//     with mount/3 (state init), handle_params/3 (route param bind +
//     `requires` guard), handle_event/3 (per onSubmit/Action lambda),
//     and render(assigns) — HEEx body emitted by the heex-walker.
//
// All pages (scaffold and custom) route through the HEEx walker.  Scaffold
// pages carry their full walker-stdlib body directly from the macro, so
// `page.body` is always a walker-stdlib `ExprIR` tree.  The walker
// (heex-walker.ts::walkBodyToHeex) emits HEEx directly — no pack templates for
// full pages.
//
// Also returns a list of `live "<route>", <Module>` entries the
// orchestrator splices into router.ex.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  EnumIR,
  PageIR,
  SystemIR,
  TypeIR,
  UiIR,
  ValueObjectIR,
} from "../../ir/types/loom-ir.js";
import { type PageNameCtx, pageEmitName } from "../../ir/util/page-kind.js";
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

  // True when this deployable runs `auth: required` — `LiveAuth.on_mount`
  // then assigns `@current_user`, which a gated `Action` button reads in its
  // `<%= if (@current_user.…) do %>` wrapper.  Off ⇒ no gating (byte-identical).
  const authEnabled = deployable.auth?.required === true;

  // Locate the UI block this deployable mounts.  Backends without a
  // `ui:` binding skip — they only emit the API surface.
  if (!deployable.uiName) return { files: out, routes };
  const ui = sys.uis.find((u) => u.name === deployable.uiName);
  if (!ui) return { files: out, routes };

  // Workspace-wide aggregate registry — needed by the page-object
  // emitter's domain-method synthesis (fill, submit, expectRow) AND
  // by the form-binding lookup in renderForm (heex-walker.ts) so
  // `CreateForm(of: Agg)` resolves to the aggregate's fields.
  const aggregatesByName = new Map<string, AggregateIR>();
  const contextByAggName = new Map<string, BoundedContextIR>();
  // Module-qualified context name per aggregate, e.g.
  // "PhoenixApp.Sales" — used by the LiveView mount stub to build
  // `AshPhoenix.Form.for_create(PhoenixApp.Sales.Customer, :create)`.
  const contextModuleByAggName = new Map<string, string>();
  // Workspace-wide enum registry — threaded into the walker so
  // `CreateForm(of: Agg)` with enum-typed fields renders `<.input
  // type="select" options={...}>` instead of the legacy text input.
  // Built once across every loaded context.
  const enumsByName = new Map<string, EnumIR>();
  // Workspace-wide VO registry — drives nested-form dispatch
  // (`<.inputs_for :let={…}>`) for value-object-typed aggregate
  // fields.  See `renderFieldInputForField` in heex-walker.ts.
  const valueObjectsByName = new Map<string, ValueObjectIR>();
  // Entity-part name → module-qualified context, so a page-body
  // `new Part { … }` struct literal qualifies as `%<Ctx>.<Part>{…}`
  // (matching the domain emitter).  An aggregate's parts live in its
  // owning context's module namespace.
  const partContextModule = new Map<string, string>();
  for (const ctx of contexts) {
    const ctxModule = `${appModule}.${upperFirst(ctx.name)}`;
    for (const agg of ctx.aggregates) {
      aggregatesByName.set(agg.name, agg);
      contextByAggName.set(agg.name, ctx);
      contextModuleByAggName.set(agg.name, ctxModule);
      for (const part of agg.parts) partContextModule.set(part.name, ctxModule);
    }
    for (const en of ctx.enums) enumsByName.set(en.name, en);
    for (const vo of ctx.valueObjects) valueObjectsByName.set(vo.name, vo);
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
      derived: c.derived,
      body: c.body,
    } as PageIR;
    const w = walkBodyToHeex(
      c.body,
      synthPage,
      ui,
      appModule,
      aggregatesByName,
      enumsByName,
      valueObjectsByName,
      authEnabled,
      partContextModule,
    );
    componentInfo.set(c.name, {
      actionBindings: w.actionBindings,
      usedComponents: w.usedComponents,
    });
  }

  // Name-context for `pageEmitName` (slice 3c — derives the emitted name from
  // the page's role-scoped name + area against the served decls).
  const nameCtx: PageNameCtx = {
    aggregateNames: [...aggregatesByName.keys()],
    workflowNames: contexts.flatMap((c) => c.workflows.map((w) => w.name)),
    viewNames: contexts.flatMap((c) => c.views.map((v) => v.name)),
  };
  for (const page of ui.pages) {
    if (!page.route) continue; // can't emit a router entry without one
    // Phoenix derives the module + file stem from the page's emit name
    // (`OrderList` → `OrderListLive` / `order_list_live.ex`), not the scaffold's
    // role-scoped page name (`List`) — which would collide across aggregates.
    const emitName = pageEmitName(page, nameCtx);
    const liveModule = `${appModule}Web.${upperFirst(emitName)}Live`;
    const filePath = `lib/${appName}_web/live/${snake(emitName)}_live.ex`;
    const source = renderLiveView({
      page,
      liveModule,
      appName,
      appModule,
      ui,
      aggregatesByName,
      enumsByName,
      valueObjectsByName,
      contextModuleByAggName,
      partContextModule,
      componentInfo,
      authEnabled,
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
    out.set(`e2e/pages/${snake(emitName)}.ts`, pageObjectSource);
  }

  // User-defined components → one HEEx function component per
  // `ui.component`, in a shared `Components.UiComponents` module.
  // Page bodies invoke them fully-qualified, so no import wiring is
  // needed.  (Components hosting Form/Action need handler hoisting to
  // the page LiveView — deferred.)
  if (ui.components.length > 0) {
    out.set(
      `lib/${appName}_web/components/ui_components.ex`,
      renderUiComponents({
        ui,
        appModule,
        aggregatesByName,
        enumsByName,
        valueObjectsByName,
        partContextModule,
        authEnabled,
      }),
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
  /** Workspace-wide enum registry — drives form select-input dispatch. */
  enumsByName: ReadonlyMap<string, EnumIR>;
  /** Workspace-wide VO registry — drives nested-form dispatch
   *  (`<.inputs_for :let={…}>`) for VO-typed aggregate fields. */
  valueObjectsByName: ReadonlyMap<string, ValueObjectIR>;
  /** Module-qualified name of the bounded context an aggregate lives in,
   *  keyed by aggregate PascalCase name.  Used to build the Ash
   *  `for_create(<Ctx>.<Agg>, :create)` call in mount/3. */
  contextModuleByAggName: ReadonlyMap<string, string>;
  /** Module-qualified context keyed by entity-part name — qualifies a
   *  page-body `new Part { … }` struct literal (`%<Ctx>.<Part>{…}`). */
  partContextModule: ReadonlyMap<string, string>;
  /** Per-component action bindings + nested component usage, so a page
   *  LiveView can hoist the `handle_event` clauses for `Action`s inside
   *  the (stateless) components it renders. */
  componentInfo: ReadonlyMap<string, ComponentActionInfo>;
  /** True when the deployable runs `auth: required` — drives currentUser
   *  action-button gating in the page body (off ⇒ byte-identical). */
  authEnabled: boolean;
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
    // `byId` actions (DestroyForm) call the code interface with the id
    // directly — the `get_by: [:id]` interface does the lookup.  Other
    // actions load the record first, then invoke the op on it.
    const body = b.byId
      ? [
          `    ${ctxModule}.${b.eventName}!(id)`,
          `    {:noreply, socket |> put_flash(:info, "${b.opHuman} succeeded")${navPipe}}`,
        ]
      : [
          `    record = ${ctxModule}.get_${aggSnake}!(id)`,
          `    ${ctxModule}.${b.eventName}!(record)`,
          `    {:noreply, socket |> put_flash(:info, "${b.opHuman} succeeded")${navPipe}}`,
        ];
    return {
      name: b.eventName,
      paramsPattern: `%{"id" => id}`,
      body,
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
    enumsByName,
    valueObjectsByName,
    contextModuleByAggName,
    partContextModule,
    componentInfo,
    authEnabled,
  } = a;
  const webModule = `${appModule}Web`;

  // All pages — scaffold and custom — route through the HEEx walker.
  // Scaffold pages carry their full walker-stdlib body from the macro, so
  // page.body is always a walker-stdlib ExprIR tree.  The walker produces
  // handle_event clauses and alias lines from helper imports the body
  // actually references.
  const walked = walkBodyToHeex(
    page.body,
    page,
    ui,
    appModule,
    aggregatesByName,
    enumsByName,
    valueObjectsByName,
    authEnabled,
    partContextModule,
  );
  const heex = walked.heex;
  const handlers: HandleEventClause[] = walked.handlers;

  const mount = renderMount(
    page,
    walked.formBindings,
    walked.idOptionsBindings,
    contextModuleByAggName,
    aggregatesByName,
  );
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

  return `# Auto-generated.
defmodule ${liveModule} do
  use ${webModule}, :live_view

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
  /** Aggregate names referenced by `X id` form fields; each gets
   *  a `socket |> assign(:<x_snake>_options, …list_…!())` line so
   *  the rendered `<.input type="select" options={@<x>_options}>`
   *  resolves at mount time. */
  idOptionsBindings: readonly string[],
  contextModuleByAggName: ReadonlyMap<string, string>,
  /** Used by the option-list emission to detect targets that
   *  declared `derived display: string = ...`.  When set, the
   *  emitted assign loads the `:display` calculation via
   *  `list_<x>!(load: [:display])` and uses it as the option label;
   *  when absent, the assign falls back to the v0 shape with the
   *  record's id as both label and value. */
  aggregatesByName: ReadonlyMap<string, AggregateIR>,
): string {
  const assigns: string[] = [];
  for (const f of page.state) {
    // Type-aware default from the walker — single source of truth so
    // `state.field` defaults match across scaffold and custom pages.
    assigns.push(`      |> assign(:${snake(f.name)}, ${defaultInitFor(f.type)})`);
  }
  // Option-list loads for `X id` form fields.  When the target
  // aggregate declares `derived display: string = ...` (always
  // injected when the user opts in; absent otherwise), load the
  // calculation alongside the read and use it as the human-readable
  // option label.  Falls back to the id-as-label v0 shape when no
  // display derives — the select stays structurally correct.
  for (const aggName of idOptionsBindings) {
    const ctxModule = contextModuleByAggName.get(aggName);
    if (!ctxModule) continue;
    const aggSnake = snake(aggName);
    const targetAgg = aggregatesByName.get(aggName);
    const hasDisplay = targetAgg?.displayDerived !== undefined;
    const listCall = hasDisplay
      ? `${ctxModule}.list_${aggSnake}s!(load: [:display])`
      : `${ctxModule}.list_${aggSnake}s!()`;
    const tupleFn = hasDisplay
      ? `fn r -> {r.display, r.id} end`
      : `fn r -> {to_string(r.id), r.id} end`;
    assigns.push(`      |> assign(:${aggSnake}_options, ${listCall} |> Enum.map(${tupleFn}))`);
  }
  // @form assignment — one per CreateForm / WorkflowForm call in the page body.
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
  enumsByName: ReadonlyMap<string, EnumIR>;
  valueObjectsByName: ReadonlyMap<string, ValueObjectIR>;
  /** Entity-part name → module-qualified context, so a component-body
   *  `new Part { … }` qualifies as `%<Ctx>.<Part>{…}`. */
  partContextModule: ReadonlyMap<string, string>;
  /** True when the host deployable runs `auth: required` — drives
   *  currentUser action-button gating inside component bodies. */
  authEnabled: boolean;
}): string {
  const {
    ui,
    appModule,
    aggregatesByName,
    enumsByName,
    valueObjectsByName,
    partContextModule,
    authEnabled,
  } = args;
  const webModule = `${appModule}Web`;
  const defs = ui.components.map((c) => {
    const synthPage = {
      name: c.name,
      params: c.params,
      state: c.state,
      derived: c.derived,
      body: c.body,
    } as PageIR;
    const walked = walkBodyToHeex(
      c.body,
      synthPage,
      ui,
      appModule,
      aggregatesByName,
      enumsByName,
      valueObjectsByName,
      authEnabled,
      partContextModule,
    );
    const attrLines = c.params
      .map((p) => `  attr :${snake(p.name)}, ${attrType(p.type)}, required: true`)
      .join("\n");
    // A `Slot()` in the body declares the `:inner_block` slot it renders via
    // `{render_slot(@inner_block)}` (walker sets `usesSlot`).
    const slotLine = walked.usesSlot ? "  slot :inner_block, required: true\n" : "";
    const attrBlock = `${attrLines.length > 0 ? `${attrLines}\n` : ""}${slotLine}`;
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
