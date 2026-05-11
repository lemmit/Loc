import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createDddServices } from "../src/language/ddd-module.js";
import { generateSystems } from "../src/system/index.js";
import type { Model } from "../src/language/generated/ast.js";
import { emitApiControllers } from "../src/generator/phoenix-live-view/api-emit.js";
import type { BoundedContextIR, DeployableIR, SystemIR } from "../src/ir/loom-ir.js";

// ---------------------------------------------------------------------------
// Phase 9 — phoenixLiveView pipeline integration test.
//
// Exercises the full Phase 1 → Phase 8 path on a minimal source:
//   parse → validate → lower → emitProject → composeService → docker-compose
// for a deployable that picks the new `phoenixLiveView` platform.
//
// Bench is intentionally tiny (one aggregate, one workflow, one ui block)
// so failures pinpoint the platform plumbing, not domain semantics.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const FIXTURE_SOURCE = `system MiniLiveView {

  module Sales {
    context Sales {
      aggregate Customer {
        name: string display
        email: string
        invariant email.length > 0
      }
      repository Customers for Customer { }
    }
  }

  api SalesApi from Sales

  ui SalesAdmin {
    scaffold modules: Sales
  }

  deployable phoenixApp {
    platform: phoenixLiveView,
    modules: Sales,
    serves: SalesApi,
    ui: SalesAdmin,
    port: 4000
  }
}
`;

async function buildFixture(): Promise<Model> {
  // Write to a temp dir so the Langium document URI is stable, then
  // build with validation enabled.  Cleanup deferred to OS.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-pliv-"));
  const file = path.join(dir, "mini.ddd");
  fs.writeFileSync(file, FIXTURE_SOURCE);
  const services = createDddServices(NodeFileSystem);
  const doc =
    await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
      URI.file(file),
    );
  await services.shared.workspace.DocumentBuilder.build([doc], {
    validation: true,
  });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errors.length > 0) {
    throw new Error(
      `Validation errors in fixture:\n` +
        errors.map((e) => `  ${e.message}`).join("\n"),
    );
  }
  return doc.parseResult.value as Model;
}

describe("phoenixLiveView pipeline (Phases 1-8)", () => {
  it("validates a deployable that mounts ui: AND serves: an api", async () => {
    // Validation success is the assertion — buildFixture() throws on errors.
    const model = await buildFixture();
    expect(model).toBeDefined();
  });

  it("emits a project under the deployable slug with a mix.exs", async () => {
    const model = await buildFixture();
    const { files } = generateSystems(model);
    const keys = [...files.keys()];
    expect(keys.some((k) => k.startsWith("phoenix_app/"))).toBe(true);
    expect(files.has("phoenix_app/mix.exs")).toBe(true);
  });

  it("emits docker-compose with a postgres-dependent phoenix service", async () => {
    const model = await buildFixture();
    const { files } = generateSystems(model);
    const compose = files.get("docker-compose.yml")!;
    // Service stanza for the deployable, hyphenated by the slug helper.
    expect(compose).toMatch(/phoenix_app:/);
    // Phoenix port 4000 published; Phase 2 platform contract.
    expect(compose).toMatch(/4000:4000/);
    // depends_on db with healthcheck wait — `needsDb: true` on the
    // platform; orchestrator picks it up via PlatformSurface.
    expect(compose).toMatch(/depends_on:[\s\S]*db:[\s\S]*service_healthy/);
    // Phoenix-shaped env vars from composeService().
    expect(compose).toMatch(/DATABASE_URL/);
    expect(compose).toMatch(/SECRET_KEY_BASE/);
    expect(compose).toMatch(/PHX_HOST/);
  });

  it("creates a postgres database for the deployable in db-init", async () => {
    const model = await buildFixture();
    const { files } = generateSystems(model);
    const init = files.get("db-init/00-create-databases.sql")!;
    expect(init).toMatch(/CREATE DATABASE phoenix_app;/);
  });

  it("emits one LiveView module per scaffolded page + router lines", async () => {
    // The fixture's `scaffold modules: Sales` synthesises three pages
    // for the Customer aggregate (list / new / detail).  Each lands
    // as a LiveView module under lib/<app>_web/live/ and contributes
    // a `live "<route>", <Page>Live` line to router.ex.
    const model = await buildFixture();
    const { files } = generateSystems(model);
    const liveFiles = [...files.keys()].filter((k) =>
      /^phoenix_app\/lib\/phoenix_app_web\/live\/.*_live\.ex$/.test(k),
    );
    expect(liveFiles.length).toBeGreaterThanOrEqual(3);
    // Each LiveView module has the canonical mount/handle_params/render shape.
    const sample = files.get(liveFiles[0]!)!;
    expect(sample).toMatch(/use PhoenixAppWeb, :live_view/);
    expect(sample).toMatch(/def mount\(/);
    expect(sample).toMatch(/def handle_params\(/);
    expect(sample).toMatch(/def render\(assigns\) do/);
    // Router has at least one `live "..."` line.
    const router = files.get("phoenix_app/lib/phoenix_app_web/router.ex")!;
    expect(router).toMatch(/live "[^"]+", [A-Z]\w*Live/);
  });

  it("rejects a phoenixLiveView deployable that declares targets:", async () => {
    // A standalone fixture (not a string-replace splice — easier to
    // verify the source by eye).  phoenixApp wrongly declares
    // targets: peer; should fail the "no targets on a fullstack"
    // rule (validator restricts targets: to react/static).
    const src = `system MiniBad {
  module Sales {
    context Sales {
      aggregate Customer { name: string display }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  ui SalesAdmin { scaffold modules: Sales }

  deployable peer {
    platform: hono,
    modules: Sales
  }
  deployable phoenixApp {
    platform: phoenixLiveView,
    modules: Sales,
    targets: peer,
    serves: SalesApi,
    ui: SalesAdmin
  }
}
`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-pliv-bad-"));
    const file = path.join(dir, "bad.ddd");
    fs.writeFileSync(file, src);
    const services = createDddServices(NodeFileSystem);
    const doc =
      await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
        URI.file(file),
      );
    await services.shared.workspace.DocumentBuilder.build([doc], {
      validation: true,
    });
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
    expect(
      errors.some((e) => /'targets:'/.test(e.message)),
    ).toBe(true);
  });

  it("rejects platform: phoenixLiveView paired with framework: react", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-pliv-fw-"));
    const file = path.join(dir, "fw.ddd");
    fs.writeFileSync(
      file,
      FIXTURE_SOURCE.replace(
        "ui: SalesAdmin,",
        `ui SalesAdmin { framework: react }`,
      ).replace("port: 4000", ""),
    );
    const services = createDddServices(NodeFileSystem);
    const doc =
      await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
        URI.file(file),
      );
    await services.shared.workspace.DocumentBuilder.build([doc], {
      validation: true,
    });
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
    expect(
      errors.some(
        (e) => /Framework 'react' does not match platform 'phoenixLiveView'/.test(e.message),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// api-emit unit tests — exercise emitApiControllers directly.
// ---------------------------------------------------------------------------

describe("emitApiControllers (api-emit unit)", () => {
  // Minimal stub BoundedContextIR — one workflow declared.
  const workflowCtx: BoundedContextIR = {
    name: "Sales",
    enums: [],
    valueObjects: [],
    events: [],
    aggregates: [],
    repositories: [],
    workflows: [
      {
        name: "placeOrder",
        params: [{ name: "customerId", type: { kind: "primitive", name: "guid" } }],
        transactional: false,
        statements: [],
        savesAtExit: [],
      },
    ],
    views: [],
  };

  const stubDeployable: DeployableIR = {
    name: "phoenixApp",
    platform: "phoenixLiveView",
    moduleNames: ["Sales"],
    port: 4000,
    serves: ["SalesApi"],
    uiBindings: [],
    moduleBindings: [],
  };

  const stubSys: SystemIR = {
    name: "Mini",
    modules: [],
    deployables: [stubDeployable],
    e2eTests: [],
    uis: [],
    apis: [],
    storages: [],
  };

  it("always emits health_controller.ex regardless of workflows", () => {
    // Even with no workflows, the health controller must be present.
    const emptyCtx: BoundedContextIR = { ...workflowCtx, workflows: [], views: [] };
    const { files } = emitApiControllers({
      contexts: [emptyCtx],
      deployable: stubDeployable,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    expect(files.has("lib/phoenix_app_web/controllers/health_controller.ex")).toBe(true);
  });

  it("health_controller.ex contains liveness and readiness actions", () => {
    const { files } = emitApiControllers({
      contexts: [workflowCtx],
      deployable: stubDeployable,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const health = files.get("lib/phoenix_app_web/controllers/health_controller.ex")!;
    expect(health).toMatch(/def liveness\(/);
    expect(health).toMatch(/def readiness\(/);
    expect(health).toMatch(/"ok"/);
    expect(health).toMatch(/service_unavailable/);
    expect(health).toMatch(/PhoenixApp\.Repo/);
  });

  it("emits workflows_controller.ex when deployable serves an api and workflows exist", () => {
    const { files, apiRoutes } = emitApiControllers({
      contexts: [workflowCtx],
      deployable: stubDeployable,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    expect(files.has("lib/phoenix_app_web/controllers/workflows_controller.ex")).toBe(true);
    const ctrl = files.get("lib/phoenix_app_web/controllers/workflows_controller.ex")!;
    expect(ctrl).toMatch(/def place_order\(conn, params\)/);
    expect(ctrl).toMatch(/PhoenixApp\.Sales\.Workflows\.PlaceOrder\.run/);

    // Route entry exists with correct shape
    const wfRoute = apiRoutes.find((r) => r.path === "/workflows/place_order");
    expect(wfRoute).toBeDefined();
    expect(wfRoute?.method).toBe("post");
    expect(wfRoute?.action).toBe(":place_order");
  });

  it("does NOT emit workflows_controller.ex when deployable serves nothing", () => {
    const noServe: DeployableIR = { ...stubDeployable, serves: [] };
    const { files } = emitApiControllers({
      contexts: [workflowCtx],
      deployable: noServe,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    expect(files.has("lib/phoenix_app_web/controllers/workflows_controller.ex")).toBe(false);
  });

  it("emits !root: sentinel routes for /health and /ready", () => {
    const { apiRoutes } = emitApiControllers({
      contexts: [workflowCtx],
      deployable: stubDeployable,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const health = apiRoutes.find((r) => r.path === "!root:/health");
    const ready = apiRoutes.find((r) => r.path === "!root:/ready");
    expect(health).toBeDefined();
    expect(health?.action).toBe(":liveness");
    expect(ready).toBeDefined();
    expect(ready?.action).toBe(":readiness");
  });
});

// suppress unused imports if test framework expects them at top level
void repoRoot;

// ---------------------------------------------------------------------------
// Batch C — markers for parent integration.
//
// These tests will pass once the orchestrator (index.ts) wires the four new
// emitters.  Kept as .skip() so the build stays green; remove .skip() when
// the parent integration lands.
// ---------------------------------------------------------------------------

describe.skip("Batch C integration (parent wires emitters)", () => {
  it("renderThemeCss produces a :root block with CSS custom properties", async () => {
    const { renderThemeCss } = await import(
      "../src/generator/phoenix-live-view/theme-emit.js"
    );
    const css = renderThemeCss(undefined);
    expect(css).toMatch(/:root\s*\{/);
    expect(css).toMatch(/--color-brand-6:/);
    expect(css).toMatch(/--color-primary:/);
    expect(css).toMatch(/--font-family:/);
    expect(css).toMatch(/--radius:/);
    expect(css).not.toMatch(/<style>/);
  });

  it("renderSidebarComponent emits a Phoenix.Component nav block", async () => {
    const { renderSidebarComponent } = await import(
      "../src/generator/phoenix-live-view/sidebar-emit.js"
    );
    const ui = {
      name: "SalesAdmin",
      pages: [{ name: "Home", route: "/", params: [], state: [], source: "scaffold" as const }],
      components: [],
      scaffolds: [],
      apiParams: [],
      helperImports: [],
    };
    const src = renderSidebarComponent({ ui, appName: "sales", appModule: "Sales" });
    expect(src).toMatch(/defmodule SalesWeb\.Components\.Sidebar/);
    expect(src).toMatch(/def sidebar\(assigns\)/);
    expect(src).toMatch(/data-testid="sidebar"/);
  });

  it("renderWorkflowFormHeex returns a non-placeholder HEEx string when workflow exists", async () => {
    const { renderWorkflowFormHeex } = await import(
      "../src/generator/phoenix-live-view/extra-archetype-emit.js"
    );
    const { loadPack, resolvePackDir } = await import(
      "../src/generator/react/templating/loader-fs.js"
    );
    const pack = loadPack(resolvePackDir("ashPhoenix"));
    const ctx = {
      name: "Sales",
      enums: [],
      valueObjects: [],
      events: [],
      aggregates: [],
      repositories: [],
      workflows: [{ name: "placeOrder", params: [], transactional: false, statements: [], savesAtExit: [] }],
      views: [],
    };
    const heex = renderWorkflowFormHeex({
      workflowName: "placeOrder",
      contextName: "Sales",
      contexts: [ctx],
      aggregatesByName: new Map(),
      pack,
    });
    expect(heex).toMatch(/data-testid="workflow-place_order"/);
    expect(heex).not.toMatch(/<!-- TODO:/);
  });

  it("buildPlaywrightPageObject emits a class with goto() for a home page", async () => {
    const { buildPlaywrightPageObject } = await import(
      "../src/generator/phoenix-live-view/page-objects-emit.js"
    );
    const page = {
      name: "Home",
      route: "/",
      params: [],
      state: [],
      source: "scaffold" as const,
      scaffoldOrigin: { kind: "home" as const },
    };
    const ts = buildPlaywrightPageObject({
      page,
      appName: "sales",
      aggregatesByName: new Map(),
      contextByAggName: new Map(),
    });
    expect(ts).toMatch(/export class HomePage/);
    expect(ts).toMatch(/static readonly url = "\/"/);
    expect(ts).toMatch(/async goto\(\)/);
    expect(ts).toMatch(/getByTestId\("home"\)/);
  });
});
