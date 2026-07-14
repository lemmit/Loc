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
import { type PageNameCtx, pageConstructId, pageEmitName } from "../../ir/util/page-kind.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import {
  E2E_FIXTURES_TS,
  E2E_PACKAGE_JSON_PHOENIX,
  E2E_TSCONFIG_JSON,
  PLAYWRIGHT_CONFIG_TS_PHOENIX,
} from "../_frontend/e2e-harness.js";
import { smokeSpec } from "../_frontend/smoke-spec.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import {
  type ActionBinding,
  defaultInitFor,
  type HandleEventClause,
  renderRequiresGuard,
  walkBodyToHeex,
} from "./heex-walker.js";
import { buildPlaywrightPageObject } from "./page-objects-emit.js";
import { renderStoreModule } from "./store-emit.js";

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
  /** Persistence foundation of the host deployable.  Always `"vanilla"`
   *  (plain Ecto/Phoenix LiveView — no Ash).  Kept on the options shape only
   *  so the caller's `foundation: "vanilla"` still type-checks; ignored. */
  foundation?: "vanilla";
  /** Generate-time source-map recorder (`--sourcemap`).  Records one region
   *  per emitted LiveView module AND per Playwright page object, both
   *  against the page's `origin` — a scaffolded page's origin is a
   *  `kind:"macro"` ref pointing at its `with scaffold(...)` call site, so
   *  this is the macro leg of the source-map milestone. */
  sourcemap?: SourceMapRecorder;
}): { files: Map<string, string>; routes: LiveRoute[] } {
  const { contexts, deployable, sys, appName, appModule, sourcemap } = args;
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

  // `<App>Web` module prefix — used for the store modules
  // (`<App>Web.Stores.<Store>`) + the per-page `alias`.
  const webModule = `${appModule}Web`;

  // --- Store modules (Stage 5) -------------------------------------------
  // One `lib/<app>_web/stores/<store_snake>.ex` per `store Cart { … }` the ui
  // declares — a dedicated module (defstruct + pure action fns), the Elixir
  // twin of the SPA's `stores/cart.ts`.  The page seam (assign + alias +
  // `update/3` calls) is wired per-page below from `walked.usedStores`.
  for (const store of ui.stores) {
    out.set(
      `lib/${appName}_web/stores/${snake(store.name)}.ex`,
      renderStoreModule(store, webModule),
    );
  }

  // Workspace-wide aggregate registry — needed by the page-object
  // emitter's domain-method synthesis (fill, submit, expectRow) AND
  // by the form-binding lookup in renderForm (heex-walker.ts) so
  // `CreateForm(of: Agg)` resolves to the aggregate's fields.
  const aggregatesByName = new Map<string, AggregateIR>();
  const contextByAggName = new Map<string, BoundedContextIR>();
  // Module-qualified context name per aggregate, e.g.
  // "PhoenixApp.Sales" — used by the LiveView mount stub to build the
  // `change_<agg>(%PhoenixApp.Sales.Customer{})` create-form changeset.
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
    // Extern components have no walked body — their rendering is a hand-written
    // LiveComponent embedded via `<.live_component>` (extern-component-escape-
    // hatch.md).  Nothing to walk, hoist, or emit into `UiComponents`.
    if (c.extern) continue;
    const synthPage = {
      name: c.name,
      params: c.params,
      state: c.state,
      derived: c.derived,
      // Include the component's named `action`s so the walk hoists their
      // handlers — a store-mutating component action (`addOne() { Cart.add(…) }`)
      // needs its `handle_event` clause + `usedStores` captured so the host
      // page can hoist them (Stage 5).
      actions: c.actions,
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
      contextModuleByAggName,
    );
    componentInfo.set(c.name, {
      actionBindings: w.actionBindings,
      usedComponents: w.usedComponents,
      usedStores: w.usedStores,
      handlers: w.handlers,
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
    sourcemap?.file(filePath, source, page.origin, pageConstructId(ui.name, page));
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
    const pageObjectPath = `e2e/pages/${snake(emitName)}.ts`;
    out.set(pageObjectPath, pageObjectSource);
    sourcemap?.file(pageObjectPath, pageObjectSource, page.origin, pageConstructId(ui.name, page));
  }

  // Playwright harness + route-driven smoke spec — the same e2e surface
  // the four SPA frontends emit (shared `_frontend/` generators), so a
  // Phoenix deployable's page objects have something to run under and the
  // smoke spec (every param-less LiveView route navigates + loads) can be
  // driven against the running server.  Unlike the SPAs' backendless `vite
  // preview`, LiveView is server-rendered, so the smoke targets the Phoenix
  // server (port 4000 by default; override via E2E_BASE_URL).  Only when the
  // ui actually mounts a routed page (otherwise there's nothing to smoke).
  if (ui.pages.some((p) => p.route)) {
    out.set("e2e/smoke.spec.ts", smokeSpec(ui, nameCtx));
    out.set("e2e/fixtures.ts", E2E_FIXTURES_TS);
    out.set("e2e/playwright.config.ts", PLAYWRIGHT_CONFIG_TS_PHOENIX);
    out.set("e2e/package.json", E2E_PACKAGE_JSON_PHOENIX);
    out.set("e2e/tsconfig.json", E2E_TSCONFIG_JSON);
  }

  // User-defined components → one HEEx function component per
  // `ui.component`, in a shared `Components.UiComponents` module.
  // Page bodies invoke them fully-qualified, so no import wiring is
  // needed.  (Components hosting Form/Action need handler hoisting to
  // the page LiveView — deferred.)
  if (ui.components.some((c) => !c.extern)) {
    out.set(
      `lib/${appName}_web/components/ui_components.ex`,
      renderUiComponents({
        ui,
        appModule,
        aggregatesByName,
        enumsByName,
        valueObjectsByName,
        partContextModule,
        contextModuleByAggName,
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
   *  keyed by aggregate PascalCase name.  Used to build the
   *  `change_<agg>(%<Ctx>.<Agg>{})` create-form changeset in mount/3. */
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
  /** Store names the component body uses (Stage 5) — hoisted to the host page
   *  so its mount seeds the `:store` assign + `alias` even when the store is
   *  only touched inside the (stateless) component. */
  usedStores: readonly string[];
  /** The component's own `handle_event` clauses (named-action handlers) — a
   *  store-mutating component action (`addOne() { Cart.add(...) }`) must hoist
   *  its handler to the host page LiveView, since the component is a stateless
   *  function component with no LiveView of its own.  Only store-touching
   *  handlers are hoisted (see `gatherStoreHandlers`); the rest stay the
   *  pre-existing component-named-action gap. */
  handlers: readonly HandleEventClause[];
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

/** Transitive closure of the stores a page touches — its own body's
 *  `usedStores` plus those of every component it renders (recursively).  Drives
 *  the per-page mount `assign(:store, %Store{})` + `alias` so a store touched
 *  only inside a (stateless) component is still seeded on the host page. */
function gatherUsedStores(
  seedStores: readonly string[],
  seedComponents: readonly string[],
  componentInfo: ReadonlyMap<string, ComponentActionInfo>,
): string[] {
  const stores = new Set<string>(seedStores);
  const seen = new Set<string>();
  const queue = [...seedComponents];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const info = componentInfo.get(name);
    if (!info) continue;
    for (const s of info.usedStores) stores.add(s);
    queue.push(...info.usedComponents);
  }
  return [...stores];
}

/** The store-touching `handle_event` clauses from every component a page
 *  renders (transitively).  A component is a stateless function component, so a
 *  store-mutating component action (`addOne() { Cart.add(...) }`) only works if
 *  its handler is hoisted to the host page's LiveView (which owns the `:cart`
 *  assign).  Only clauses whose body references `update(:` (a store mutation)
 *  are hoisted — page-local component actions that mutate nothing the page owns
 *  stay the pre-existing component-named-action HEEx gap.  Deduped by name. */
function gatherStoreHandlers(
  seedComponents: readonly string[],
  componentInfo: ReadonlyMap<string, ComponentActionInfo>,
): HandleEventClause[] {
  const byName = new Map<string, HandleEventClause>();
  const seen = new Set<string>();
  const queue = [...seedComponents];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const info = componentInfo.get(name);
    if (!info) continue;
    for (const h of info.handlers) {
      const touchesStore = h.body.some((l) => l.includes("update(:"));
      if (touchesStore && !byName.has(h.name)) byName.set(h.name, h);
    }
    queue.push(...info.usedComponents);
  }
  return [...byName.values()];
}

/** A hoisted `Action` `handle_event` clause: load the instance by id,
 *  invoke the context action, flash + optional navigate. */
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
    contextModuleByAggName,
  );
  const heex = walked.heex;
  const handlers: HandleEventClause[] = walked.handlers;

  // Stores this page touches (Stage 5) — its own body's `usedStores` plus
  // every component it renders (transitively).  Drives the mount
  // `assign(:store, %Store{})` + the `alias <App>Web.Stores.<Store>` so a
  // `Cart.count` read / `Cart.clear()` call resolves.
  const usedStores = gatherUsedStores(
    walked.usedStores,
    walked.usedComponents,
    componentInfo,
  ).sort();
  const aliasLines = usedStores
    .map((s) => `  alias ${webModule}.Stores.${upperFirst(s)}`)
    .join("\n");

  const mount = renderMount(
    page,
    walked.formBindings,
    walked.idOptionsBindings,
    contextModuleByAggName,
    aggregatesByName,
    usedStores,
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
  // Store-mutating component named-action handlers (`addOne() { Cart.add(...) }`)
  // hoist to the host page's LiveView — the component is a stateless function
  // component, so its `phx-click="add_one"` needs the page to carry the clause
  // (and the page already carries the `:cart` assign via gatherUsedStores).
  const storeHandlers = gatherStoreHandlers(walked.usedComponents, componentInfo);
  // The list route a create-form success navigates back to — the create
  // ("new") page route with the trailing `/new` segment stripped
  // (`/customers/new` → `/customers`).
  const createSuccessRoute = page.route ? page.route.replace(/\/new$/, "") : null;
  const handleEventClauses =
    renderHandleEventClauses([...handlers, ...actionHandlers, ...storeHandlers]) +
    renderCreateEventClauses(walked.formBindings, contextModuleByAggName, createSuccessRoute) +
    renderOperationEventClauses(walked.formBindings, detailBaseRoute, contextModuleByAggName);

  return `# Auto-generated.
defmodule ${liveModule} do
  use ${webModule}, :live_view
${aliasLines.length > 0 ? `\n${aliasLines}\n` : ""}
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
  /** Aggregate registry — kept for symmetry with the option-list emission
   *  (the vanilla path reads the record id as the option label/value). */
  _aggregatesByName: ReadonlyMap<string, AggregateIR>,
  /** Stores this page touches (Stage 5) — each gets one
   *  `|> assign(:<store_snake>, %<Store>{})` seeding the per-page store struct
   *  (defaults from the store module's `defstruct`).  The matching `alias` is
   *  emitted by `renderLiveView` so `%Cart{}` resolves. */
  usedStores: readonly string[] = [],
): string {
  const assigns: string[] = [];
  for (const f of page.state) {
    // Type-aware default from the walker — single source of truth so
    // `state.field` defaults match across scaffold and custom pages.
    assigns.push(`      |> assign(:${snake(f.name)}, ${defaultInitFor(f.type)})`);
  }
  // Per-store assign — one `%<Store>{}` (struct defaults) per used store.
  for (const storeName of usedStores) {
    assigns.push(`      |> assign(:${snake(storeName)}, %${upperFirst(storeName)}{})`);
  }
  // Option-list loads for `X id` form fields.  The label is the record id
  // (no `:display` calculation on the vanilla path).  The auto-`findAll` is
  // paged-by-default (M-T2.6), so `list_<agg>s()` returns the `{:ok, %{items:
  // …}}` envelope for a concrete aggregate; an abstract polymorphic base
  // stays unpaged (`{:ok, list}`).  Match the envelope first, then the bare
  // list, so the option load unwraps to a plain list either way.
  for (const aggName of idOptionsBindings) {
    const ctxModule = contextModuleByAggName.get(aggName);
    if (!ctxModule) continue;
    const aggSnake = snake(aggName);
    const tupleFn = `fn r -> {to_string(r.id), r.id} end`;
    const listCall = `(case ${ctxModule}.list_${aggSnake}s() do {:ok, %{items: items}} -> items; {:ok, items} -> items; _ -> [] end)`;
    assigns.push(`      |> assign(:${aggSnake}_options, ${listCall} |> Enum.map(${tupleFn}))`);
  }
  // @form assignment — one per CreateForm / WorkflowForm call in the page body.
  // For aggregate-of: a blank Ecto changeset off the schema struct via the
  // `change_<agg>` context facade; for workflow-runs: a placeholder form
  // (workflow-form resolution is wider and tracked separately).  Multiple
  // forms on one page collapse to a single @form; pages with >1 form should
  // split into nested LiveComponents.
  for (const fb of formBindings) {
    // Operation forms bind to a *loaded* record, so they're assigned in
    // handle_params after @data loads — never in mount (no record here).  Skip.
    if (fb.kind === "operation") continue;
    if (fb.kind === "aggregate") {
      const ctxModule = contextModuleByAggName.get(fb.name);
      if (!ctxModule) continue; // unresolved — validator catches; silent skip
      // A blank Ecto changeset off the schema struct via the `change_<agg>`
      // context facade.
      assigns.push(
        `      |> assign(:form, ${ctxModule}.change_${snake(fb.name)}(%${ctxModule}.${upperFirst(fb.name)}{}) |> to_form())`,
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
  // route).  `single` → load one record via `get_<agg>(id)`
  // (`{:ok, record} | {:error, :not_found}`); `list` → the collection
  // via `list_<agg>s()` (`{:ok, list}`).
  const loadBlocks: string[] = [];
  for (const qb of queryBindings) {
    const ctxModule = contextModuleByAggName.get(qb.aggregate);
    if (!ctxModule) continue; // unresolved — validator catches upstream
    const aggSnake = snake(qb.aggregate);
    if (qb.kind === "single") {
      // Operation forms for this aggregate bind to the loaded record —
      // assigned here, where `record` is in scope: a plain Ecto changeset
      // seeded from the loaded record via the `change_<agg>` facade.
      const opFbs = formBindings.filter(
        (fb) => fb.kind === "operation" && fb.name === qb.aggregate,
      );
      const opAssigns = opFbs.map(
        (fb) =>
          `        |> assign(:${fb.op}_form, ${ctxModule}.change_${aggSnake}(record) |> to_form())`,
      );
      // `get_<agg>(id)` is a plain-Ecto fetch returning
      // `{:ok, record} | {:error, :not_found}`.  The `:not_found` / `:error`
      // sentinels feed the 4-way `cond`.  Operation forms (seeded from the
      // loaded `record`) are bound in the `{:ok, record}` arm.
      const okArm =
        opAssigns.length > 0
          ? `        {:ok, record} ->
          socket
          |> assign(:${qb.assign}, record)
${opAssigns.map((a) => `  ${a}`).join("\n")}`
          : `        {:ok, record} -> assign(socket, :${qb.assign}, record)`;
      loadBlocks.push(
        `    socket =
      case ${ctxModule}.get_${aggSnake}(socket.assigns.id) do
${okArm}
        {:error, :not_found} -> assign(socket, :${qb.assign}, :not_found)
        _ -> assign(socket, :${qb.assign}, :error)
      end`,
      );
    } else {
      // List read: `list_<agg>s()` returns `{:ok, list}` (the repo wraps
      // `Repo.all/1`).  The `{:error, _}` arm maps to the `:error` sentinel
      // the list `cond` renders as the error slot.
      loadBlocks.push(
        `    socket =
      case ${ctxModule}.list_${aggSnake}s() do
        {:ok, items} -> assign(socket, :${qb.assign}, items)
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

/** Per-operation `validate_<op>` / `submit_<op>` handle_event clauses.  The
 *  Ecto-changeset form lifecycle: validate on change, submit on submit; on
 *  success re-load the record into @data, rebuild the op form, flash, and
 *  push_patch back to the detail route (canonical re-load path).  One pair per
 *  `kind:"operation"` FormBinding. */
function renderOperationEventClauses(
  formBindings: import("./heex-walker.js").FormBinding[],
  /** The detail page's route with the trailing `/:id` stripped,
   *  e.g. "/customers" — used to push_patch back after submit. */
  detailBaseRoute: string | null,
  /** Module-qualified context per aggregate PascalCase name — resolves the
   *  `<Ctx>.update_<agg>` / `<Ctx>.change_<agg>` calls. */
  contextModuleByAggName: ReadonlyMap<string, string>,
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
        // Op-form lifecycle: validate builds a changeset off the CURRENT @data
        // record with the incoming params + `action: :validate` (so the form
        // shows errors); submit persists via `update_<agg>` and re-seeds the op
        // form from the saved record.
        const ctxModule = contextModuleByAggName.get(fb.name);
        const aggSnake = snake(fb.name);
        if (!ctxModule) return ""; // unresolved — validator catches upstream
        return `  @impl true
  def handle_event("validate_${op}", %{"${op}" => params}, socket) do
    changeset =
      socket.assigns.data
      |> ${ctxModule}.change_${aggSnake}(params)
      |> Map.put(:action, :validate)

    {:noreply, assign(socket, :${op}_form, to_form(changeset))}
  end

  @impl true
  def handle_event("submit_${op}", %{"${op}" => params}, socket) do
    case ${ctxModule}.update_${aggSnake}(socket.assigns.data, params) do
      {:ok, record} ->
        {:noreply,
         socket
         |> put_flash(:info, "${human} succeeded")
         |> assign(:data, record)
         |> assign(:${op}_form, ${ctxModule}.change_${aggSnake}(record) |> to_form())${reload}}

      {:error, %Ecto.Changeset{} = changeset} ->
        {:noreply, assign(socket, :${op}_form, to_form(changeset))}
    end
  end\n`;
      })
      .join("\n")
  );
}

/** Create-form (`CreateForm(of: Agg)`) submit handler — `save_<agg>`.  The
 *  scaffold "new" page's `<.simple_form phx-submit="save_<agg>">` needs a
 *  matching `handle_event` or the submit no-ops.  On success → flash + navigate
 *  to the list route; on a changeset error → re-assign the form so the inline
 *  errors render. */
function renderCreateEventClauses(
  formBindings: import("./heex-walker.js").FormBinding[],
  contextModuleByAggName: ReadonlyMap<string, string>,
  /** The create page's route with a trailing `/new` stripped
   *  (`/customers/new` → `/customers`), navigated to on success. */
  listRoute: string | null,
): string {
  const creates = formBindings.filter((fb) => fb.kind === "aggregate");
  if (creates.length === 0) return "";
  const fb = creates[0]!; // single @form per page
  const ctxModule = contextModuleByAggName.get(fb.name);
  if (!ctxModule) return "";
  const aggSnake = snake(fb.name);
  const human = humanizeOp(`create_${aggSnake}`);
  const nav = listRoute ? `\n         |> push_navigate(to: ~p"${listRoute}")` : "";
  return `\n  @impl true
  def handle_event("save_${aggSnake}", %{"${aggSnake}" => params}, socket) do
    case ${ctxModule}.create_${aggSnake}(params) do
      {:ok, _record} ->
        {:noreply,
         socket
         |> put_flash(:info, "${human} succeeded")${nav}}

      {:error, %Ecto.Changeset{} = changeset} ->
        {:noreply, assign(socket, :form, to_form(changeset))}
    end
  end\n`;
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
      // money AND decimal are :string for assign typing — both are Decimal
      // structs that serialise to string for Jason / LiveView assigns;
      // arithmetic happens inside the LiveView event handler via Decimal.add/2.
      return t.name === "int" ? ":integer" : t.name === "bool" ? ":boolean" : ":string";
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
  /** Aggregate PascalCase name → module-qualified context — threaded through to
   *  the walker for an awaited `match await` in a component action (Stage 2). */
  contextModuleByAggName: ReadonlyMap<string, string>;
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
    contextModuleByAggName,
    authEnabled,
  } = args;
  const webModule = `${appModule}Web`;
  const defs = ui.components
    .filter((c) => !c.extern)
    .map((c) => {
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
        contextModuleByAggName,
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
