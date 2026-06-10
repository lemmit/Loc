import {
  type AggregateIR,
  type BoundedContextIR,
  contextUsesMoney,
  type DeployableIR,
  type EnrichedAggregateIR,
  type EnrichedBoundedContextIR,
  type SystemIR,
} from "../../ir/types/loom-ir.js";
import { humanize, lowerFirst } from "../../util/naming.js";
import {
  E2E_FIXTURES_TS,
  E2E_PACKAGE_JSON,
  E2E_TSCONFIG_JSON,
  PLAYWRIGHT_CONFIG_TS,
} from "../_frontend/e2e-harness.js";
import { deriveSidebarFromUi } from "../_frontend/menu-emitter.js";
import { smokeSpec } from "../_frontend/smoke-spec.js";
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
import {
  defaultNavSections,
  emitSveltePageObjectsForUi,
  emitSveltePagesForUi,
} from "./routes-emitter.js";
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
// See docs/plans/svelte-frontend-plan.md.
// ---------------------------------------------------------------------------

export interface GenerateSvelteOptions {
  /** Overrides the computed `http://localhost:<port>` API target —
   *  fullstack hosts pass `"/api"` for same-origin fetches. */
  apiBaseUrl?: string;
  /** Prepended to every emitted path — the dotnet fullstack embed
   *  passes `"ClientApp/"` so the SvelteKit project lands inside the
   *  host project's tree.  Mirrors GenerateReactOptions.pathPrefix. */
  pathPrefix?: string;
  topLevelComponents?: import("../../ir/types/loom-ir.js").ComponentIR[];
}

export function generateSvelteForContexts(
  contexts: EnrichedBoundedContextIR[],
  sys: SystemIR,
  deployable: DeployableIR,
  options: GenerateSvelteOptions = {},
): Map<string, string> {
  const out = new Map<string, string>();

  const target = sys.deployables.find((d) => d.name === deployable.targetName);
  const apiBaseUrl = options.apiBaseUrl ?? `http://localhost:${target?.port ?? 8080}`;

  const aggregates: Array<{ agg: EnrichedAggregateIR; ctx: EnrichedBoundedContextIR }> = [];
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) aggregates.push({ agg, ctx });
  }
  const aggregatesByName = new Map<string, AggregateIR>();
  for (const { agg } of aggregates) aggregatesByName.set(agg.name, agg);

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
  const emitCtx = {
    sys,
    deployable,
    aggregatesByName,
    contextsByName,
    pack,
    topLevelComponents: options.topLevelComponents ?? [],
  };
  for (const [path, content] of emitSveltePagesForUi(ui, emitCtx)) out.set(path, content);
  for (const [path, content] of emitSveltePageObjectsForUi(ui, emitCtx)) out.set(path, content);

  // Playwright e2e harness — same testid-keyed page-object surface
  // the react projects ship; the ui-e2e spec renderer (system layer)
  // adds the per-system `<sys>.ui.spec.ts` next to these.
  out.set("e2e/smoke.spec.ts", smokeSpec(ui));
  out.set("e2e/fixtures.ts", E2E_FIXTURES_TS);
  out.set("e2e/playwright.config.ts", PLAYWRIGHT_CONFIG_TS);
  out.set("e2e/package.json", E2E_PACKAGE_JSON);
  out.set("e2e/tsconfig.json", E2E_TSCONFIG_JSON);

  // Shared lib surface.
  const hasDelete = aggregates.some((a) => !!a.agg.canonicalDestroy);
  out.set("src/lib/api/client.ts", pack.render("api-client", { hasDelete }));
  out.set("src/lib/api/config.ts", pack.render("api-config", { apiBaseUrl }));
  out.set("src/lib/logger.ts", pack.render("logger", {}));
  out.set("src/lib/format.ts", pack.render("format-helpers", {}));
  out.set("src/lib/forms.svelte.ts", SVELTE_LIB_FORMS);
  out.set("src/lib/toast.svelte.ts", SVELTE_LIB_TOAST);
  const usesMoney = contexts.some(contextUsesMoney);
  if (usesMoney) {
    out.set("src/lib/schemas.ts", SVELTE_LIB_SCHEMAS_MONEY);
  }

  // App shell — the chrome group's layout, driven by the same nav
  // derivation rules as the react AppShell (explicit ui.menu wins;
  // default grouping otherwise).
  const sidebarOverride = deriveSidebarFromUi(ui);
  const scaffoldedAggregates = aggregates
    .filter(({ agg }) =>
      ui.pages.some(
        (p) => p.origin?.kind === "aggregate-list" && p.origin.aggregateName === agg.name,
      ),
    )
    .map((a) => a.agg);
  const workflows = allWorkflows(contexts);
  const views = allViews(contexts);
  const scaffoldedWorkflows = workflows
    .filter(({ wf }) =>
      ui.pages.some((p) => p.origin?.kind === "workflow-form" && p.origin.workflowName === wf.name),
    )
    .map((w) => w.wf);
  const scaffoldedViewNames = views
    .filter(({ view }) =>
      ui.pages.some((p) => p.origin?.kind === "view-list" && p.origin.viewName === view.name),
    )
    .map((v) => v.view.name);
  const hasWorkflowsIndex = ui.pages.some((p) => p.origin?.kind === "workflows-index");
  const hasViewsIndex = ui.pages.some((p) => p.origin?.kind === "views-index");
  const navSections =
    sidebarOverride?.map((s) => ({
      label: s.label,
      entries: s.entries.map((e) => ({ to: e.to, label: e.label, testId: e.testId })),
    })) ??
    defaultNavSections(
      scaffoldedAggregates,
      scaffoldedWorkflows,
      scaffoldedViewNames,
      hasWorkflowsIndex,
      hasViewsIndex,
    );
  out.set(
    "src/routes/(app)/+layout.svelte",
    pack.render("app-shell", {
      systemNameHuman: humanize(sys.name),
      navSections,
      hasNav: navSections.length > 0,
    }),
  );
  out.set("src/routes/+layout.svelte", pack.render("root-layout", {}));
  out.set("src/routes/+layout.ts", SVELTE_LAYOUT_TS);

  // Project shell.
  out.set("src/app.html", pack.render("main", { title: humanize(sys.name) }));
  out.set("src/app.d.ts", SVELTE_APP_DTS);
  out.set("src/theme.css", pack.render("theme", themeVM(sys)));
  out.set("package.json", pack.render("package-json", { usesMoney }));
  out.set("tsconfig.json", pack.render("tsconfig", {}));
  out.set("svelte.config.js", pack.render("svelte-config", {}));
  out.set("vite.config.ts", pack.render("vite-config", {}));
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
