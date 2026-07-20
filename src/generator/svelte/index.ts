import {
  type AggregateIR,
  type BoundedContextIR,
  contextUsesMoney,
  type DeployableIR,
  type EnrichedAggregateIR,
  type EnrichedBoundedContextIR,
  type SystemIR,
  uiUsesMoney,
} from "../../ir/types/loom-ir.js";
import { backendServesRealtime, realtimeEventTypes } from "../../ir/util/channels.js";
import { classifyPage, type PageNameCtx } from "../../ir/util/page-kind.js";
import { API_BASE_PATH } from "../../util/api-base.js";
import { humanize, lowerFirst } from "../../util/naming.js";
import { AUTH_GATE_SVELTE, AUTH_SESSION_TS } from "../_frontend/auth-ui.js";
import {
  E2E_FIXTURES_TS,
  E2E_PACKAGE_JSON_SVELTE,
  E2E_TSCONFIG_JSON,
  PLAYWRIGHT_CONFIG_TS,
} from "../_frontend/e2e-harness.js";
import { deriveSidebarFromUi } from "../_frontend/menu-emitter.js";
import { renderRealtimeClient } from "../_frontend/realtime.js";
import { smokeSpec } from "../_frontend/smoke-spec.js";
import { buildTableSortHelper } from "../_frontend/table-sort-helper.js";
import type { LoadedPack } from "../_packs/loader.js";
import { loadPack, resolvePackDir } from "../_packs/loader-fs.js";
import { buildSvelteApiModule } from "./api-builder.js";
import {
  SVELTE_APP_DTS,
  SVELTE_LAYOUT_TS,
  SVELTE_LIB_FORMS,
  SVELTE_LIB_SCHEMAS_MONEY,
  SVELTE_LIB_TOAST,
} from "./emit-templates.js";
import { emitSvelteNamedLayouts } from "./layouts-emitter.js";
import { buildSvelteRealtimeHandlers } from "./realtime-handlers-builder.js";
import {
  defaultNavSections,
  emitSveltePageObjectsForUi,
  emitSveltePagesForUi,
} from "./routes-emitter.js";
import { renderSvelteStoreModule, storeModulePath } from "./store-builder.js";
import { allViews, buildViewsApiModule, hasAnyView } from "./view-builder.js";
import { allWorkflows, buildWorkflowsApiModule, hasAnyWorkflow } from "./workflow-builder.js";

// ---------------------------------------------------------------------------
// Svelte 5 + SvelteKit (static SPA) + svelte-query + Zod generator.
//
// Emits one SvelteKit project per svelte-platform deployable: an
// adapter-static SPA (ssr off, index.html fallback) served with
// `vite preview`, calling the target backend's HTTP API.  Pages flow
// through the SAME shared markup walker the React generator uses
// (src/generator/_walker/walker-core.ts) with `svelteTarget` +
// a svelte-format design pack supplying the framework surface.
//
// See docs/old/plans/svelte-frontend-plan.md.
// ---------------------------------------------------------------------------

export interface GenerateSvelteOptions {
  /** Overrides the computed `http://localhost:<port>` API target —
   *  fullstack hosts pass `"/api"` for same-origin fetches. */
  apiBaseUrl?: string;
  /** Prepended to every emitted path — the dotnet fullstack embed
   *  passes `"ClientApp/"` so the SvelteKit project lands inside the
   *  host project's tree.  Mirrors GenerateReactOptions.pathPrefix. */
  pathPrefix?: string;
  /** Sub-path the built bundle is served under (Phoenix `/app`) — sets
   *  SvelteKit's `kit.paths.base`, which base-prefixes asset URLs and
   *  base-aware links automatically.  Unset for root-served hosts
   *  (dotnet/java wwwroot, standalone) → byte-identical. */
  basePath?: string;
  topLevelComponents?: import("../../ir/types/loom-ir.js").ComponentIR[];
  /** Generate-time source-map recorder (`--sourcemap`) — see
   *  `PlatformSurface.emitProject`'s doc comment.  Forwarded into the
   *  shared page-emit context so pages/components record whole-file
   *  regions alongside their `out.set(...)`. */
  sourcemap?: import("../_trace/sourcemap.js").SourceMapRecorder;
}

