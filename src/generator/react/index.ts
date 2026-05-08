import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  SystemIR,
} from "../../ir/loom-ir.js";
import { camel, snake, plural } from "../../util/naming.js";
import { buildApiModule } from "./api-builder.js";
import { buildPageObjectModule } from "./page-objects-builder.js";
import {
  allWorkflows,
  buildWorkflowPageObject,
  buildWorkflowsApiModule,
  hasAnyWorkflow,
} from "./workflow-builder.js";
import {
  allViews,
  buildViewPageObject,
  buildViewsApiModule,
  hasAnyView,
} from "./view-builder.js";
import { FORMAT_HELPERS_TSX } from "./format-helpers.js";
import { loadPack, resolvePackDir } from "./templating/loader.js";
import {
  renderAppShell,
  renderDetailPage,
  renderHome,
  renderListPage,
  renderMain,
  renderNewPage,
  renderShellFile,
  renderTheme,
  renderViewTablePage,
  renderViewsIndex,
  renderWorkflowForm,
  renderWorkflowsIndex,
} from "./templating/render.js";

// ---------------------------------------------------------------------------
// React + React Query + Zod + Mantine generator.
//
// Emits a Vite-built SPA per react-platform deployable.  Pages are
// derived mechanically from each aggregate's IR:
//
//   /<plural>            list.tsx        Mantine Table from useAll<Agg>()
//   /<plural>/new        new.tsx         Mantine form for Create<Agg>Request
//   /<plural>/:id        detail.tsx      Card + nested tables (master-detail)
//                                        + one button per public operation
//
// API URLs are baked in at generation time from the target deployable's
// port (overridable via `import.meta.env.VITE_API_BASE_URL`).  The
// generated app uses `@hono/zod-openapi`-style Zod schemas matching the
// backend's wire shape, parsed at the boundary so response types are
// validated, not just trusted.
// ---------------------------------------------------------------------------

export function generateReactForContexts(
  contexts: BoundedContextIR[],
  sys: SystemIR,
  deployable: DeployableIR,
): Map<string, string> {
  const out = new Map<string, string>();

  const target = sys.deployables.find((d) => d.name === deployable.targetName);
  const apiBaseUrl = `http://localhost:${target?.port ?? 8080}`;

  // Per-aggregate api modules + pages.
  const aggregates: Array<{ agg: AggregateIR; ctx: BoundedContextIR }> = [];
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) aggregates.push({ agg, ctx });
  }

  // Workspace-wide aggregate registry — used by `Id<X>` form-input
  // emission to resolve the target's display field across bounded
  // contexts.  Built once and threaded through every per-aggregate
  // builder to avoid recomputing per-call.
  const aggregatesByName = new Map<string, AggregateIR>();
  for (const { agg } of aggregates) aggregatesByName.set(agg.name, agg);

  // Phase 0: route list-page emission through the new template-pack
  // layer.  Loads the pack named by `deployable.design` (defaulted
  // to "mantine" by the lowerer for react deployables); other page
  // kinds still use the legacy TS builders for now.  Subsequent
  // phases port each remaining page kind, deleting its TS builder
  // as it lands.
  const design = deployable.design ?? "mantine";
  const pack = loadPack(resolvePackDir(design));

  for (const { agg, ctx } of aggregates) {
    const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
    out.set(`src/api/${camel(agg.name)}.ts`, buildApiModule(agg, repo, ctx));
    out.set(
      `src/pages/${snake(plural(agg.name))}/list.tsx`,
      renderListPage(agg, aggregatesByName, pack),
    );
    out.set(
      `src/pages/${snake(plural(agg.name))}/new.tsx`,
      renderNewPage(agg, ctx, aggregatesByName, pack),
    );
    out.set(
      `src/pages/${snake(plural(agg.name))}/detail.tsx`,
      renderDetailPage(agg, ctx, aggregatesByName, pack),
    );
    out.set(
      `e2e/pages/${camel(agg.name)}.ts`,
      buildPageObjectModule(agg, ctx),
    );
  }

  // Workflow UI — surfaces every backend workflow as a generated form
  // page so users can invoke them from the browser instead of curl /
  // Postman.  Reuses the per-aggregate form-helpers for typed inputs.
  const workflows = allWorkflows(contexts);
  if (hasAnyWorkflow(contexts)) {
    out.set("src/api/workflows.ts", buildWorkflowsApiModule(contexts));
    out.set("src/pages/workflows/index.tsx", renderWorkflowsIndex(contexts, pack));
    for (const { wf, ctx } of workflows) {
      out.set(
        `src/pages/workflows/${snake(wf.name)}.tsx`,
        renderWorkflowForm(wf, ctx, aggregatesByName, pack),
      );
      // Slice 18.C — Playwright page object so DSL `ui.workflows.X(...)`
      // calls have a typed driver to lower against.  Lives under
      // `e2e/pages/workflows/<slug>.ts`, mirroring the per-aggregate
      // page object layout.
      out.set(
        `e2e/pages/workflows/${snake(wf.name)}.ts`,
        buildWorkflowPageObject(wf, ctx),
      );
    }
  }

  // View UI — surfaces every backend view as a generated table page.
  // Shorthand views reuse the source aggregate's wire schema; full-form
  // views get their own per-view row schema.  Cross-aggregate Id<X>
  // cells link to the matching detail page when that aggregate is in
  // this deployable's modules.
  const views = allViews(contexts);
  if (hasAnyView(contexts)) {
    out.set("src/api/views.ts", buildViewsApiModule(contexts));
    out.set("src/pages/views/index.tsx", renderViewsIndex(contexts, pack));
    for (const { view, ctx } of views) {
      out.set(
        `src/pages/views/${snake(view.name)}.tsx`,
        renderViewTablePage(view, ctx, aggregatesByName, pack),
      );
      // Slice 18.C — Playwright page object so DSL `ui.views.X()`
      // calls can read the rendered table back as typed objects.
      out.set(
        `e2e/pages/views/${snake(view.name)}.ts`,
        buildViewPageObject(view, ctx),
      );
    }
  }

  out.set("e2e/smoke.spec.ts", smokeSpec(aggregates.map((a) => a.agg)));
  out.set("e2e/playwright.config.ts", PLAYWRIGHT_CONFIG_TS);
  out.set("e2e/package.json", E2E_PACKAGE_JSON);
  out.set("e2e/tsconfig.json", E2E_TSCONFIG_JSON);

  out.set("src/api/client.ts", renderShellFile("api-client", {}, pack));
  out.set(
    "src/api/config.ts",
    renderShellFile("api-config", { apiBaseUrl }, pack),
  );
  out.set("src/lib/format.tsx", FORMAT_HELPERS_TSX);
  // Theme — every generated app gets a tasteful baseline (indigo
  // primary, medium radius, Inter font) so the bare-Mantine
  // "construction site" look is gone by default.  System-level
  // `theme { ... }` blocks override the baseline through the
  // pack's "theme" template; the generated file always exists and
  // main.tsx always wires `<MantineProvider theme={theme}>`.
  out.set("src/theme.ts", renderTheme(sys.theme, pack));
  out.set("src/main.tsx", renderMain(pack));
  out.set(
    "src/App.tsx",
    renderAppShell(
      aggregates.map((a) => a.agg),
      workflows.map((w) => w.wf),
      views.map((v) => v.view),
      sys.name,
      pack,
    ),
  );
  out.set(
    "src/pages/home.tsx",
    renderHome(
      aggregates.map((a) => a.agg),
      workflows.map((w) => w.wf),
      views.map((v) => v.view),
      sys.name,
      pack,
    ),
  );

  out.set("package.json", renderShellFile("package-json", {}, pack));
  out.set("tsconfig.json", renderShellFile("tsconfig", {}, pack));
  out.set("tsconfig.node.json", renderShellFile("tsconfig-node", {}, pack));
  out.set("vite.config.ts", renderShellFile("vite-config", {}, pack));
  out.set("index.html", renderShellFile("index-html", {}, pack));
  out.set("Dockerfile", renderShellFile("dockerfile", {}, pack));
  out.set(".dockerignore", renderShellFile("dockerignore", {}, pack));
  out.set("certs/.gitkeep", "");

  return out;
}

