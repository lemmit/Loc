import type { AggregateIR, BoundedContextIR, DeployableIR, SystemIR } from "../../ir/loom-ir.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import type { LoadedPack } from "../_packs/loader.js";
import { loadPack, resolvePackDir } from "../_packs/loader-fs.js";
import { buildApiModule } from "./api-builder.js";
import { deriveSidebarFromUi } from "./menu-emitter.js";
import { deriveExtraRoutesFromUi, emitPageObjectsForUi, emitPagesForUi } from "./pages-emitter.js";
import { renderAppShell, renderMain, renderShellFile, renderTheme } from "./templating/render.js";
import { allViews, buildViewsApiModule, hasAnyView } from "./view-builder.js";
import { allWorkflows, buildWorkflowsApiModule, hasAnyWorkflow } from "./workflow-builder.js";

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
}

export function generateReactForContexts(
  contexts: BoundedContextIR[],
  sys: SystemIR,
  deployable: DeployableIR,
  options: GenerateReactOptions = {},
): Map<string, string> {
  const out = new Map<string, string>();

  const target = sys.deployables.find((d) => d.name === deployable.targetName);
  // Standalone react picks the target deployable's port; fullstack
  // dotnet overrides with `"/api"` for same-origin SPA fetches.
  const apiBaseUrl = options.apiBaseUrl ?? `http://localhost:${target?.port ?? 8080}`;

  // Per-aggregate api modules + pages.
  const aggregates: Array<{ agg: AggregateIR; ctx: BoundedContextIR }> = [];
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

  // Page metamodel routing.  When the deployable declares
  // a `ui:` binding, the React generator walks `ui.pages` (after
  // scaffold expansion) via `emitPagesForUi`, which dispatches per
  // `scaffoldOrigin` to the SAME `renderXxx` functions invoked
  // below for the legacy direct walk.  Byte-for-byte equivalent in
  // the bulk-scaffold case.
  //
  // Without a `ui:` binding (legacy/back-compat), fall through to
  // the per-aggregate / per-workflow / per-view loops directly.
  // A later change finalises the migration and deletes the fallback.
  const ui = deployable.uiName ? sys.uis.find((u) => u.name === deployable.uiName) : undefined;

  // Per-aggregate api modules — always emitted; 1:1 with the
  // aggregate inventory.  The Playwright page object emission moves
  // into the `if (ui)` branch below so page-IR-routed
  // deployables walk the same source for both pages and page
  // objects.
  for (const { agg, ctx } of aggregates) {
    const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
    out.set(`src/api/${lowerFirst(agg.name)}.ts`, buildApiModule(agg, repo, ctx));
  }

  const workflows = allWorkflows(contexts);
  const views = allViews(contexts);

  if (ui) {
    // Single codegen path: every `src/pages/...` file
    // (scaffold-derived OR explicit) routes through `emitPagesForUi`
    // → walker.  The legacy archetype renderers (`renderListPage`,
    // `renderNewPage`, `renderDetailPage`, etc.) are deleted.
    const contextsByName = new Map<string, BoundedContextIR>();
    for (const ctx of contexts) contextsByName.set(ctx.name, ctx);
    const emitCtx = {
      sys,
      deployable,
      aggregatesByName,
      contextsByName,
      pack,
    };
    const pages = emitPagesForUi(ui, emitCtx);
    pages.forEach((content, path) => out.set(path, content));
    const pageObjects = emitPageObjectsForUi(ui, emitCtx);
    pageObjects.forEach((content, path) => out.set(path, content));
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

  out.set("e2e/smoke.spec.ts", smokeSpec(aggregates.map((a) => a.agg)));
  out.set("e2e/fixtures.ts", E2E_FIXTURES_TS);
  out.set("e2e/playwright.config.ts", PLAYWRIGHT_CONFIG_TS);
  out.set("e2e/package.json", E2E_PACKAGE_JSON);
  out.set("e2e/tsconfig.json", E2E_TSCONFIG_JSON);

  out.set("src/api/client.ts", renderShellFile("api-client", {}, pack));
  out.set("src/api/config.ts", renderShellFile("api-config", { apiBaseUrl }, pack));
  // Frontend observability: a namespaced loglevel logger + a top-level
  // error boundary.  Both are pack-agnostic shared shell files; main.tsx
  // (per pack) mounts the boundary and the api client logs through the
  // logger.  Output flows through console.* so the playground App-log
  // stream and Playwright console capture pick it up.
  out.set("src/logger.ts", renderShellFile("logger", {}, pack));
  out.set("src/ErrorBoundary.tsx", renderShellFile("error-boundary", {}, pack));
  out.set("src/lib/format.tsx", renderShellFile("format-helpers", {}, pack));
  // Theme — every generated app gets a tasteful baseline (indigo
  // primary, medium radius, Inter font) so the bare-Mantine
  // "construction site" look is gone by default.  System-level
  // `theme { ... }` blocks override the baseline through the
  // pack's "theme" template; the generated file always exists and
  // main.tsx always wires `<MantineProvider theme={theme}>`.
  out.set("src/theme.ts", renderTheme(sys.theme, pack));
  out.set("src/main.tsx", renderMain(pack));
  // When the ui block declares an explicit `menu { … }`,
  // its derived sidebar overrides the hardcoded Aggregates /
  // Workflows / Views grouping below.  When the ui has no menu
  // block (or no ui binding at all), `sidebarOverride` is
  // `undefined` and the AppShell preparer falls back to its legacy
  // hardcoded shape — byte-identical to the original sidebar output.
  const sidebarOverride = ui ? deriveSidebarFromUi(ui) : undefined;

  // Explicit pages with non-conventional names need
  // to register their import + route in App.tsx so React Router
  // can mount them.  Pages that override a scaffolded shape at the
  // conventional name keep the conventional path and are routed
  // by the per-aggregate / -workflow / -view loop in
  // `prepareAppShellVM`.
  const extraRoutes = ui ? deriveExtraRoutesFromUi(ui) : undefined;

  out.set(
    "src/App.tsx",
    renderAppShell(
      aggregates.map((a) => a.agg),
      workflows.map((w) => w.wf),
      views.map((v) => v.view),
      sys.name,
      sidebarOverride,
      extraRoutes,
      pack,
    ),
  );
  // Home is always synthesised by the scaffold expander
  // when a `ui:` binding is present.  Deployables without `ui:`
  // emit no Home page (no scaffold archetype renderer left to fall
  // back to); a future change tightens the validator to require a
  // `ui:` binding for any react deployable.

  out.set("package.json", renderShellFile("package-json", {}, pack));
  out.set("tsconfig.json", renderShellFile("tsconfig", {}, pack));
  out.set("tsconfig.node.json", renderShellFile("tsconfig-node", {}, pack));
  out.set("vite.config.ts", renderShellFile("vite-config", {}, pack));
  out.set("index.html", renderShellFile("index-html", {}, pack));
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

/** Emit each entry in the pack manifest's `shellFiles` map (logical
 *  template name → output path).  Throws if a declared template name
 *  isn't registered in `emits`, naming the offending key — this keeps
 *  manifest typos loud rather than silently dropping shell files. */
function emitShellFiles(pack: LoadedPack, out: Map<string, string>): void {
  const entries = Object.entries(pack.manifest.shellFiles ?? {});
  for (const [templateName, outputPath] of entries) {
    if (!pack.templates.has(templateName)) {
      throw new Error(
        `pack ${pack.manifest.name}: shellFiles entry "${templateName}" → "${outputPath}" not present in emits map.`,
      );
    }
    out.set(outputPath, renderShellFile(templateName, {}, pack));
  }
}

/** Emit every template matching one of the pack manifest's
 *  `shellGlobs` patterns.  Each pattern uses `*` as a single-segment
 *  capture; the corresponding output-path template references the
 *  captures as `{1}`, `{2}`, etc.  shadcn uses this for its
 *  `components-ui-*` library: pattern `components-ui-*` →
 *  `src/components/ui/{1}.tsx`. */
function emitShellGlobs(pack: LoadedPack, out: Map<string, string>): void {
  const entries = Object.entries(pack.manifest.shellGlobs ?? {});
  for (const [pattern, outputTemplate] of entries) {
    // Translate `components-ui-*` → /^components-ui-(.+)$/.  Escape
    // every other regex meta-char so a future pattern like
    // `cells.*-mobile` can't accidentally interpret `.` as the
    // any-char metacharacter.
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("^" + escaped.replace(/\*/g, "(.+)") + "$");
    for (const templateName of pack.templates.keys()) {
      const m = re.exec(templateName);
      if (!m) continue;
      let outputPath = outputTemplate;
      for (let i = 1; i < m.length; i++) {
        outputPath = outputPath.replaceAll(`{${i}}`, m[i]);
      }
      out.set(outputPath, renderShellFile(templateName, {}, pack));
    }
  }
}

function smokeSpec(aggregates: AggregateIR[]): string {
  // Auto-generated minimal Playwright smoke: every aggregate's list
  // page loads.  Users add per-aggregate scenarios using the page
  // objects under e2e/pages/.
  const imports = aggregates
    .map((a) => `import { ${upperFirst(a.name)}ListPage } from "./pages/${lowerFirst(a.name)}";`)
    .join("\n");
  const cases = aggregates
    .map(
      (a) =>
        `test("${snake(plural(a.name))} list loads", async ({ page }) => {\n  const p = await new ${upperFirst(a.name)}ListPage(page).goto();\n  await expect(p.page).toHaveURL(/${snake(plural(a.name))}$/);\n});`,
    )
    .join("\n\n");
  return `// Auto-generated smoke spec.
import { test, expect } from "./fixtures";
${imports}

${cases}
`;
}

// Playwright fixture: auto-capture the browser console + uncaught page
// errors and, when a test does not pass, attach them to the report so a
// failure carries the app's own output (not just a screenshot).  Generated
// specs import { test, expect } from "./fixtures" instead of from
// "@playwright/test" so every test gets this for free.
export const E2E_FIXTURES_TS = `// Auto-generated.
import { test as base, expect } from "@playwright/test";

// biome-ignore lint/suspicious/noConfusingVoidType: Playwright fixtures use \`void\` to mean "no value".
export const test = base.extend<{ _consoleCapture: void }>({
  _consoleCapture: [
    async ({ page }, use, testInfo) => {
      const lines: string[] = [];
      page.on("console", (msg) => lines.push(\`[\${msg.type()}] \${msg.text()}\`));
      page.on("pageerror", (err) =>
        lines.push(\`[pageerror] \${err.stack ?? err.message}\`),
      );
      await use();
      if (testInfo.status !== testInfo.expectedStatus && lines.length > 0) {
        await testInfo.attach("console-logs", {
          body: lines.join("\\n"),
          contentType: "text/plain",
        });
      }
    },
    { auto: true },
  ],
});

export { expect };
`;

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
    // Keep the full trace (console + network + DOM snapshots) and a
    // screenshot on every failure so a red test is debuggable from the
    // report alone, alongside the console-logs attachment from fixtures.ts.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
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
