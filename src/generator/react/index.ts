import {
  type AggregateIR,
  type BoundedContextIR,
  contextUsesMoney,
  type DeployableIR,
  type EnrichedAggregateIR,
  type EnrichedBoundedContextIR,
  type PageIR,
  type SystemIR,
  type UiIR,
  uiUsesMoney,
} from "../../ir/types/loom-ir.js";
import { backendServesRealtime, realtimeEventTypes } from "../../ir/util/channels.js";
import { classifyPage, type PageNameCtx } from "../../ir/util/page-kind.js";
import { API_BASE_PATH } from "../../util/api-base.js";
import { lowerFirst, snake } from "../../util/naming.js";
import { buildApiModule } from "../_frontend/api-module.js";
import { AUTH_GATE_TSX, AUTH_SESSION_TS } from "../_frontend/auth-ui.js";
import { renderRealtimeClient } from "../_frontend/realtime.js";
import { smokeSpec } from "../_frontend/smoke-spec.js";
import { allViews, buildViewsApiModule, hasAnyView } from "../_frontend/views-module.js";
import {
  allWorkflows,
  buildWorkflowsApiModule,
  hasAnyWorkflow,
} from "../_frontend/workflows-module.js";
import { loadPack, resolvePackDir } from "../_packs/loader-fs.js";
import { emitShellFiles, emitShellGlobs } from "../_packs/shell-emits.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import {
  E2E_FIXTURES_TS,
  E2E_PACKAGE_JSON,
  E2E_TSCONFIG_JSON,
  PLAYWRIGHT_CONFIG_TS,
  REACT_LIB_APPLY_SERVER_ERRORS_TS,
  REACT_LIB_SCHEMAS_MONEY_TS,
  REACT_LIB_STRICT_FIELD_MAP_TS,
} from "./emit-templates.js";
import { prepareNamedLayouts } from "./layouts-emitter.js";
import { deriveSidebarFromUi } from "./menu-emitter.js";
import {
  deriveExtraRoutesFromUi,
  emitPageObjectsForUi,
  emitPagesForUi,
  uiUsesCodeBlock,
} from "./pages-emitter.js";
import { buildRealtimeHandlers } from "./realtime-handlers-builder.js";
import { renderZustandStoreModule } from "./store-builder.js";
import { renderAppShell, renderMain, renderShellFile, renderTheme } from "./templating/render.js";

// ---------------------------------------------------------------------------
// React + React Query + Zod + Mantine generator.
//
// Emits a Vite-built SPA per react-platform deployable.  Every React
// deployable declares a `ui:` binding (enforced by validator rule
// `loom.react-deployable-missing-ui`); pages are emitted by walking
// `ui.pages` through the body walker.  The `scaffold` stdlib macro
// populates `ui.pages` for the bulk-CRUD case so authors don't
// hand-write per-aggregate List / New / Detail pages.
//
// API URLs are baked in at generation time from the target deployable's
// port (overridable via `import.meta.env.VITE_API_BASE_URL`).  The
// generated app uses `@hono/zod-openapi`-style Zod schemas matching the
// backend's wire shape, parsed at the boundary so response types are
// validated, not just trusted.
// ---------------------------------------------------------------------------

/** Options for the React generator's secondary entry point — used by
 *  the .NET orchestrator's fullstack branch where the React
 *  project becomes a sub-tree of the .NET project and the SPA calls
 *  its host's API on the same origin.
 *    - `apiBaseUrl`: overrides the computed `http://localhost:<port>`
 *      target URL.  Fullstack dotnet passes `"/api"` so the SPA hits
 *      its embedded API server on the same origin (.NET controllers
 *      get the matching `/api` route prefix).
 *    - `pathPrefix`: prepended to every emitted path.  Fullstack
 *      dotnet passes `"ClientApp/"` so the React project lands under
 *      the .NET project's `ClientApp/` directory; the Dockerfile
 *      multi-stage build then `npm run build`s it and copies the
 *      output into `wwwroot/`. */