function smokeSpec(aggregates: AggregateIR[]): string {
  // Auto-generated minimal Playwright smoke: every aggregate's list
  // page loads.  Users add per-aggregate scenarios using the page
  // objects under e2e/pages/.
  const imports = aggregates
    .map(
      (a) =>
        `import { ${upper(a.name)}ListPage } from "./pages/${camel(a.name)}";`,
    )
    .join("\n");
  const cases = aggregates
    .map(
      (a) =>
        `test("${snake(plural(a.name))} list loads", async ({ page }) => {\n  const p = await new ${upper(a.name)}ListPage(page).goto();\n  await expect(p.page).toHaveURL(/${snake(plural(a.name))}$/);\n});`,
    )
    .join("\n\n");
  return `// Auto-generated smoke spec.
import { test, expect } from "@playwright/test";
${imports}

${cases}
`;
}

const PLAYWRIGHT_CONFIG_TS = `// Auto-generated.
import { defineConfig, devices } from "@playwright/test";

// Tests target a running web_app — typically the docker-compose
// service on port 3001.  Override via E2E_BASE_URL.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\\.spec\\.ts$/,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3001",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
`;

// The Playwright suite has its own package.json so the runtime image
// builds fast (no @playwright/test in the production install).  Run
// it from inside ./e2e with `npm install && npx playwright test`.
const E2E_PACKAGE_JSON =
  JSON.stringify(
    {
      name: "loom-react-app-e2e",
      version: "0.0.0",
      type: "module",
      private: true,
      scripts: {
        test: "playwright test",
        "test:install": "playwright install --with-deps chromium",
      },
      devDependencies: {
        "@playwright/test": "^1.49.0",
        "@types/node": "^22.0.0",
        typescript: "^5.7.0",
      },
    },
    null,
    2,
  ) + "\n";

const E2E_TSCONFIG_JSON =
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ["node"],
      },
      include: ["**/*.ts", "../src/api/**/*.ts"],
    },
    null,
    2,
  ) + "\n";

function upper(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1);
}
