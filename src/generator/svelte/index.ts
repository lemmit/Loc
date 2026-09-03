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
import { uiUsesChart } from "../../ir/util/chart.js";
import { classifyPage, type PageNameCtx } from "../../ir/util/page-kind.js";
import { contextsHaveProvenancedField } from "../../ir/util/prov-id.js";
import { realtimeStreamCredential } from "../../ir/util/realtime-rooms.js";
import { API_BASE_PATH } from "../../util/api-base.js";
import { humanize, lowerFirst } from "../../util/naming.js";
import { AUTH_GATE_SVELTE, AUTH_SESSION_TS } from "../_frontend/auth-ui.js";
import {
  E2E_FIXTURES_TS,
  E2E_PACKAGE_JSON_SVELTE,
  E2E_TSCONFIG_JSON,
  PLAYWRIGHT_CONFIG_TS,
} from "../_frontend/e2e-harness.js";
// The i18n translation runtime (M-T1.11) is framework-AGNOSTIC — `t(key,
// default, values?)` over `./locales/en.json` with `{name}` substitution — so
// the Svelte generator reuses the React module verbatim (same sharing pattern
// as Vue).  Runtime files land under `src/lib/` and the body-walker seam's
// `../i18n` import is rewritten to the depth-agnostic `$lib/i18n` specifier.
import { renderI18nModule, renderLocaleCatalog } from "../_frontend/i18n-runtime.js";
import { LIB_SCHEMAS_PROV_TS, PROV_LINEAGE_SCHEMA_BLOCK } from "../_frontend/lib-schemas.js";
import { deriveSidebarFromUi } from "../_frontend/menu-emitter.js";
import { MONEY_TEXT_SOURCE } from "../_frontend/money-format.js";
import { JSX_NAV_LABELS, withNavLabelTokens } from "../_frontend/nav-labels.js";
import { buildProjectionsApiModule, readableProjections } from "../_frontend/projections-module.js";
import { renderRealtimeClient } from "../_frontend/realtime.js";
import {
  jsxChromeAttr as shellChromeAttr,
  jsxChromeText as shellChromeText,
} from "../_frontend/shell-chrome.js";
import { smokeSpec } from "../_frontend/smoke-spec.js";
import { buildTableSortHelper } from "../_frontend/table-sort-helper.js";
import type { LoadedPack } from "../_packs/loader.js";
import { loadPack, resolvePackDir } from "../_packs/loader-fs.js";
import { packChromeCatalog } from "../_packs/pack-chrome.js";
import { collectUiMessages } from "../_walker/i18n-extract.js";
import { buildSvelteApiModule } from "./api-builder.js";
import { renderSvelteChartRuntime } from "./chart-runtime.js";
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
  // Name-context for `classifyPage` / `pageEmitName` (replaces the
  // stamped page origin).  Derived once from the served contexts.
  const pageCtx: PageNameCtx = {
    aggregateNames: contexts.flatMap((c) => c.aggregates.map((a) => a.name)),
    workflowNames: contexts.flatMap((c) => c.workflows.map((w) => w.name)),
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

  // i18n (M-T1.11 Svelte runtime — the React runtime ported to Svelte): when
  // this UI has extractable user-visible strings, page/component bodies emit
  // `{t("<key>", "<default>")}` for literal text slots (keyed identically to the
  // catalog via the SHARED walker seam) and the app ships a `src/lib/i18n.ts`
  // shim + `src/lib/locales/en.json`.  The seam's `../i18n` import rewrites to
  // `$lib/i18n` (see `svelteImportPath`), so it resolves from any route depth.
  // Empty catalog → no runtime, walk sites pass `undefined` and output stays
  // byte-identical to pre-i18n.
  const i18nEnabled = collectUiMessages(ui).length > 0;
  // Pack-DECLARED chrome rides the SAME already-enabled gate (see the React
  // generator for the rationale) — never flips the runtime on by itself.
  pack.setChromeI18n(i18nEnabled);
  if (i18nEnabled) {
    out.set("src/lib/locales/en.json", renderLocaleCatalog(ui, packChromeCatalog(pack.manifest)));
    out.set("src/lib/i18n.ts", renderI18nModule());
  }

  // Per-aggregate api modules.
  for (const { agg, ctx } of aggregates) {
    const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
    out.set(`src/lib/api/${lowerFirst(agg.name)}.ts`, buildSvelteApiModule(agg, repo, ctx));
  }
  if (hasAnyWorkflow(contexts)) {
    out.set("src/lib/api/workflows.ts", buildWorkflowsApiModule(contexts));
  }

  // Query-time projection clients (M-T1.3) — the SHARED builder React
  // and Vue use, driven by the svelte-query leaves (PR #2366's decision: reuse
  // while the divergence is leaf-shaped).  `createQuery` + the thunked options
  // object + `../schemas` (this module lives at `src/lib/api/`, one hop below
  // `src/lib/schemas.ts`, where React/Vue are two below `src/api/`).  Emitted
  // only when the deployable actually serves a readable projection, so a
  // projection-free app stays byte-identical.
  if (readableProjections(contexts).length > 0) {
    out.set(
      "src/lib/api/projections.ts",
      buildProjectionsApiModule(contexts, {
        queryPackage: "@tanstack/svelte-query",
        queryFactory: "createQuery",
        thunkOptions: true,
        schemasImport: "../schemas",
      }),
    );
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
    // i18n key prefix is emitted per page/component only when the UI has
    // extractable strings (byte-identical to pre-i18n otherwise).
    i18nEnabled,
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
  out.set("src/lib/format.ts", pack.render("format-helpers", { moneySource: MONEY_TEXT_SOURCE }));
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
    out.set(
      "src/lib/api/realtime.ts",
      // Stream credential from the shared realtime plan (M-T4.12 RULE 2) — the
      // SAME `auth: ui` / `auth: required` gate the api client's
      // `credentials: "include"` rides, so the SSE stream authenticates exactly
      // like an ordinary API call instead of 401-ing on an authenticated deployable.
      renderRealtimeClient(
        realtimeTypes,
        "API_BASE_URL",
        realtimeStreamCredential(deployable, target, sys.user),
      ),
    );
  }
  const hasRealtimeHandlers = realtimeTypes.length > 0 && (ui.notifications?.length ?? 0) > 0;
  if (hasRealtimeHandlers) {
    out.set("src/lib/components/RealtimeHandlers.svelte", buildSvelteRealtimeHandlers(ui, pack));
  }
  // The chart component — emitted only when a page actually charts, the same
  // use-driven rule every sibling leg applies.
  if (uiUsesChart(ui)) {
    out.set("src/lib/components/LoomChart.svelte", renderSvelteChartRuntime());
  }
  const usesMoney = contexts.some(contextUsesMoney) || uiUsesMoney(ui);
  // Provenance surfaces the co-located lineage sibling on the wire so the
  // scaffold's `ProvenanceInfo` "?" disclosure has a typed lineage to read
  // (mirrors React/Vue).  The lineage carrier is framework-neutral zod.
  const usesProvenance = contextsHaveProvenancedField(contexts);
  if (usesMoney || usesProvenance) {
    let schemas = usesMoney ? SVELTE_LIB_SCHEMAS_MONEY : "";
    if (usesProvenance) {
      schemas = usesMoney ? `${schemas}\n${PROV_LINEAGE_SCHEMA_BLOCK}` : LIB_SCHEMAS_PROV_TS;
    }
    out.set("src/lib/schemas.ts", schemas);
  }

  // App shell — the chrome group's layout, driven by the same nav
  // derivation rules as the react AppShell (explicit ui.menu wins;
  // default grouping otherwise).
  // `authUi` enables per-link gating: `deriveSidebarFromUi` renders a
  // `requiresJs` condition on any nav entry whose linked page declares a
  // `requires` gate, so the app-shell can hide a forbidden page's link.
  const workflows = allWorkflows(contexts);
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
  const hasWorkflowsIndex = ui.pages.some((p) => kindOf(p).kind === "workflows-index");
  const navSections =
    sidebarOverride?.map((s) => ({
      label: s.label,
      labelKey: s.labelKey,
      entries: s.entries.map((e) => ({
        to: e.to,
        label: e.label,
        labelKey: e.labelKey,
        testId: e.testId,
        // Per-link gate condition (auth: ui) — the app-shell `{#if}`-hides a
        // forbidden page's link.  Absent ⇒ link always shown.
        requiresJs: e.requiresJs,
      })),
    })) ??
    defaultNavSections(
      scaffoldedAggregates,
      scaffoldedWorkflows,
      hasWorkflowsIndex,
      ui.pages,
      authUi,
    );
  // Bind the session user in the app-shell only when a nav entry is actually
  // gated — an unused binding would be a svelte-check error.
  const navUsesSession = navSections.some(
    (s) => "entries" in s && s.entries.some((e) => "requiresJs" in e && !!e.requiresJs),
  );
  // Nav labels → JSX-spelled tokens (Svelte shares JSX's single braces), so the
  // `menu.*` catalog keys the extractor writes finally render (A13b).  Escaped
  // raw string when i18n is off / the label has no key — byte-identical.
  const navSectionsVM = withNavLabelTokens(navSections, i18nEnabled ? JSX_NAV_LABELS : undefined);
  out.set(
    "src/routes/(app)/+layout.svelte",
    pack.render("app-shell", {
      systemNameHuman: humanize(sys.name),
      navSections: navSectionsVM,
      hasNav: navSections.length > 0,
      navUsesSession,
      // Pack-chrome (M-T1.11): raw source string when i18n is off (byte-identical
      // to the pre-i18n shell), else a Svelte `{t("chrome.skipToContent", "…")}`
      // interpolation keyed to `APP_SHELL_CHROME`; the gated `t` import rides the
      // `i18nEnabled` flag through the template's `<script>` block.
      i18nEnabled,
      skipToContentText: shellChromeText("skipToContent", i18nEnabled),
      primaryNavAria: shellChromeAttr("aria-label", "primaryNav", i18nEnabled),
      // The mobile nav toggle's aria — "Toggle navigation" on both Svelte packs
      // (flowbite, shadcnSvelte).  Neither Svelte pack renders an error boundary
      // heading, so `chrome.somethingWentWrong` has no Svelte token.
      toggleNavAria: shellChromeAttr("aria-label", "toggleNavigation", i18nEnabled),
    }),
  );
  out.set(
    "src/routes/+layout.svelte",
    pack.render("root-layout", {
      hasRealtimeHandlers,
      authUi,
      // Root render-time error boundary (M-T1.8) — its heading is pack chrome,
      // keyed `chrome.rootErrorTitle` exactly like React's `src/ErrorBoundary.tsx`
      // (Svelte shares JSX's single-brace interpolation, so the same token
      // renders); raw string when i18n is off, so that output is unchanged.
      i18nEnabled,
      errorTitleText: shellChromeText("rootErrorTitle", i18nEnabled),
    }),
  );
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
