import type {
  AggregateIR,
  BoundedContextIR,
  ComponentIR,
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  PageIR,
  ParamIR,
  SystemIR,
  UiIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { contextUsesMoney, uiUsesMoney } from "../../ir/types/loom-ir.js";
import { backendServesRealtime, realtimeEventTypes } from "../../ir/util/channels.js";
import { classifyPage, type PageNameCtx, pageConstructId } from "../../ir/util/page-kind.js";
import { API_BASE_PATH } from "../../util/api-base.js";
import { humanize, plural, snake, upperFirst } from "../../util/naming.js";
import { buildApiModule } from "../_frontend/api-module.js";
import { AUTH_GATE_VUE, AUTH_SESSION_TS, AUTH_USE_SESSION_VUE } from "../_frontend/auth-ui.js";
import {
  buildExternFunctionShim,
  buildExternFunctionSignature,
} from "../_frontend/extern-functions.js";
import { deriveSidebarFromUi } from "../_frontend/menu-emitter.js";
import { renderRealtimeClient } from "../_frontend/realtime.js";
import { smokeSpec } from "../_frontend/smoke-spec.js";
import { buildTableSortHelper } from "../_frontend/table-sort-helper.js";
import { prepareThemeVM } from "../_frontend/theme-preparer.js";
import { buildViewsApiModule, hasAnyView } from "../_frontend/views-module.js";
import { buildWorkflowsApiModule, hasAnyWorkflow } from "../_frontend/workflows-module.js";
import type { LoadedPack } from "../_packs/loader.js";
import { loadPack, resolvePackDir } from "../_packs/loader-fs.js";
import { emitShellFiles, emitShellGlobs } from "../_packs/shell-emits.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import { walkBody } from "../_walker/walker-core.js";
// Framework-neutral pieces that live react-side today (same sharing
// pattern as the elixir theme-emit): the e2e harness constants, the
// page-object emitters (testid/DOM-only — `@loom/ui-test-driver`
// drives any framework's markup), and the theme/money constants.
// Candidates for a later `_frontend/` move.
import {
  E2E_FIXTURES_TS,
  E2E_PACKAGE_JSON,
  E2E_TSCONFIG_JSON,
  PLAYWRIGHT_CONFIG_TS,
  REACT_LIB_SCHEMAS_MONEY_TS,
} from "../react/emit-templates.js";
import { emitPageObjectsForUi } from "../react/pages-emitter.js";
import { prepareVueNamedLayouts } from "./layouts-emitter.js";
import { buildVueRealtimeHandlers } from "./realtime-handlers-builder.js";
import { renderVueStoreModule } from "./store-builder.js";
import {
  renderVueComponentFile,
  renderVueExternComponentProps,
  renderVueExternComponentShim,
  renderVuePage,
} from "./walker/page-shell.js";
import { vueTarget } from "./walker/vue-target.js";

// ---------------------------------------------------------------------------
// Vue 3 + vue-query + Zod + Vuetify generator.
//
// Emits a Vite-built SPA per vue-platform deployable — the structural
// mirror of the React generator (`src/generator/react/index.ts`):
// same `ui:`-driven page model, same wire-shape-derived api modules
// (the SHARED `_frontend/api-module.ts` builder — only the TanStack
// Query import specifier differs), same two-stage vite-build /
// vite-preview docker runtime.
//
// Slice 3 scope (vue-frontend-plan.md): project shell + api modules +
// router + page SKELETONS.  Page bodies walk through the shared
// markup walker with `vueTarget` in the next slice; until then each
// declared page emits a stub SFC (route + testid + title) so the
// route table, nav, and build gates are real.
// ---------------------------------------------------------------------------

/** Options for the Vue generator's secondary entry point — the
 *  backend-host embedding path (dotnet / java / elixir hosting a
 *  `framework: vue` ui).  Mirrors `GenerateReactOptions`:
 *  `apiBaseUrl: "/api"` for same-origin fetches; `pathPrefix`
 *  relocates the project under the host's SPA dir. */
export interface GenerateVueOptions {
  apiBaseUrl?: string;
  pathPrefix?: string;
  /** Sub-path the built bundle is served under (Phoenix `/app`) — sets
   *  the vite `base` and bakes the vue-router history basename.  Unset
   *  for root-served hosts (dotnet/java wwwroot, standalone) →
   *  byte-identical. */
  basePath?: string;
  /** Top-level (workspace-wide) components — pure render functions
   *  declared as bare `ModelMember`s in any reachable `.ddd` document.
   *  Merged into the per-ui name→params map; emitted as
   *  `src/components/<Name>.vue` (ui-scope wins on name collisions).
   *  Mirrors `GenerateReactOptions.topLevelComponents`. */
  topLevelComponents?: ComponentIR[];
  /** Generate-time source-map recorder (`--sourcemap`) — see
   *  `PlatformSurface.emitProject`'s doc comment.  Records whole-file
   *  regions for pages + components alongside their `out.set(...)`. */
  sourcemap?: SourceMapRecorder;
}

export function generateVueForContexts(
  contexts: EnrichedBoundedContextIR[],
  sys: SystemIR,
  deployable: DeployableIR,
  options: GenerateVueOptions = {},
): Map<string, string> {
  const out = new Map<string, string>();

  const target = sys.deployables.find((d) => d.name === deployable.targetName);
  // Same-origin relative `/api` base; `vite dev` proxies it to the
  // target backend, docker-compose overrides via `VITE_API_BASE_URL`.
  const apiBaseUrl = options.apiBaseUrl ?? API_BASE_PATH;
  const apiProxyTarget = `http://localhost:${target?.port ?? 8080}`;
  const basePath = options.basePath ?? "";
  const viteBase = basePath ? `${basePath}/` : undefined;
  const routerBasename = basePath || undefined;

  const aggregates: Array<{ agg: EnrichedAggregateIR; ctx: EnrichedBoundedContextIR }> = [];
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) aggregates.push({ agg, ctx });
  }

  // `deployable.design` is fully qualified by lowering ("vuetify@v3");
  // the `??` default is defensive against programmatic IR construction.
  const design = deployable.design ?? "vuetify@v3";
  const pack = loadPack(resolvePackDir(design));

  // Every vue deployable declares a `ui:` binding (validator rule
  // `loom.vue-deployable-missing-ui`).  Same fail-loudly contract as
  // the React orchestrator.
  if (!deployable.uiName) {
    throw new Error(
      `Vue deployable '${deployable.name}' has no 'ui:' binding. The validator should have caught this; an upstream pipeline (programmatic IR construction?) skipped the AST validator.`,
    );
  }
  const ui = sys.uis.find((u) => u.name === deployable.uiName);
  if (!ui) {
    throw new Error(
      `Vue deployable '${deployable.name}' references ui '${deployable.uiName}' but no such ui is declared in the system.`,
    );
  }

  // Per-aggregate api modules — 1:1 with the aggregate inventory,
  // emitted from the shared `_frontend` builder with vue-query naming.
  for (const { agg, ctx } of aggregates) {
    const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
    out.set(
      `src/api/${agg.name[0]!.toLowerCase()}${agg.name.slice(1)}.ts`,
      buildApiModule(agg, repo, ctx, { queryPackage: "@tanstack/vue-query" }),
    );
  }

  // Pages — bodies walk through the SHARED markup walker with
  // `vueTarget`; the vuetify pack templates own the Vue markup the
  // primitives emit.  A page with no body (legal but unusual) keeps
  // the stub shell so the route still mounts.
  const pages = ui.pages.filter((p) => p.route);
  const aggregatesIRByName = new Map<string, AggregateIR>();
  const bcByAggregate = new Map<string, BoundedContextIR>();
  const workflowsByName = new Map<string, WorkflowIR>();
  const bcByWorkflow = new Map<string, BoundedContextIR>();
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      aggregatesIRByName.set(agg.name, agg);
      bcByAggregate.set(agg.name, ctx);
    }
    for (const wf of ctx.workflows) {
      workflowsByName.set(wf.name, wf);
      bcByWorkflow.set(wf.name, ctx);
    }
  }
  const pageRoutes = new Map<string, string>();
  for (const page of pages) pageRoutes.set(page.name, page.route!);
  // Name-context for `classifyPage` (slice 3c — replaces the stamped `origin`).
  const pageCtx: PageNameCtx = {
    aggregateNames: [...aggregatesIRByName.keys()],
    workflowNames: [...workflowsByName.keys()],
    viewNames: contexts.flatMap((c) => c.views.map((v) => v.name)),
  };

  // Extern frontend functions (extern-function-hook-escape-hatch.md §3):
  // the SAME two machine-owned files as react — the wire-DTO-typed
  // signature (`src/lib/extern/<name>.signature.ts`; Vue keeps the api
  // modules at `src/api/` like react, so the default `"../../api"`
  // import root is correct) and the conformance shim
  // (`src/lib/<name>.ts`).  Body calls register through
  // `externFunctionNames`; the page shell imports each used shim as
  // `<relPrefix>lib/<name>`.
  const externFunctionNames = new Set<string>();
  for (const fn of ui.functions ?? []) {
    externFunctionNames.add(fn.name);
    out.set(`src/lib/extern/${fn.name}.signature.ts`, buildExternFunctionSignature(fn));
    out.set(`src/lib/${fn.name}.ts`, buildExternFunctionShim(fn));
  }

  // User components.  Top-level (workspace-wide) components merge with
  // the ui's own, ui-scope last so it shadows on name collision.  The
  // name→params map threads into every page / component walk so a
  // `Name(args)` call renders as the `<Name :prop="…" />` tag.  A walked
  // component emits `src/components/<Name>.vue`; an `extern` one emits a
  // typed `<Name>.props.ts` + a `<Name>.ts` re-export shim instead (the
  // user owns the hand-written `.vue`), and is imported without the
  // extension at call sites.
  const userComponents = new Map<string, readonly ParamIR[]>();
  for (const c of options.topLevelComponents ?? []) userComponents.set(c.name, c.params);
  for (const c of ui.components) userComponents.set(c.name, c.params);

  // Frontend auth guard (D-AUTH-OIDC, `auth: ui`): gates `page { requires … }`
  // and currentUser-only operation-`requires` action-button rendering.
  // Computed here (before component + page emission, both of which consume it).
  const authUi = !!(deployable.auth?.ui && target?.auth?.required && sys.user);

  const emittedComponents = new Map<string, ComponentIR>();
  for (const c of options.topLevelComponents ?? []) emittedComponents.set(c.name, c);
  for (const c of ui.components) emittedComponents.set(c.name, c);
  const externComponentNames = new Set<string>();
  // True once any page or component emits a default-submit create/workflow
  // form: those push a success toast, so `lib/toast.ts` must exist and the
  // app-shell must mount the toast host (`hasToastHost` below).
  let hasFormToast = false;
  for (const c of emittedComponents.values()) {
    const componentConstruct = `${ui.name}.${c.name}`;
    if (c.extern) {
      externComponentNames.add(c.name);
      const propsPath = `src/components/${c.name}.props.ts`;
      const propsContent = renderVueExternComponentProps(c.name, c.params, aggregatesIRByName);
      out.set(propsPath, propsContent);
      options.sourcemap?.file(propsPath, propsContent, c.origin, componentConstruct);
      const shimPath = `src/components/${c.name}.ts`;
      const shimContent = renderVueExternComponentShim(
        c.name,
        c.externPath ?? "",
        c.params.some(
          (p) =>
            p.type.kind === "slot" || (p.type.kind === "optional" && p.type.inner.kind === "slot"),
        ),
      );
      out.set(shimPath, shimContent);
      options.sourcemap?.file(shimPath, shimContent, c.origin, componentConstruct);
      continue;
    }
    const component = renderVueComponentFile(
      c.name,
      c.params,
      c.state,
      c.body!,
      pack,
      userComponents,
      aggregatesIRByName,
      bcByAggregate,
      pageRoutes,
      externFunctionNames,
      externComponentNames,
      c.derived,
      // `auth: ui` enables currentUser-only operation-`requires` gating on
      // `Action(...)` buttons in this component.
      authUi,
      // Named, typed component event handlers (Proposal A Stage 1).
      c.actions,
      // Store declarations — drives store-member binding (Stage 5).
      ui.stores,
    );
    if (component.usesFormToast) hasFormToast = true;
    const componentPath = `src/components/${c.name}.vue`;
    out.set(componentPath, component.source);
    options.sourcemap?.file(componentPath, component.source, c.origin, componentConstruct);
  }

  for (const page of pages) {
    if (!page.body) {
      const stubPath = pagePath(page);
      const stubContent = renderPageStub(page);
      out.set(stubPath, stubContent);
      options.sourcemap?.file(stubPath, stubContent, page.origin, pageConstructId(ui.name, page));
      continue;
    }
    const paramNames = new Set(page.params.map((p) => p.name));
    const stateNames = new Set(page.state.map((s) => s.name));
    const derivedNames = new Set(page.derived.map((d) => d.name));
    const result = walkBody(
      page.body,
      vueTarget,
      pack,
      paramNames,
      stateNames,
      userComponents,
      ui.apiParams,
      aggregatesIRByName,
      bcByAggregate,
      workflowsByName,
      bcByWorkflow,
      new Map(),
      pageRoutes,
      externFunctionNames,
      derivedNames,
      authUi,
    );
    if (
      result.formOfs.some(
        (f) => (f.kind === "aggregate" || f.kind === "workflow") && f.onSubmitJs === null,
      )
    ) {
      hasFormToast = true;
    }
    const renderedPagePath = pagePath(page);
    const renderedPageContent = renderVuePage({
      page,
      routeParams: page.params.map((p) => p.name),
      result,
      pack,
      externComponents: externComponentNames,
      authUi,
      stores: ui.stores,
      // Stage 2 (`match await <op>()`): the detection context a page action
      // needs to recognise + hoist an awaited op's vue-query mutation.
      apiParams: ui.apiParams,
      aggregatesByName: aggregatesIRByName,
      bcByAggregate,
    });
    out.set(renderedPagePath, renderedPageContent);
    options.sourcemap?.file(
      renderedPagePath,
      renderedPageContent,
      page.origin,
      pageConstructId(ui.name, page),
    );
  }
  out.set("src/pages/NotFound.vue", renderShell(pack, "not-found-page", {}));

  // Store modules (named-actions-and-stores.md §3, Stage 5) — one `reactive()`
  // singleton per `store Cart { … }` at `src/stores/<snake>.ts`.  Page/component
  // shells import these (`../stores/cart`) and bind one local per used member.
  for (const store of ui.stores) {
    out.set(`src/stores/${snake(store.name)}.ts`, renderVueStoreModule(store));
  }

  // Named layouts (Phase 8).  A page selects one via `layout: <Name>`;
  // `layout: none` mounts outside all chrome.  When any page uses a
  // non-default layout we restructure into nested vue-router routes:
  // the default chrome moves to `src/layouts/DefaultLayout.vue`, App.vue
  // becomes a thin `<router-view />` host, and each named layout is its
  // own SFC.  Default-only uis keep the flat router + chrome-in-App.vue
  // shape (byte-identical).
  const namedLayoutPages = new Map<string, PageIR[]>();
  const nonePages: PageIR[] = [];
  const defaultPages: PageIR[] = [];
  for (const page of pages) {
    if (page.layout?.kind === "named") {
      const bucket = namedLayoutPages.get(page.layout.ref) ?? [];
      bucket.push(page);
      namedLayoutPages.set(page.layout.ref, bucket);
    } else if (page.layout?.kind === "preset" && page.layout.name === "none") {
      nonePages.push(page);
    } else {
      defaultPages.push(page);
    }
  }
  const preparedLayouts = prepareVueNamedLayouts(
    ui,
    sys,
    pack,
    options.topLevelComponents ?? [],
    externComponentNames,
  );
  const useLayouts = preparedLayouts.length > 0 || nonePages.length > 0;
  for (const l of preparedLayouts) out.set(`src/layouts/${l.name}.vue`, l.content);

  out.set(
    "src/router.ts",
    useLayouts
      ? renderNestedRouter({ defaultPages, nonePages, namedLayoutPages }, routerBasename)
      : renderRouter(pages, routerBasename),
  );

  // Page objects + the Playwright e2e harness (vue-frontend-plan.md
  // Slice 6).  Page objects are framework-neutral — testid/DOM only,
  // driven by `@loom/ui-test-driver` — so the SAME builders the React
  // generator uses emit them here; the testid contract is identical
  // because the vuetify templates splice the same `{{{testidAttr}}}`
  // values.  The smoke spec navigates by route (shared
  // `_frontend/smoke-spec.ts`).
  const pageObjects = emitPageObjectsForUi(ui, {
    sys,
    deployable,
    aggregatesByName: aggregatesIRByName,
    contextsByName: new Map(contexts.map((c) => [c.name, c])),
    pack,
    topLevelComponents: options.topLevelComponents ?? [],
  });
  for (const [path, content] of pageObjects) out.set(path, content);
  out.set("e2e/smoke.spec.ts", smokeSpec(ui, pageCtx));
  out.set("e2e/fixtures.ts", E2E_FIXTURES_TS);
  out.set("e2e/playwright.config.ts", PLAYWRIGHT_CONFIG_TS);
  out.set("e2e/package.json", E2E_PACKAGE_JSON);
  out.set("e2e/tsconfig.json", E2E_TSCONFIG_JSON);

  // Shared views / workflows api modules — 1:1 with the inventory,
  // same builders as React with the vue-query import.
  if (hasAnyWorkflow(contexts)) {
    out.set(
      "src/api/workflows.ts",
      buildWorkflowsApiModule(contexts, { queryPackage: "@tanstack/vue-query" }),
    );
  }
  if (hasAnyView(contexts)) {
    out.set(
      "src/api/views.ts",
      buildViewsApiModule(contexts, { queryPackage: "@tanstack/vue-query" }),
    );
  }

  // Shared shell files (api/ + vue/ + docker/ shared-source layers).
  const hasDelete = aggregates.some((a) => !!a.agg.canonicalDestroy);
  // `authUi` computed above (before page emission, which consumes it for the
  // `page { requires … }` gate).  Drives the session client + provide/inject
  // route guard emits below (the Vue-shaped half of the React auth wiring).
  out.set("src/api/client.ts", renderShell(pack, "api-client", { hasDelete, hasAuthUi: authUi }));
  out.set("src/api/config.ts", renderShell(pack, "api-config", { apiBaseUrl }));
  if (authUi) {
    out.set("src/auth/session.ts", AUTH_SESSION_TS);
    out.set("src/auth/useSession.ts", AUTH_USE_SESSION_VUE);
    out.set("src/auth/AuthGate.vue", AUTH_GATE_VUE);
  }
  out.set("src/logger.ts", renderShell(pack, "logger", {}));
  out.set("src/lib/format.ts", renderShell(pack, "format-helpers", {}));
  // Interactive-table sort helper (M-T1.1) — imported by a page only when it
  // renders a sortable `Table`; emitted unconditionally (like format.ts).
  out.set("src/lib/table-sort.ts", buildTableSortHelper());
  // The reactive()+zod form runtime (vue/ shared source) — the
  // generated pages' field inputs and v-form handlers bind to it.
  out.set("src/lib/form.ts", renderShell(pack, "loom-form", {}));

  // Realtime SSE client + live-event handlers (channels.md Part I).
  // Mirrors the react/svelte wiring: when the targeted backend exposes
  // the realtime wire (any `delivery: broadcast` channel; Hono is the
  // only backend serving GET /realtime/events so far), emit the
  // EventSource client.  When the ui ALSO declares `on <channel>.<Event>`
  // handlers, emit the renderless RealtimeHandlers component + the toast
  // queue the app-shell mounts; the config module exports `API_BASE_URL`
  // on Vue (the SvelteKit symbol).
  const realtimeTypes = backendServesRealtime(target?.platform)
    ? [...new Set(contexts.flatMap((c) => [...realtimeEventTypes(c)]))].sort()
    : [];
  if (realtimeTypes.length > 0) {
    out.set("src/api/realtime.ts", renderRealtimeClient(realtimeTypes, "API_BASE_URL"));
  }
  const hasRealtimeHandlers = realtimeTypes.length > 0 && (ui.notifications?.length ?? 0) > 0;
  if (hasRealtimeHandlers) {
    out.set("src/components/RealtimeHandlers.vue", buildVueRealtimeHandlers(ui, pack));
  }
  // The toast queue + app-shell host serve realtime `on` handlers AND
  // form-submit success toasts; emit `lib/toast.ts` when either needs it.
  const hasToastHost = hasRealtimeHandlers || hasFormToast;
  if (hasToastHost) {
    out.set("src/lib/toast.ts", renderShell(pack, "toast", {}));
  }

  // Pack shell tier.
  out.set("src/theme.ts", renderShell(pack, "theme", prepareThemeVM(sys.theme)));
  out.set("src/main.ts", renderShell(pack, "main", { authUi }));
  // App root.  Default-only uis render the pack chrome straight into
  // App.vue (the flat-router shape).  When named layouts are in play the
  // chrome moves to `src/layouts/DefaultLayout.vue` and App.vue is a thin
  // `<router-view />` host that mounts the channel handlers once for
  // every layout.
  // Sidebar: an explicit `ui.menu { … }` wins (via the shared
  // `deriveSidebarFromUi` mirror — same driver as React/Svelte); the
  // scaffold-origin grouping is the default otherwise.  `authUi` lets
  // `deriveSidebarFromUi` render a `requiresJs` gate on any entry whose
  // linked page declares a `requires` clause, so the app-shell can hide a
  // forbidden page's nav link at runtime.
  const sidebarOverride = deriveSidebarFromUi(ui, pageCtx, authUi);
  const navSections: Array<{
    label: string;
    entries: Array<{
      to: string;
      label: string;
      testId: string;
      exact?: boolean;
      external?: boolean;
      href?: string;
      requiresJs?: string;
    }>;
  }> = sidebarOverride
    ? sidebarOverride.map((s) => ({
        label: s.label,
        entries: s.entries.map((e) => ({
          to: e.to,
          label: e.label,
          testId: e.testId,
          // The Vue templates append `, { exact: true }` to `isActive(...)`
          // off this flag; the shared emitter carries it inside `activeArgs`.
          exact: e.activeArgs.includes("exact: true"),
          external: e.external,
          href: e.href,
          // Per-link gate condition (auth: ui) — the app-shell `v-if`-hides a
          // forbidden page's link.  Absent ⇒ link always shown.
          requiresJs: e.requiresJs,
        })),
      }))
    : deriveNavSections(defaultPages, pageCtx);
  // Bind the session user in the app-shell only when a nav entry is actually
  // gated — an unused `currentUser` binding would be a vue-tsc error.
  const navUsesSession = navSections.some((s) =>
    s.entries.some((e) => "requiresJs" in e && !!e.requiresJs),
  );
  const chromeVM = {
    systemNameHuman: humanize(sys.name),
    navSections,
    navUsesSession,
    hasRealtimeHandlers,
    hasToastHost,
  };
  if (useLayouts) {
    // The chrome (and its toast/realtime hosts) move OUT of App.vue into
    // DefaultLayout — but that file sits a directory deeper than `src/`,
    // so the app-shell's `./lib/toast` / `./components` imports wouldn't
    // resolve there.  Both hosts stay off the layout (matching the
    // realtime host's existing behaviour); RealtimeHandlers re-mounts once
    // in App.vue via app-root.
    out.set(
      "src/layouts/DefaultLayout.vue",
      renderShell(pack, "app-shell", {
        ...chromeVM,
        hasRealtimeHandlers: false,
        hasToastHost: false,
      }),
    );
    out.set("src/App.vue", renderShell(pack, "app-root", { hasRealtimeHandlers }));
  } else {
    out.set("src/App.vue", renderShell(pack, "app-shell", chromeVM));
  }

  const usesMoney = contexts.some(contextUsesMoney) || uiUsesMoney(ui);
  if (usesMoney) {
    out.set("src/lib/schemas.ts", REACT_LIB_SCHEMAS_MONEY_TS);
  }
  out.set("package.json", renderShell(pack, "package-json", { usesMoney }));
  out.set("tsconfig.json", renderShell(pack, "tsconfig", {}));
  out.set("tsconfig.node.json", renderShell(pack, "tsconfig-node", {}));
  out.set("vite.config.ts", renderShell(pack, "vite-config", { base: viteBase, apiProxyTarget }));
  // TS 6 (TS2882) requires a declaration for side-effect imports of
  // non-code modules; the shadcnVue pack's `main.ts` does
  // `import "./globals.css"`.  `vite/client` declares the `*.css`
  // side-effect module (mirrors the React generator).
  out.set("src/vite-env.d.ts", '/// <reference types="vite/client" />\n');
  out.set("index.html", renderShell(pack, "index-html", prepareIndexHtmlVM(deployable, ui)));
  out.set("Dockerfile", renderShell(pack, "dockerfile", {}));
  out.set(".dockerignore", renderShell(pack, "dockerignore", {}));
  out.set("certs/.gitkeep", "");

  // Pack-specific extras — `shellFiles` and `shellGlobs` from
  // pack.json.  vuetify ships neither; shadcnVue ships globals-css /
  // lib-utils / the components-ui barrel plus the `components-ui-*`
  // source-copy glob (`src/components/ui/{1}.vue`).
  emitShellFiles(pack, out);
  emitShellGlobs(pack, out);

  // Path-prefix transform — applied once at the end (mirrors the
  // React generator) so every emitter above stays path-agnostic.
  const pathPrefix = options.pathPrefix ?? "";
  if (pathPrefix === "") return out;
  const prefixed = new Map<string, string>();
  for (const [path, content] of out) {
    prefixed.set(`${pathPrefix}${path}`, content);
  }
  return prefixed;
}