export interface GenerateReactOptions {
  apiBaseUrl?: string;
  pathPrefix?: string;
  /** Sub-path the built bundle is *served* under (e.g. `"/app"` when a
   *  Phoenix host serves the SPA at `/app` via `Plug.Static`).  Sets the
   *  vite `base` (so `index.html` references `/app/assets/…`) and bakes
   *  the router basename so client-side routing resolves under it.
   *  Root-served hosts (dotnet/java `wwwroot`, standalone) leave it
   *  unset → byte-identical output. */
  basePath?: string;
  /** Top-level (workspace-wide) components — pure render functions
   *  declared as bare `ModelMember`s in any reachable `.ddd`
   *  document.  The emitter merges them into the per-ui name→params
   *  map and emits `src/components/<Name>.tsx` for every top-level
   *  component referenced from this ui (ui-scope wins on
   *  collisions). */
  topLevelComponents?: import("../../ir/types/loom-ir.js").ComponentIR[];
  /** Generate-time source-map recorder (`--sourcemap`) — see
   *  `PlatformSurface.emitProject`'s doc comment.  Forwarded into
   *  `emitPagesForUi`'s context so the page/component loop can record
   *  whole-file regions alongside each `out.set(...)`. */
  sourcemap?: SourceMapRecorder;
}