export function generateSvelteForContexts(
  contexts: EnrichedBoundedContextIR[],
  sys: SystemIR,
  deployable: DeployableIR,
  options: GenerateSvelteOptions = {},
): Map<string, string> {
  const out = new Map<string, string>();

  const target = sys.deployables.find((d) => d.name === deployable.targetName);
  // Same-origin relative `/api` base; `vite dev` proxies it to the
  // target backend, docker-compose overrides via `VITE_API_BASE_URL`.
  const apiBaseUrl = options.apiBaseUrl ?? API_BASE_PATH;
  const apiProxyTarget = `http://localhost:${target?.port ?? 8080}`;
  const base = options.basePath || undefined;

  const aggregates: Array<{ agg: EnrichedAggregateIR; ctx: EnrichedBoundedContextIR }> = [];
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) aggregates.push({ agg, ctx });
  }
  const aggregatesByName = new Map<string, AggregateIR>();
  for (const { agg } of aggregates) aggregatesByName.set(agg.name, agg);
  // Name-context for `classifyPage` / `pageEmitName` (slice 3c — replaces the
  // stamped page origin).  Derived once from the served contexts.
  const pageCtx: PageNameCtx = {
    aggregateNames: contexts.flatMap((c) => c.aggregates.map((a) => a.name)),
    workflowNames: contexts.flatMap((c) => c.workflows.map((w) => w.name)),
    viewNames: contexts.flatMap((c) => c.views.map((v) => v.name)),
  };

  const design = deployable.design ?? "shadcnSvelte@v1";
  const pack = loadPack(resolvePackDir(design));

  if (!deployable.uiName) {
    throw new Error(
      `Svelte deployable '${deployable.name}' has no 'ui:' binding. The validator should have caught this; an upstream pipeline (programmatic IR construction?) skipped the AST validator.`,
    );
  }
  const ui = sys.uis.find((u) => u.name === deployable.uiName);
  if (!ui) {
    throw new Error(
      `Svelte deployable '${deployable.name}' references ui '${deployable.uiName}' but no such ui is declared in the system.`,
    );
  }

  // Per-aggregate api modules.
  for (const { agg, ctx } of aggregates) {
    const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
    out.set(`src/lib/api/${lowerFirst(agg.name)}.ts`, buildSvelteApiModule(agg, repo, ctx));
  }
  if (hasAnyWorkflow(contexts)) {
    out.set("src/lib/api/workflows.ts", buildWorkflowsApiModule(contexts));
  }
  if (hasAnyView(contexts)) {
    out.set("src/lib/api/views.ts", buildViewsApiModule(contexts));
  }

  // Pages + components through the shared walker.
  const contextsByName = new Map<string, BoundedContextIR>();
  for (const ctx of contexts) contextsByName.set(ctx.name, ctx);
  // Frontend auth guard (D-AUTH-OIDC, `auth: ui`): this svelte deployable opts
  // in AND its target backend enforces auth, so `useSession()` + the verified
  // claims are available — gates `page { requires … }` rendering below.
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
  for (const [path, content] of emitSveltePagesForUi(ui, emitCtx)) out.set(path, content);
  for (const [path, content] of emitSveltePageObjectsForUi(ui, emitCtx)) out.set(path, content);

  // Store modules (named-actions-and-stores.md §3, Stage 5) — one Svelte 5
  // runes (`$state`) module singleton per `store Cart { … }` at
  // `src/lib/stores/<snake>.svelte.ts`.  Page/component shells import the store
  // object + actions and bind `$derived` per used field (see page-shell's
  // `renderStoreWiring`).
  for (const store of ui.stores) {
    out.set(storeModulePath(store.name), renderSvelteStoreModule(store));
  }

  // Named layouts (`layout <Name> { … }`) → a `(<name>)/+layout.svelte`
  // route group whose pages route in via groupForLayout.  No-op when no
  // page selects a named layout (the default (app) chrome is untouched).
  const bcByAggregate = new Map<string, BoundedContextIR>();
  for (const c of contexts) {
    for (const agg of c.aggregates) bcByAggregate.set(agg.name, c);
  }
  for (const [path, content] of emitSvelteNamedLayouts({
    ui,
    sys,
    pack,
    aggregatesByName,
    bcByAggregate,
    topLevelComponents: options.topLevelComponents ?? [],
  })) {
    out.set(path, content);
  }

  // Playwright e2e harness — same testid-keyed page-object surface
  // the react projects ship; the ui-e2e spec renderer (system layer)
  // adds the per-system `<sys>.ui.spec.ts` next to these.
  out.set("e2e/smoke.spec.ts", smokeSpec(ui, pageCtx));
  out.set("e2e/fixtures.ts", E2E_FIXTURES_TS);
  out.set("e2e/playwright.config.ts", PLAYWRIGHT_CONFIG_TS);
  out.set("e2e/package.json", E2E_PACKAGE_JSON_SVELTE);
  out.set("e2e/tsconfig.json", E2E_TSCONFIG_JSON);

  // `authUi` computed above (before page emission, which consumes it for the
  // `page { requires … }` gate).  Drives the session client + route guard emits.

  // Shared lib surface.
  const hasDelete = aggregates.some((a) => !!a.agg.canonicalDestroy);
  out.set("src/lib/api/client.ts", pack.render("api-client", { hasDelete, hasAuthUi: authUi }));
  if (authUi) {
    out.set("src/lib/auth/session.ts", AUTH_SESSION_TS);
    out.set("src/lib/auth/AuthGate.svelte", AUTH_GATE_SVELTE);
  }
  out.set("src/lib/api/config.ts", pack.render("api-config", { apiBaseUrl }));
  out.set("src/lib/logger.ts", pack.render("logger", {}));
  out.set("src/lib/format.ts", pack.render("format-helpers", {}));
  // Interactive-table sort helper (M-T1.1) — imported by a page only when it
  // renders a sortable `Table`; emitted unconditionally (like format.ts).
  out.set("src/lib/table-sort.ts", buildTableSortHelper());
  out.set("src/lib/forms.svelte.ts", SVELTE_LIB_FORMS);
  out.set("src/lib/toast.svelte.ts", SVELTE_LIB_TOAST);
  // Realtime SSE client + live-event handlers (channels.md Part I):
  // mirrors the react wiring — the client emits when the targeted
  // backend exposes the realtime wire (Hono is the only backend
  // serving GET /realtime/events so far); the handlers component
  // emits when the ui declares `on <channel>.<Event>` members, and
  // the root layout mounts it (hasRealtimeHandlers below).
  const realtimeTypes = backendServesRealtime(target?.platform)
    ? [...new Set(contexts.flatMap((c) => [...realtimeEventTypes(c)]))].sort()
    : [];
  if (realtimeTypes.length > 0) {
    out.set("src/lib/api/realtime.ts", renderRealtimeClient(realtimeTypes, "API_BASE_URL"));
  }
  const hasRealtimeHandlers = realtimeTypes.length > 0 && (ui.notifications?.length ?? 0) > 0;
  if (hasRealtimeHandlers) {
    out.set("src/lib/components/RealtimeHandlers.svelte", buildSvelteRealtimeHandlers(ui, pack));
  }
  const usesMoney = contexts.some(contextUsesMoney) || uiUsesMoney(ui);
  if (usesMoney) {
    out.set("src/lib/schemas.ts", SVELTE_LIB_SCHEMAS_MONEY);
  }

  // App shell — the chrome group's layout, driven by the same nav
  // derivation rules as the react AppShell (explicit ui.menu wins;
  // default grouping otherwise).
  // `authUi` enables per-link gating: `deriveSidebarFromUi` renders a
  // `requiresJs` condition on any nav entry whose linked page declares a
  // `requires` gate, so the app-shell can hide a forbidden page's link.
  const workflows = allWorkflows(contexts);
  const views = allViews(contexts);
  const kindOf = (p: (typeof ui.pages)[number]) => classifyPage(p, pageCtx);
  const sidebarOverride = deriveSidebarFromUi(ui, pageCtx, authUi);
  const scaffoldedAggregates = aggregates
    .filter(({ agg }) =>
      ui.pages.some((p) => {
        const k = kindOf(p);
        return k.kind === "aggregate-list" && k.aggregateName === agg.name;
      }),
    )
    .map((a) => a.agg);
  const scaffoldedWorkflows = workflows
    .filter(({ wf }) =>
      ui.pages.some((p) => {
        const k = kindOf(p);
        return k.kind === "workflow-form" && k.workflowName === wf.name;
      }),
    )
    .map((w) => w.wf);
  const scaffoldedViewNames = views
    .filter(({ view }) =>
      ui.pages.some((p) => {
        const k = kindOf(p);
        return k.kind === "view-list" && k.viewName === view.name;
      }),
    )
    .map((v) => v.view.name);
  const hasWorkflowsIndex = ui.pages.some((p) => kindOf(p).kind === "workflows-index");
  const hasViewsIndex = ui.pages.some((p) => kindOf(p).kind === "views-index");
  const navSections =
    sidebarOverride?.map((s) => ({
      label: s.label,
      entries: s.entries.map((e) => ({
        to: e.to,
        label: e.label,
        testId: e.testId,
        // Per-link gate condition (auth: ui) — the app-shell `{#if}`-hides a
        // forbidden page's link.  Absent ⇒ link always shown.
        requiresJs: e.requiresJs,
      })),
    })) ??
    defaultNavSections(
      scaffoldedAggregates,
      scaffoldedWorkflows,
      scaffoldedViewNames,
      hasWorkflowsIndex,
      hasViewsIndex,
    );
  // Bind the session user in the app-shell only when a nav entry is actually
  // gated — an unused binding would be a svelte-check error.
  const navUsesSession = navSections.some(
    (s) => "entries" in s && s.entries.some((e) => "requiresJs" in e && !!e.requiresJs),
  );
  out.set(
    "src/routes/(app)/+layout.svelte",
    pack.render("app-shell", {
      systemNameHuman: humanize(sys.name),
      navSections,
      hasNav: navSections.length > 0,
      navUsesSession,
    }),
  );
  out.set("src/routes/+layout.svelte", pack.render("root-layout", { hasRealtimeHandlers, authUi }));
  out.set("src/routes/+layout.ts", SVELTE_LAYOUT_TS);

  // Project shell.
  out.set("src/app.html", pack.render("main", { title: humanize(sys.name) }));
  out.set("src/app.d.ts", SVELTE_APP_DTS);
  out.set("src/theme.css", pack.render("theme", themeVM(sys)));
  out.set("package.json", pack.render("package-json", { usesMoney }));
  out.set("tsconfig.json", pack.render("tsconfig", {}));
  out.set("svelte.config.js", pack.render("svelte-config", { base }));
  out.set("vite.config.ts", pack.render("vite-config", { apiProxyTarget }));
  out.set("Dockerfile", pack.render("dockerfile", {}));
  out.set(".dockerignore", pack.render("dockerignore", {}));
  out.set("certs/.gitkeep", "");

  emitShellFiles(pack, out);
  emitShellGlobs(pack, out);

  // Path-prefix transform — applied once at the end so every emitter
  // above stays path-agnostic (same shape as the react generator's).
  const pathPrefix = options.pathPrefix ?? "";
  if (pathPrefix === "") return out;
  const prefixed = new Map<string, string>();
  for (const [path, content] of out) {
    prefixed.set(`${pathPrefix}${path}`, content);
  }
  return prefixed;
}