function renderShell(pack: LoadedPack, name: string, vm: unknown): string {
  return pack.render(name, vm);
}

// ---------------------------------------------------------------------------
// Pages + router
// ---------------------------------------------------------------------------

/** Emit path for a page — the React generator's path convention with
 *  `.vue` in place of `.tsx` (scaffold pages keep their conventional
 *  `src/pages/<plural>/list.vue` shape via `emitPath`). */
function pagePath(page: PageIR): string {
  if (page.emitPath) return page.emitPath.replace(/\.tsx$/, ".vue");
  return `src/pages/${snake(page.name)}.vue`;
}

/** Pascal component name for a page's router import, derived from its
 *  emit path so sibling pages in different directories can't collide
 *  (`orders/list` → `OrdersList`, `engineer_detail` → `EngineerDetail`). */
function pageComponentName(page: PageIR): string {
  const rel = pagePath(page)
    .replace(/^src\/pages\//, "")
    .replace(/\.vue$/, "");
  return rel
    .split("/")
    .map((seg) => seg.split(/[_-]/).map(upperFirst).join(""))
    .join("");
}

function renderPageStub(page: PageIR): string {
  const title = staticTitleOf(page) ?? humanize(page.name);
  const slug = snake(page.name).replace(/_/g, "-");
  return `<!-- Auto-generated. -->
<script setup lang="ts"></script>

<template>
  <div data-testid="page-${slug}">
    <h2 class="text-h5">${escapeHtml(title)}</h2>
    <!-- TODO(vue-walker): page body renders through the shared markup walker in the next slice -->
  </div>
</template>
`;
}

/** The shared `__LOOM_BASENAME__` hook block both router shapes emit. */
function pushBasename(lines: string[], bakedBasename?: string): void {
  lines.push("// Optional basename hook the host page can set before the bundle");
  lines.push("// runs (e.g. the Loom playground iframe injects __LOOM_BASENAME__");
  lines.push("// so routes resolve inside the iframe scope).  Plain deploys");
  lines.push("// leave it undefined and the history defaults to `/`.");
  lines.push("const basename =");
  lines.push(`  (typeof window !== "undefined"`);
  lines.push("    ? (window as { __LOOM_BASENAME__?: string }).__LOOM_BASENAME__");
  lines.push(
    `    : undefined) ?? ${bakedBasename !== undefined ? JSON.stringify(bakedBasename) : "undefined"};`,
  );
}

function renderRouter(pages: PageIR[], bakedBasename?: string): string {
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { createRouter, createWebHistory } from "vue-router";`);
  for (const page of pages) {
    const rel = pagePath(page).replace(/^src\//, "./");
    lines.push(`import ${pageComponentName(page)} from "${rel}";`);
  }
  lines.push(`import NotFound from "./pages/NotFound.vue";`);
  lines.push("");
  pushBasename(lines, bakedBasename);
  lines.push("");
  lines.push("export const router = createRouter({");
  lines.push("  history: createWebHistory(basename),");
  lines.push("  routes: [");
  for (const page of pages) {
    lines.push(
      `    { path: ${JSON.stringify(page.route!)}, component: ${pageComponentName(page)} },`,
    );
  }
  lines.push(`    { path: "/:pathMatch(.*)*", component: NotFound },`);
  lines.push("  ],");
  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

/** Nested-route table for the named-layouts shape: `layout: none` pages
 *  mount top-level (no chrome), each named layout wraps its pages as
 *  `children`, and the default `DefaultLayout` chrome wraps the rest +
 *  the NotFound catch-all. */
function renderNestedRouter(
  buckets: {
    defaultPages: PageIR[];
    nonePages: PageIR[];
    namedLayoutPages: ReadonlyMap<string, PageIR[]>;
  },
  bakedBasename?: string,
): string {
  const { defaultPages, nonePages, namedLayoutPages } = buckets;
  const layoutNames = [...namedLayoutPages.keys()].sort();
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { createRouter, createWebHistory } from "vue-router";`);
  const allPages = [
    ...nonePages,
    ...layoutNames.flatMap((n) => namedLayoutPages.get(n)!),
    ...defaultPages,
  ];
  for (const page of allPages) {
    const rel = pagePath(page).replace(/^src\//, "./");
    lines.push(`import ${pageComponentName(page)} from "${rel}";`);
  }
  lines.push(`import NotFound from "./pages/NotFound.vue";`);
  lines.push(`import DefaultLayout from "./layouts/DefaultLayout.vue";`);
  for (const name of layoutNames) {
    lines.push(`import ${name}Layout from "./layouts/${name}.vue";`);
  }
  lines.push("");
  pushBasename(lines, bakedBasename);
  lines.push("");
  lines.push("export const router = createRouter({");
  lines.push("  history: createWebHistory(basename),");
  lines.push("  routes: [");
  // `layout: none` — top-level, no chrome.
  for (const page of nonePages) {
    lines.push(
      `    { path: ${JSON.stringify(page.route!)}, component: ${pageComponentName(page)} },`,
    );
  }
  // Named layouts — each wraps its pages as children.  The parent is a
  // pathless (`path: ""`) layout route: children keep their absolute
  // paths, so the empty parent path is a grouping anchor (and satisfies
  // vue-router's `RouteRecordRaw`, which requires a string `path`).
  for (const name of layoutNames) {
    lines.push("    {");
    lines.push(`      path: "",`);
    lines.push(`      component: ${name}Layout,`);
    lines.push("      children: [");
    for (const page of namedLayoutPages.get(name)!) {
      lines.push(
        `        { path: ${JSON.stringify(page.route!)}, component: ${pageComponentName(page)} },`,
      );
    }
    lines.push("      ],");
    lines.push("    },");
  }
  // Default chrome — the rest + the NotFound catch-all.
  lines.push("    {");
  lines.push(`      path: "",`);
  lines.push("      component: DefaultLayout,");
  lines.push("      children: [");
  for (const page of defaultPages) {
    lines.push(
      `        { path: ${JSON.stringify(page.route!)}, component: ${pageComponentName(page)} },`,
    );
  }
  lines.push(`        { path: "/:pathMatch(.*)*", component: NotFound },`);
  lines.push("      ],");
  lines.push("    },");
  lines.push("  ],");
  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Nav sections — default sidebar derived from scaffold page origins
// (Aggregates / Workflows / Views).  Explicit `menu { … }` blocks
// arrive with the parity slice (`deriveSidebarFromUi` mirror).
// ---------------------------------------------------------------------------

interface NavEntryVM {
  to: string;
  label: string;
  testId: string;
  exact?: boolean;
}

function deriveNavSections(
  pages: PageIR[],
  nameCtx: PageNameCtx,
): Array<{ label: string; entries: NavEntryVM[] }> {
  const aggregates: NavEntryVM[] = [];
  const workflows: NavEntryVM[] = [];
  const views: NavEntryVM[] = [];
  for (const page of pages) {
    if (!page.route) continue;
    const o = classifyPage(page, nameCtx);
    if (o.kind === "aggregate-list") {
      const label = humanize(plural(o.aggregateName));
      aggregates.push({ to: page.route, label, testId: `nav-${snake(plural(o.aggregateName))}` });
    } else if (o.kind === "workflow-form") {
      workflows.push({
        to: page.route,
        label: humanize(o.workflowName),
        testId: `nav-wf-${snake(o.workflowName)}`,
      });
    } else if (o.kind === "view-list") {
      views.push({
        to: page.route,
        label: humanize(o.viewName),
        testId: `nav-view-${snake(o.viewName)}`,
      });
    }
  }
  const sections: Array<{ label: string; entries: NavEntryVM[] }> = [];
  if (aggregates.length > 0) sections.push({ label: "Aggregates", entries: aggregates });
  if (workflows.length > 0) sections.push({ label: "Workflows", entries: workflows });
  if (views.length > 0) sections.push({ label: "Views", entries: views });
  return sections;
}

// ---------------------------------------------------------------------------
// index.html metadata — same projection rule as the React generator:
// the route-`/` page (or the first page) supplies static SEO metadata;
// the deployable name is the title fallback.
// ---------------------------------------------------------------------------

function prepareIndexHtmlVM(deployable: DeployableIR, ui: UiIR): Record<string, unknown> {
  const page = ui.pages.find((p) => p.route === "/") ?? ui.pages[0];
  const metadata = page?.metadata;
  return {
    title: staticTitleOf(page) ?? deployable.name,
    description: metadata?.description,
    ogImage: metadata?.ogImage,
    canonical: metadata?.canonical,
    favicon: deployable.favicon,
    usesCodeBlock: false,
    usesFileUpload: false,
  };
}

function staticTitleOf(page: PageIR | undefined): string | undefined {
  const t = page?.title;
  if (!t) return undefined;
  if (t.kind === "literal" && t.lit === "string") return t.value;
  return undefined;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