export function generateReactForContexts(
  contexts: EnrichedBoundedContextIR[],
  sys: SystemIR,
  deployable: DeployableIR,
  options: GenerateReactOptions = {},
): Map<string, string> {
  const out = new Map<string, string>();

  const target = sys.deployables.find((d) => d.name === deployable.targetName);
  // Standalone react fetches the API same-origin via the relative
  // `/api` base; `vite dev` proxies it to the target backend (below),
  // docker-compose overrides via `VITE_API_BASE_URL`, and fullstack
  // dotnet passes `apiBaseUrl: "/api"` for its embedded same-origin API.
  const apiBaseUrl = options.apiBaseUrl ?? API_BASE_PATH;
  // `vite dev` same-origin proxy target: the standalone backend's dev
  // URL, so a relative `/api/*` fetch reaches it without CORS.
  const apiProxyTarget = `http://localhost:${target?.port ?? 8080}`;
  // Sub-path the bundle is served under (Phoenix `/app`).  `viteBase`
  // is the trailing-slashed form vite wants (`/app/`); `basename` is
  // the slashless router basename.  Unset for root-served hosts.
  const basePath = options.basePath ?? "";
  const viteBase = basePath ? `${basePath}/` : undefined;
  const routerBasename = basePath || undefined;

  // Per-aggregate api modules + pages.
  const aggregates: Array<{ agg: EnrichedAggregateIR; ctx: EnrichedBoundedContextIR }> = [];
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) aggregates.push({ agg, ctx });
  }

  // Workspace-wide aggregate registry — used by `X id` form-input
  // emission to resolve the target's display field across bounded
  // contexts.  Built once and threaded through every per-aggregate
  // builder to avoid recomputing per-call.
  const aggregatesByName = new Map<string, AggregateIR>();
  for (const { agg } of aggregates) aggregatesByName.set(agg.name, agg);

  // Route list-page emission through the new template-pack
  // layer.  `deployable.design` is fully qualified by the lowering
  // pass (e.g. "mantine@v7"); the `??` default is defensive against
  // programmatic IR construction that bypasses lowering and matches
  // the current toolchain's default Mantine version.
  const design = deployable.design ?? "mantine@v7";
  const pack = loadPack(resolvePackDir(design));

  // Page metamodel routing.  Every React deployable declares a
  // `ui:` binding (validator rule `loom.react-deployable-missing-ui`
  // enforces this).  `ui` is the resolved UiIR; if a programmatic
  // IR bypasses the validator and produces a react deployable with
  // no `uiName`, that's a bug — fail loudly here rather than emit
  // a half-formed project.
  if (!deployable.uiName) {
    throw new Error(
      `React deployable '${deployable.name}' has no 'ui:' binding. The validator should have caught this; an upstream pipeline (programmatic IR construction?) skipped the AST validator.`,
    );
  }
  const ui = sys.uis.find((u) => u.name === deployable.uiName);
  if (!ui) {
    throw new Error(
      `React deployable '${deployable.name}' references ui '${deployable.uiName}' but no such ui is declared in the system.`,
    );
  }

  // Per-aggregate api modules — always emitted; 1:1 with the
  // aggregate inventory.  Page emission below walks the resolved
  // `ui.pages` for both pages and page-objects (single source).
  for (const { agg, ctx } of aggregates) {
    const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
    out.set(`src/api/${lowerFirst(agg.name)}.ts`, buildApiModule(agg, repo, ctx));
  }

  const workflows = allWorkflows(contexts);
  const views = allViews(contexts);
  // Name-context for `classifyPage` (slice 3c): a page's kind is derived from
  // its role-scoped name + area against the served decls, not a stamped origin.
  const pageCtx: PageNameCtx = {
    aggregateNames: aggregates.map(({ agg }) => agg.name),
    workflowNames: workflows.map(({ wf }) => wf.name),
    viewNames: views.map(({ view }) => view.name),
  };

  // Single codegen path: every `src/pages/...` file (scaffold-derived
  // OR explicit) routes through `emitPagesForUi` → walker.
  const contextsByName = new Map<string, BoundedContextIR>();
  for (const ctx of contexts) contextsByName.set(ctx.name, ctx);
  // Frontend auth guard (D-AUTH-OIDC, `auth: ui`): this react deployable opts in
  // AND its target backend enforces auth (so `useSession()` / the verified claims
  // are available client-side).  Gates `page { requires … }` rendering below.
  const authUi = !!(deployable.auth?.ui && target?.auth?.required && sys.user);
  const emitCtx = {
    sys,
    deployable,
    aggregatesByName,
    contextsByName,
    pack,
    topLevelComponents: options.topLevelComponents ?? [],
    authUi,
    sourcemap: options.sourcemap,
  };
  const pages = emitPagesForUi(ui, emitCtx);
  for (const [path, content] of pages) out.set(path, content);
  const pageObjects = emitPageObjectsForUi(ui, emitCtx);
  for (const [path, content] of pageObjects) out.set(path, content);

  // Store modules (named-actions-and-stores.md §3, Stage 5) — one Zustand
  // module per `store Cart { … }` at `src/stores/<snake>.ts`.  Page/component
  // shells import these (`../stores/cart`) and bind the hook per used member.
  for (const store of ui.stores) {
    out.set(`src/stores/${snake(store.name)}.ts`, renderZustandStoreModule(store));
  }

  // Workflow UI — the shared workflows API module is 1:1 with the
  // workflow inventory; emit it regardless of the page-emission
  // path.  Pages + page-objects emit through `emitPagesForUi` /
  // `emitPageObjectsForUi`.
  if (hasAnyWorkflow(contexts)) {
    out.set("src/api/workflows.ts", buildWorkflowsApiModule(contexts));
  }

  // View UI — same shape as workflows: only the shared views API
  // module needs an unconditional emit.
  if (hasAnyView(contexts)) {
    out.set("src/api/views.ts", buildViewsApiModule(contexts));
  }

  out.set("e2e/smoke.spec.ts", smokeSpec(ui, pageCtx));
  out.set("e2e/fixtures.ts", E2E_FIXTURES_TS);
  out.set("e2e/playwright.config.ts", PLAYWRIGHT_CONFIG_TS);
  out.set("e2e/package.json", E2E_PACKAGE_JSON);
  out.set("e2e/tsconfig.json", E2E_TSCONFIG_JSON);

  // `api.delete` helper only when some served aggregate has a canonical
  // destroy (declared or via `crudish`) — keeps the shared client
  // byte-identical for projects without any hard-delete.
  const hasDelete = aggregates.some((a) => !!a.agg.canonicalDestroy);
  // `authUi` computed above (before page emission, which consumes it for the
  // `page { requires … }` gate).  Drives the session client + route guard emits.
  out.set(
    "src/api/client.ts",
    renderShellFile("api-client", { hasDelete, hasAuthUi: authUi }, pack),
  );
  out.set("src/api/config.ts", renderShellFile("api-config", { apiBaseUrl }, pack));
  if (authUi) {
    out.set("src/auth/session.ts", AUTH_SESSION_TS);
    out.set("src/auth/AuthGate.tsx", AUTH_GATE_TSX);
  }
  // Realtime SSE client (channels.md Part I): when the targeted backend
  // exposes the realtime wire (any `delivery: broadcast` channel; Hono is
  // the only backend serving GET /realtime/events so far), emit the
  // EventSource subscription helper.  Pack-agnostic shared shell file —
  // user code (and the future `on <channel>.<Event>` handlers) consume it.
  const realtimeTypes = backendServesRealtime(target?.platform)
    ? [...new Set(contexts.flatMap((c) => [...realtimeEventTypes(c)]))].sort()
    : [];
  if (realtimeTypes.length > 0) {
    out.set("src/api/realtime.ts", renderRealtimeClient(realtimeTypes, "API_BASE_URL"));
  }
  // Live-event handlers (`on <channel>.<Event>(e) { toast(…) }`) —
  // rendered as one renderless component App mounts at its root.
  // Gated on the wire actually existing for this deployable.
  const hasRealtimeHandlers = realtimeTypes.length > 0 && (ui.notifications?.length ?? 0) > 0;
  if (hasRealtimeHandlers) {
    out.set("src/components/RealtimeHandlers.tsx", buildRealtimeHandlers(ui, pack));
  }
  // Frontend observability: a namespaced loglevel logger + a top-level
  // error boundary.  Both are pack-agnostic shared shell files; main.tsx
  // (per pack) mounts the boundary and the api client logs through the
  // logger.  Output flows through console.* so the playground App-log
  // stream and Playwright console capture pick it up.
  out.set("src/logger.ts", renderShellFile("logger", {}, pack));
  out.set("src/ErrorBoundary.tsx", renderShellFile("error-boundary", {}, pack));
  out.set("src/lib/format.tsx", renderShellFile("format-helpers", {}, pack));
  // Frontend ACL shared utilities — pack-agnostic, emitted into every
  // React project.  `strict-field-map.ts` is type-only (zero runtime
  // cost; erased at compile time).  `apply-server-errors.ts` decodes
  // RFC 7807 ProblemDetails 422 responses into per-field RHF errors
  // via the per-action FieldMap instance the form walker passes in.
  // See docs/old/proposals/frontend-acl.md.
  out.set("src/lib/strict-field-map.ts", REACT_LIB_STRICT_FIELD_MAP_TS);
  out.set("src/lib/apply-server-errors.ts", REACT_LIB_APPLY_SERVER_ERRORS_TS);
  // Theme — every generated app gets a tasteful baseline (indigo
  // primary, medium radius, Inter font) so the bare-Mantine
  // "construction site" look is gone by default.  System-level
  // `theme { ... }` blocks override the baseline through the
  // pack's "theme" template; the generated file always exists and
  // main.tsx always wires `<MantineProvider theme={theme}>`.
  out.set("src/theme.ts", renderTheme(sys.theme, pack));
  // Vite ambient types — declares `*.css` (and other asset) modules so the
  // pack's side-effect style imports (`import "@mantine/core/styles.css"`)
  // type-check.  Required since TypeScript 6 (TS2882: side-effect imports of
  // non-code modules need a declaration); harmless on earlier versions.
  out.set("src/vite-env.d.ts", '/// <reference types="vite/client" />\n');
  out.set("src/main.tsx", renderMain(pack, routerBasename, authUi));
  // When the ui block declares an explicit `menu { … }`,
  // its derived sidebar overrides the hardcoded Aggregates /
  // Workflows / Views grouping below.  When the ui has no menu
  // block, `sidebarOverride` is `undefined` and the AppShell
  // preparer falls back to its default hardcoded shape.
  const sidebarOverride = deriveSidebarFromUi(ui, pageCtx, authUi);

  // Explicit pages with non-conventional names need
  // to register their import + route in App.tsx so React Router
  // can mount them.  Pages that override a scaffolded shape at the
  // conventional name keep the conventional path and are routed
  // by the per-aggregate / -workflow / -view loop in
  // `prepareAppShellVM`.  Pages with `layout: none` go to a
  // separate `outOfShell` channel that mounts as sibling routes
  // outside the AppShell chrome.
  const extraRouteSplit = deriveExtraRoutesFromUi(ui, options.topLevelComponents ?? [], pageCtx);
  const extraRoutes = extraRouteSplit.inShell;
  const outOfShellRoutes = extraRouteSplit.outOfShell;
  // Phase 8 step 2: walk each declared `layout <Name>` referenced by
  // a page in this ui into pre-built `NamedLayoutVM`s (slot JSX +
  // route bucket + the imports the slot JSX needs).  The shell
  // template renders one `<XLayout>` component + matching
  // `<Route element={<XLayout />}>` block per entry.
  const layoutPrep = prepareNamedLayouts(
    ui,
    sys,
    pack,
    extraRouteSplit.namedLayouts ?? new Map(),
    options.topLevelComponents ?? [],
  );
  const namedLayouts = layoutPrep.namedLayouts;
  const layoutImports = layoutPrep.extraImports;

  // App.tsx's per-aggregate / -workflow / -view route block emits
  // imports for scaffold-derived page files (`./pages/<plural>/list`,
  // etc.).  Those files exist only when the ui declared `scaffold:`
  // covering the target — explicit-page-only uis (no scaffold) would
  // otherwise produce dangling imports and duplicate identifiers
  // alongside the explicit-page extraRoutes.  Filter the lists down to
  // the targets that the ui actually scaffolded.
  const kindOf = (p: (typeof ui.pages)[number]) => classifyPage(p, pageCtx);
  const scaffoldedAggregates = aggregates.filter(({ agg }) =>
    ui.pages.some((p) => {
      const k = kindOf(p);
      return k.kind === "aggregate-list" && k.aggregateName === agg.name;
    }),
  );
  const scaffoldedWorkflows = workflows.filter(({ wf }) =>
    ui.pages.some((p) => {
      const k = kindOf(p);
      return k.kind === "workflow-form" && k.workflowName === wf.name;
    }),
  );
  const scaffoldedViews = views.filter(({ view }) =>
    ui.pages.some((p) => {
      const k = kindOf(p);
      return k.kind === "view-list" && k.viewName === view.name;
    }),
  );
  // Observable workflows (workflow-instance-visibility.md) — those whose
  // scaffold produced read-only instance pages.  A superset of the form set in
  // one direction (an event-triggered-only saga has instance pages but no
  // form), so it's derived independently.
  const observableWorkflows = workflows.filter(({ wf }) =>
    ui.pages.some((p) => {
      const k = kindOf(p);
      return k.kind === "workflow-instances-list" && k.workflowName === wf.name;
    }),
  );

  // Whether the scaffold expander synthesised a `Home` page (only
  // happens when the ui declared at least one scaffold).
  const hasScaffoldHome = ui.pages.some((p) => kindOf(p).kind === "home");
  // Same for the `ViewsIndex` / `WorkflowsIndex` singleton index pages:
  // they are only synthesised by the scaffold macro, so an explicit-page
  // ui with a view/workflow page but no scaffold has none.  The App shell
  // must then skip the `/views` (resp. `/workflows`) index import+route or
  // it dangles against a missing `./pages/views/index` module (TS2307) —
  // the per-view / per-workflow pages still mount.
  const hasViewsIndex = ui.pages.some((p) => kindOf(p).kind === "views-index");
  const hasWorkflowsIndex = ui.pages.some((p) => kindOf(p).kind === "workflows-index");

  out.set(
    "src/App.tsx",
    renderAppShell(
      scaffoldedAggregates.map((a) => a.agg),
      scaffoldedWorkflows.map((w) => w.wf),
      scaffoldedViews.map((v) => v.view),
      sys.name,
      sidebarOverride,
      extraRoutes,
      pack,
      hasScaffoldHome,
      outOfShellRoutes,
      namedLayouts,
      layoutImports,
      observableWorkflows.map((w) => w.wf),
      hasRealtimeHandlers,
      hasViewsIndex,
      hasWorkflowsIndex,
      authUi,
    ),
  );
  // Home is synthesised by the scaffold expander whenever the
  // ui declares `with scaffold(...)`.  Explicit-page-only uis
  // (no scaffold) produce no Home page and the AppShell preparer
  // skips the `/` route — the user's explicit `/`-routed page (if
  // any) takes its place.

  // `decimal.js` is conditional in the React package.json — only
  // pulled in when at least one served context uses a money field /
  // expression.  Mirrors the Hono backend's conditional dep gate.
  const usesMoney = contexts.some(contextUsesMoney) || uiUsesMoney(ui);
  // Shared `moneySchema` helper — single home for the precise-
  // decimal wire shape; every api/view/workflow module references
  // it rather than redeclaring the string-to-Decimal transform per
  // field.  Surfaces parse failures as typed Zod issues.  Emitted
  // only when something in the project uses money.
  if (usesMoney) {
    out.set("src/lib/schemas.ts", REACT_LIB_SCHEMAS_MONEY_TS);
  }
  out.set("package.json", renderShellFile("package-json", { usesMoney }, pack));
  out.set("tsconfig.json", renderShellFile("tsconfig", {}, pack));
  out.set("tsconfig.node.json", renderShellFile("tsconfig-node", {}, pack));
  out.set(
    "vite.config.ts",
    renderShellFile("vite-config", { base: viteBase, apiProxyTarget }, pack),
  );
  // Pages that use the `CodeBlock { ... }` primitive need the
  // highlight.js CDN payload injected into the shell HTML — every
  // page's CDN tags are identical, so a single per-deployable
  // detect-once / inject-once gate keeps the HTML lean when no page
  // uses code rendering.  Mirrors the `usesMoney` flag for
  // `decimal.js` in `package.json` below.
  const usesCodeBlock = uiUsesCodeBlock(ui, options.topLevelComponents ?? []);
  out.set(
    "index.html",
    renderShellFile(
      "index-html",
      { ...prepareIndexHtmlVM(sys, deployable, ui), usesCodeBlock },
      pack,
    ),
  );
  out.set("Dockerfile", renderShellFile("dockerfile", {}, pack));
  out.set(".dockerignore", renderShellFile("dockerignore", {}, pack));
  out.set("certs/.gitkeep", "");

  // Pack-specific extras — declared by the pack itself in
  // `pack.json`'s `shellFiles` and `shellGlobs` maps.  Mantine
  // ships neither (its theming is JS-only via createTheme); shadcn
  // ships `tailwind-config` / `postcss-config` / `globals-css` /
  // `lib-utils` plus the `components-ui-*` glob for its source-
  // imported component library.  Custom packs declare their own
  // file mappings here without touching this file.
  emitShellFiles(pack, out);
  emitShellGlobs(pack, out);

  // Path-prefix transform — applied once at the end so the per-page
  // emitters, pack shellFiles, shellGlobs, e2e harness, and every
  // `out.set(...)` above stay path-agnostic.  Empty prefix is a
  // no-op (default for standalone react); fullstack dotnet passes
  // `"ClientApp/"` to land the project under the .NET project's
  // ClientApp/ directory.
  const pathPrefix = options.pathPrefix ?? "";
  if (pathPrefix === "") return out;
  const prefixed = new Map<string, string>();
  for (const [path, content] of out) {
    prefixed.set(`${pathPrefix}${path}`, content);
  }
  return prefixed;
}