/** Theme tokens for the pack's `theme` template (CSS custom props).
 *  System-level `theme { … }` blocks override the tasteful baseline
 *  (indigo primary, medium radius, Inter) — same defaults as the
 *  react packs' renderTheme. */
function themeVM(sys: SystemIR): Record<string, string> {
  const t = sys.theme;
  return {
    primary: t?.primary ?? "#4f46e5",
    neutral: t?.neutral ?? "#6b7280",
    error: t?.error ?? "#dc2626",
    radius: t?.radius ?? "md",
    fontFamily: t?.fontFamily ?? "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
    fontFamilyMono: t?.fontFamilyMono ?? "ui-monospace, SFMono-Regular, Menlo, monospace",
  };
}

/** Emit pack-declared `shellFiles` (logical template → output path). */
function emitShellFiles(pack: LoadedPack, out: Map<string, string>): void {
  for (const [name, path] of Object.entries(pack.manifest.shellFiles ?? {})) {
    out.set(path, pack.render(name, {}));
  }
}

/** Emit pack-declared `shellGlobs` (`prefix-*` → path with `{1}`). */
function emitShellGlobs(pack: LoadedPack, out: Map<string, string>): void {
  for (const [globKey, pathTemplate] of Object.entries(pack.manifest.shellGlobs ?? {})) {
    if (!globKey.endsWith("-*")) continue;
    const prefix = globKey.slice(0, -1); // keep trailing '-'
    for (const name of pack.templates.keys()) {
      if (!name.startsWith(prefix)) continue;
      const wildcard = name.slice(prefix.length);
      out.set(pathTemplate.replace("{1}", wildcard), pack.render(name, {}));
    }
  }
}
