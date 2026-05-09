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
import { loadPack, resolvePackDir } from "./templating/loader-fs.js";
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
import { emitPagesForUi, emitPageObjectsForUi } from "./pages-emitter.js";
import { deriveSidebarFromUi } from "./menu-emitter.js";

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

  // Slice 5 — page metamodel routing.  When the deployable declares
  // a `ui:` binding, the React generator walks `ui.pages` (post-
  // Slice-4 expansion) via `emitPagesForUi`, which dispatches per
  // `scaffoldOrigin` to the SAME `renderXxx` functions invoked
  // below for the legacy direct walk.  Byte-for-byte equivalent in
  // the bulk-scaffold case (the acceptance gate of Slice 5).
  //
  // Without a `ui:` binding (legacy/back-compat), fall through to
  // the per-aggregate / per-workflow / per-view loops directly.
  // Slices 8/9 finalise the migration and delete the fallback.
  const ui = deployable.uiName
    ? sys.uis.find((u) => u.name === deployable.uiName)
    : undefined;

  // Per-aggregate api modules — always emitted; 1:1 with the
  // aggregate inventory.  The Playwright page object emission moves
  // into the `if (ui)` branch below (Slice 7) so page-IR-routed
  // deployables walk the same source for both pages and page
  // objects.
  for (const { agg, ctx } of aggregates) {
    const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
    out.set(`src/api/${camel(agg.name)}.ts`, buildApiModule(agg, repo, ctx));
  }

  const workflows = allWorkflows(contexts);
  const views = allViews(contexts);

  if (ui) {
    // Page-IR-driven emission.  All `src/pages/...` files go through
    // the page emitter; the home page is rendered through main's
    // template-pack `renderHome`, threaded as the home callback so
    // the emitter stays page-IR-shaped without a hard dependency on
    // the renderer module from this side.  Slice 7: Playwright page
    // objects under `e2e/pages/` also walk `ui.pages` via
    // `emitPageObjectsForUi` — same source of truth, byte-identical
    // file set to the legacy aggregate / workflow / view loops.
    const contextsByName = new Map<string, BoundedContextIR>();
    for (const ctx of contexts) contextsByName.set(ctx.name, ctx);
    const emitCtx = {
      sys,
      deployable,
      aggregatesByName,
      contextsByName,
      pack,
    };
    const pages = emitPagesForUi(
      ui,
      emitCtx,
      (aggs, wfs, vws, sysName) =>
        renderHome(aggs, wfs, vws, sysName, pack),
    );
    pages.forEach((content, path) => out.set(path, content));
    const pageObjects = emitPageObjectsForUi(ui, emitCtx);
    pageObjects.forEach((content, path) => out.set(path, content));
  } else {
    // Legacy back-compat path for deployables without a `ui:`
    // binding: per-aggregate pages + Playwright page objects walked
    // from the aggregate inventory directly.
    for (const { agg, ctx } of aggregates) {
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
  }

  // Workflow UI — Playwright page objects + the shared workflows API
  // module are 1:1 with the workflow inventory, not with a generated
  // page; emit them regardless of the page-emission path.  The per-
  // workflow form pages and the workflows index live in
  // `emitPagesForUi` when `ui` is set; the legacy fallback below
  // covers the no-ui branch.
  if (hasAnyWorkflow(contexts)) {
    out.set("src/api/workflows.ts", buildWorkflowsApiModule(contexts));
    if (!ui) {
      // Legacy back-compat path: pages + page objects walked from
      // the workflow inventory directly.  When `ui` is set, both
      // come from `emitPagesForUi` / `emitPageObjectsForUi` and
      // route through page IR.
      out.set(
        "src/pages/workflows/index.tsx",
        renderWorkflowsIndex(contexts, pack),
      );
      for (const { wf, ctx } of workflows) {
        out.set(
          `src/pages/workflows/${snake(wf.name)}.tsx`,
          renderWorkflowForm(wf, ctx, aggregatesByName, pack),
        );
        out.set(
          `e2e/pages/workflows/${snake(wf.name)}.ts`,
          buildWorkflowPageObject(wf, ctx),
        );
      }
    }
  }

  // View UI — same shape as workflows: per-view page object + the
  // shared views API module always emitted; the per-view table
  // pages and the views index go through `emitPagesForUi` when
  // `ui` is set.
  if (hasAnyView(contexts)) {
    out.set("src/api/views.ts", buildViewsApiModule(contexts));
    if (!ui) {
      // Legacy back-compat path: pages + page objects walked from
      // the view inventory directly.  When `ui` is set, both come
      // from `emitPagesForUi` / `emitPageObjectsForUi` and route
      // through page IR.
      out.set(
        "src/pages/views/index.tsx",
        renderViewsIndex(contexts, pack),
      );
      for (const { view, ctx } of views) {
        out.set(
          `src/pages/views/${snake(view.name)}.tsx`,
          renderViewTablePage(view, ctx, aggregatesByName, pack),
        );
        out.set(
          `e2e/pages/views/${snake(view.name)}.ts`,
          buildViewPageObject(view, ctx),
        );
      }
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
  out.set("src/lib/format.tsx", renderShellFile("format-helpers", {}, pack));
  // Theme — every generated app gets a tasteful baseline (indigo
  // primary, medium radius, Inter font) so the bare-Mantine
  // "construction site" look is gone by default.  System-level
  // `theme { ... }` blocks override the baseline through the
  // pack's "theme" template; the generated file always exists and
  // main.tsx always wires `<MantineProvider theme={theme}>`.
  out.set("src/theme.ts", renderTheme(sys.theme, pack));
  out.set("src/main.tsx", renderMain(pack));
  // Slice 6: when the ui block declares an explicit `menu { … }`,
  // its derived sidebar overrides the hardcoded Aggregates /
  // Workflows / Views grouping below.  When the ui has no menu
  // block (or no ui binding at all), `sidebarOverride` is
  // `undefined` and the AppShell preparer falls back to its legacy
  // hardcoded shape — byte-identical to main's pre-Slice-6 output.
  const sidebarOverride = ui ? deriveSidebarFromUi(ui) : undefined;

  out.set(
    "src/App.tsx",
    renderAppShell(
      aggregates.map((a) => a.agg),
      workflows.map((w) => w.wf),
      views.map((v) => v.view),
      sys.name,
      pack,
      sidebarOverride,
    ),
  );
  // Home page goes through `emitPagesForUi` when a `ui:` binding is
  // present (the Slice-4 expander synthesises a `Home` PageIR with
  // `scaffoldOrigin.kind === "home"` whenever any aggregate /
  // workflow / view is scaffolded).  Without a `ui:` binding we
  // emit Home unconditionally — same shape every legacy react
  // deployable produced.
  if (!ui) {
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
  }

  out.set("package.json", renderShellFile("package-json", {}, pack));
  out.set("tsconfig.json", renderShellFile("tsconfig", {}, pack));
  out.set("tsconfig.node.json", renderShellFile("tsconfig-node", {}, pack));
  out.set("vite.config.ts", renderShellFile("vite-config", {}, pack));
  out.set("index.html", renderShellFile("index-html", {}, pack));
  out.set("Dockerfile", renderShellFile("dockerfile", {}, pack));
  out.set(".dockerignore", renderShellFile("dockerignore", {}, pack));
  out.set("certs/.gitkeep", "");

  // Pack-specific extras — emitted only when the pack registers
  // the matching template name in its manifest.  Mantine pack
  // doesn't ship Tailwind / globals.css / cn() utility, so it
  // skips these files.  shadcn pack (Phase 2.1) ships all four
  // so the generated project boots with Tailwind + the cn() helper
  // ready for the components/ui/* files Phase 2.2 will add.
  if (pack.templates.has("tailwind-config")) {
    out.set("tailwind.config.ts", renderShellFile("tailwind-config", {}, pack));
  }
  if (pack.templates.has("postcss-config")) {
    out.set("postcss.config.js", renderShellFile("postcss-config", {}, pack));
  }
  if (pack.templates.has("globals-css")) {
    out.set("src/globals.css", renderShellFile("globals-css", {}, pack));
  }
  if (pack.templates.has("lib-utils")) {
    out.set("src/lib/utils.ts", renderShellFile("lib-utils", {}, pack));
  }
  // shadcn UI library — emit any `components-ui-*` template the
  // pack ships as a `src/components/ui/<name>.tsx` file.  Mantine
  // pack has zero of these; shadcn pack ships ~13 in Phase 2.2,
  // covering the surfaces the page templates will use in Phase 2.3
  // (Button, Card, Input, Label, Table, Form, Select, Switch,
  // Badge, Alert, Skeleton, Dialog, Tooltip).
  for (const templateName of pack.templates.keys()) {
    const m = /^components-ui-(.+)$/.exec(templateName);
    if (!m) continue;
    out.set(
      `src/components/ui/${m[1]}.tsx`,
      renderShellFile(templateName, {}, pack),
    );
  }

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
