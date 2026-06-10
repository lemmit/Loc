import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  PageIR,
  SystemIR,
  UiIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { contextUsesMoney } from "../../ir/types/loom-ir.js";
import { humanize, plural, snake, upperFirst } from "../../util/naming.js";
import { buildApiModule } from "../_frontend/api-module.js";
import type { LoadedPack } from "../_packs/loader.js";
import { loadPack, resolvePackDir } from "../_packs/loader-fs.js";
import { walkBody } from "../_walker/walker-core.js";
// Framework-neutral TS constant (zod moneySchema over decimal.js) that
// happens to live with the React emit templates; shared the same way
// the elixir theme-emit shares `prepareThemeVM`.  Candidate for a
// later move into `_frontend/`.
import { REACT_LIB_SCHEMAS_MONEY_TS } from "../react/emit-templates.js";
import { prepareThemeVM } from "../react/templating/preparers/theme.js";
import { renderVuePage } from "./walker/page-shell.js";
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

export function generateVueForContexts(
  contexts: EnrichedBoundedContextIR[],
  sys: SystemIR,
  deployable: DeployableIR,
): Map<string, string> {
  const out = new Map<string, string>();

  const target = sys.deployables.find((d) => d.name === deployable.targetName);
  const apiBaseUrl = `http://localhost:${target?.port ?? 8080}`;

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
  for (const page of pages) {
    if (!page.body) {
      out.set(pagePath(page), renderPageStub(page));
      continue;
    }
    const paramNames = new Set(page.params.map((p) => p.name));
    const stateNames = new Set(page.state.map((s) => s.name));
    const result = walkBody(
      page.body,
      vueTarget,
      pack,
      paramNames,
      stateNames,
      new Map(), // user components — vue support lands with the parity slice
      ui.apiParams,
      aggregatesIRByName,
      bcByAggregate,
      workflowsByName,
      bcByWorkflow,
      new Map(),
      pageRoutes,
    );
    out.set(
      pagePath(page),
      renderVuePage({ page, routeParams: page.params.map((p) => p.name), result }),
    );
  }
  out.set("src/pages/NotFound.vue", renderShell(pack, "not-found-page", {}));
  out.set("src/router.ts", renderRouter(pages));

  // Shared shell files (api/ + vue/ + docker/ shared-source layers).
  const hasDelete = aggregates.some((a) => !!a.agg.canonicalDestroy);
  out.set("src/api/client.ts", renderShell(pack, "api-client", { hasDelete }));
  out.set("src/api/config.ts", renderShell(pack, "api-config", { apiBaseUrl }));
  out.set("src/logger.ts", renderShell(pack, "logger", {}));
  out.set("src/lib/format.ts", renderShell(pack, "format-helpers", {}));

  // Pack shell tier.
  out.set("src/theme.ts", renderShell(pack, "theme", prepareThemeVM(sys.theme)));
  out.set("src/main.ts", renderShell(pack, "main", {}));
  out.set(
    "src/App.vue",
    renderShell(pack, "app-shell", {
      systemNameHuman: humanize(sys.name),
      navSections: deriveNavSections(pages),
    }),
  );

  const usesMoney = contexts.some(contextUsesMoney);
  if (usesMoney) {
    out.set("src/lib/schemas.ts", REACT_LIB_SCHEMAS_MONEY_TS);
  }
  out.set("package.json", renderShell(pack, "package-json", { usesMoney }));
  out.set("tsconfig.json", renderShell(pack, "tsconfig", {}));
  out.set("tsconfig.node.json", renderShell(pack, "tsconfig-node", {}));
  out.set("vite.config.ts", renderShell(pack, "vite-config", {}));
  out.set("index.html", renderShell(pack, "index-html", prepareIndexHtmlVM(deployable, ui)));
  out.set("Dockerfile", renderShell(pack, "dockerfile", {}));
  out.set(".dockerignore", renderShell(pack, "dockerignore", {}));
  out.set("certs/.gitkeep", "");

  return out;
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

function renderRouter(pages: PageIR[]): string {
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { createRouter, createWebHistory } from "vue-router";`);
  for (const page of pages) {
    const rel = pagePath(page).replace(/^src\//, "./");
    lines.push(`import ${pageComponentName(page)} from "${rel}";`);
  }
  lines.push(`import NotFound from "./pages/NotFound.vue";`);
  lines.push("");
  lines.push("// Optional basename hook the host page can set before the bundle");
  lines.push("// runs (e.g. the Loom playground iframe injects __LOOM_BASENAME__");
  lines.push("// so routes resolve inside the iframe scope).  Plain deploys");
  lines.push("// leave it undefined and the history defaults to `/`.");
  lines.push("const basename =");
  lines.push(`  (typeof window !== "undefined"`);
  lines.push("    ? (window as { __LOOM_BASENAME__?: string }).__LOOM_BASENAME__");
  lines.push("    : undefined) ?? undefined;");
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

function deriveNavSections(pages: PageIR[]): Array<{ label: string; entries: NavEntryVM[] }> {
  const aggregates: NavEntryVM[] = [];
  const workflows: NavEntryVM[] = [];
  const views: NavEntryVM[] = [];
  for (const page of pages) {
    const o = page.origin;
    if (!o || !page.route) continue;
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