// ---------------------------------------------------------------------------
// index.html shell — page metadata + favicon projection.
//
// Picks the route-`/` page (or the first page when no `/` page is
// declared) as the source of static SEO metadata.  Falls back to the
// deployable's own name when the chosen page declares no title.
//
// The favicon path on the deployable is platform-neutral text — the
// generator emits the path verbatim into `<link rel="icon" href="…">`.
// Users are responsible for placing the referenced file at the URL
// (typically by dropping it under `public/`).
// ---------------------------------------------------------------------------

interface IndexHtmlVM {
  title: string;
  description?: string;
  ogImage?: string;
  canonical?: string;
  favicon?: string;
}

function prepareIndexHtmlVM(
  // Reserved for a future "system-level title fallback" when no page
  // declares a static title (the system name becomes the html title).
  // Today the deployable-name fallback below is enough; underscore-
  // prefix signals intentional unused.
  _sys: SystemIR,
  deployable: DeployableIR,
  ui: UiIR,
): IndexHtmlVM {
  const page = pickMetadataPage(ui.pages);
  const title = staticTitleOf(page) ?? deployable.name;
  const metadata = page?.metadata;
  return {
    title,
    description: metadata?.description,
    ogImage: metadata?.ogImage,
    canonical: metadata?.canonical,
    favicon: deployable.favicon,
  };
}

/** Pick the page whose metadata projects into the shell.  The
 *  route-`/` page wins when one exists (it's what the user lands on
 *  cold); otherwise the first declared page is the natural pick (the
 *  scaffold-synthesised `Home` page lives there for scaffolded
 *  UIs).  Returns undefined when the ui has no pages — index.html
 *  then falls back to deployable-name title with no meta tags. */
function pickMetadataPage(pages: PageIR[]): PageIR | undefined {
  return pages.find((p) => p.route === "/") ?? pages[0];
}

/** Extract a string title from a page's title expression, when the
 *  expression is a plain string literal.  Pages that interpolate
 *  state/params into their title (e.g. `title: "Order " + id`) get
 *  no static title — the shell falls back to the deployable name. */
function staticTitleOf(page: PageIR | undefined): string | undefined {
  if (!page) return undefined;
  const t = page.title;
  if (!t) return undefined;
  if (t.kind === "literal" && t.lit === "string") return t.value;
  return undefined;
}

// smokeSpec moved to src/generator/_frontend/smoke-spec.ts (shared
// with the Svelte + Vue frontends — it drives routes, not framework code).
