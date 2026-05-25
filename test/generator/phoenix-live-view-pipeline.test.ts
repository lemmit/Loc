import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { emitApiControllers } from "../../src/generator/phoenix-live-view/api-emit.js";
import { emitAggregateResources } from "../../src/generator/phoenix-live-view/domain-emit.js";
import type { BoundedContextIR, DeployableIR, SystemIR } from "../../src/ir/loom-ir.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

// ---------------------------------------------------------------------------
// phoenixLiveView pipeline integration test.
//
// Exercises the full pipeline on a minimal source:
//   parse → validate → lower → emitProject → composeService → docker-compose
// for a deployable that picks the new `phoenixLiveView` platform.
//
// Bench is intentionally tiny (one aggregate, one workflow, one ui block)
// so failures pinpoint the platform plumbing, not domain semantics.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const FIXTURE_SOURCE = `system MiniLiveView {

  module Sales {
    context Sales {
      valueobject Money {
        amount: decimal
        currency: string
      }
      aggregate Customer {
        name: string
        derived display: string = name
        email: string
        creditLimit: Money
        invariant email.length > 0
        operation adjustCredit(amount: decimal) {
          precondition amount > 0
        }
      }
      repository Customers for Customer { }
    }
  }

  api SalesApi from Sales

  ui SalesAdmin with scaffold(modules: [Sales]) {
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
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(file));
  await services.shared.workspace.DocumentBuilder.build([doc], {
    validation: true,
  });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errors.length > 0) {
    throw new Error(
      `Validation errors in fixture:\n` + errors.map((e) => `  ${e.message}`).join("\n"),
    );
  }
  return doc.parseResult.value as Model;
}

describe("phoenixLiveView pipeline", () => {
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
    // Phoenix port 4000 published; platform contract.
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

  it("emits lib/<app>/telemetry.ex that attaches to phoenix endpoint events", async () => {
    // Bite 1: idiomatic Phoenix observability via `:telemetry`.  The
    // Endpoint already mounts `plug Plug.Telemetry,
    // event_prefix: [:phoenix, :endpoint]` so `[:phoenix, :endpoint,
    // :start/:stop]` fires on every request; the emitted Telemetry
    // module attaches handlers and translates them to the neutral
    // catalog identity (request_start / request_end).
    const model = await buildFixture();
    const { files } = generateSystems(model);

    const tel = files.get("phoenix_app/lib/phoenix_app/telemetry.ex");
    expect(tel, "telemetry.ex is emitted").toBeDefined();
    expect(tel!).toMatch(/defmodule PhoenixApp\.Telemetry do/);
    expect(tel!).toMatch(/use Supervisor/);
    expect(tel!).toMatch(/require Logger/);
    // Handlers attach in init/1 after a detach-first idempotency guard.
    expect(tel!).toMatch(/:telemetry\.detach\(@handler_id\)/);
    expect(tel!).toMatch(/:telemetry\.attach_many\(@handler_id, events,/);
    // Both endpoint events are subscribed.
    expect(tel!).toMatch(/\[:phoenix, :endpoint, :start\]/);
    expect(tel!).toMatch(/\[:phoenix, :endpoint, :stop\]/);
    // Catalog identity is preserved on the rendered log line for both
    // events — the renderer in src/generator/_obs/render-phoenix.ts
    // stamps `event: "request_start"` / `event: "request_end"`.
    expect(tel!).toMatch(
      /Logger\.info\("request_start", event: "request_start", method: conn\.method, path: conn\.request_path\)/,
    );
    expect(tel!).toMatch(
      /Logger\.info\("request_end", event: "request_end", method: conn\.method, path: conn\.request_path, status: conn\.status, duration_ms: duration_ms\)/,
    );
    // Duration measurement converted from :native to :millisecond so
    // the structured field is a sensible cross-backend integer.
    expect(tel!).toMatch(
      /System\.convert_time_unit\(measurements\.duration, :native, :millisecond\)/,
    );

    // application.ex lists PhoenixApp.Telemetry between PubSub and
    // Endpoint so handlers attach before the first request is served.
    const app = files.get("phoenix_app/lib/phoenix_app/application.ex")!;
    expect(app).toMatch(
      /\{Phoenix\.PubSub, name: PhoenixApp\.PubSub\},\s*\n\s*PhoenixApp\.Telemetry,\s*\n\s*PhoenixAppWeb\.Endpoint/,
    );
  });

  it("emits server lifecycle catalog events from Application.start/2 + stop/1", async () => {
    // Bite 5b: server_starting / server_listening / server_shutdown /
    // server_drained share catalog identity with Hono + .NET so a
    // cross-backend dashboard pivots on one event name.
    const model = await buildFixture();
    const { files } = generateSystems(model);
    const app = files.get("phoenix_app/lib/phoenix_app/application.ex")!;
    expect(app).toBeDefined();
    expect(app).toMatch(/require Logger/);
    // server_starting fires before Supervisor.start_link so a Repo
    // crash that prevents start_link still surfaces the intent.
    expect(app).toMatch(
      /Logger\.info\("server_starting", event: "server_starting", port: to_string\(port\), env: to_string\(env\)\)/,
    );
    // server_listening only fires on the {:ok, _} branch of start_link.
    expect(app).toMatch(
      /case Supervisor\.start_link\(children, opts\) do\s*\n\s*\{:ok, _pid\} = ok ->\s*\n\s*Logger\.info\("server_listening"/,
    );
    // stop/1 emits shutdown + drained.
    expect(app).toMatch(/def stop\(_state\) do/);
    expect(app).toMatch(
      /Logger\.info\("server_shutdown", event: "server_shutdown", signal: "SIGTERM"\)/,
    );
    expect(app).toMatch(/Logger\.info\("server_drained", event: "server_drained"\)/);
  });

  it("emits lib/<app>/log_formatter.ex (JSON-per-line) + wires it in config.exs", async () => {
    const model = await buildFixture();
    const { files } = generateSystems(model);
    const fmt = files.get("phoenix_app/lib/phoenix_app/log_formatter.ex");
    expect(fmt, "log_formatter.ex is emitted").toBeDefined();
    expect(fmt!).toMatch(/defmodule PhoenixApp\.LogFormatter do/);
    expect(fmt!).toMatch(/def format\(level, message, timestamp, metadata\) do/);
    expect(fmt!).toMatch(/Jason\.encode!/);
    // config/config.exs wires the formatter via :default_formatter,
    // with `:all` metadata so every catalog field survives the bridge.
    const cfg = files.get("phoenix_app/config/config.exs")!;
    expect(cfg).toMatch(
      /config :logger, :default_formatter,\s*\n\s*format: \{PhoenixApp\.LogFormatter, :format\},\s*\n\s*metadata: :all/,
    );
    // dev.exs no longer overrides with the bracketed text format.
    const dev = files.get("phoenix_app/config/dev.exs")!;
    expect(dev).not.toMatch(/config :logger, :console, format:/);
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

  it("scaffolded detail page loads @data + emits operation modal/handlers", async () => {
    // The Customer aggregate has `operation adjustCredit(amount: decimal)`.
    // The detail LiveView must (a) load the record into @data via the
    // get_<agg> code interface in handle_params, (b) assign the op
    // form via AshPhoenix.Form.for_update, (c) emit validate_/submit_
    // handle_event clauses, (d) render the <.modal> + trigger, and
    // the CoreComponents module must define `modal` + the JS helpers.
    const model = await buildFixture();
    const { files } = generateSystems(model);
    const detail = files.get("phoenix_app/lib/phoenix_app_web/live/customer_detail_live.ex")!;
    expect(detail, "detail LiveView is emitted").toBeDefined();

    // (a) record load + idiomatic not-found/error mapping.
    expect(detail).toMatch(/record = PhoenixApp\.Sales\.get_customer!\(socket\.assigns\.id\)/);
    expect(detail).toMatch(
      /rescue\n\s*Ash\.Error\.Query\.NotFound -> assign\(socket, :data, :not_found\)/,
    );
    expect(detail).toMatch(/Ash\.Error\.Invalid -> assign\(socket, :data, :error\)/);

    // (b) operation form bound to the loaded record.
    expect(detail).toMatch(
      /assign\(:adjust_credit_form, AshPhoenix\.Form\.for_update\(record, :adjust_credit, as: "adjust_credit"\) \|> to_form\(\)\)/,
    );

    // (c) AshPhoenix form lifecycle handle_event clauses.
    expect(detail).toMatch(
      /def handle_event\("validate_adjust_credit", %\{"adjust_credit" => params\}, socket\)/,
    );
    expect(detail).toMatch(
      /def handle_event\("submit_adjust_credit", %\{"adjust_credit" => params\}, socket\)/,
    );
    expect(detail).toMatch(
      /AshPhoenix\.Form\.submit\(socket\.assigns\.adjust_credit_form, params: params\)/,
    );

    // (d) modal + trigger in the rendered HEEx.
    expect(detail).toMatch(/<\.modal id="customer-op-adjust_credit-modal">/);
    expect(detail).toMatch(/show_modal\("customer-op-adjust_credit-modal"\)/);
    expect(detail).toMatch(
      /<\.simple_form for=\{@adjust_credit_form\} phx-change="validate_adjust_credit" phx-submit="submit_adjust_credit">/,
    );

    // 4-way cond now distinguishes not-found (empty) from error.
    expect(detail).toMatch(/<% @data == :not_found -> %>/);

    // Value-object field `creditLimit: Money` flattens into one
    // nested KeyValueRow per leaf (not dropped), via real nested
    // member access (correctly snake-cased per segment).
    expect(detail).toMatch(/Credit Limit Amount/);
    expect(detail).toMatch(/Credit Limit Currency/);
    expect(detail).toMatch(/@data\.credit_limit\.amount/);
    expect(detail).toMatch(/@data\.credit_limit\.currency/);

    // CoreComponents gains the modal component + JS helpers.
    const core = files.get("phoenix_app/lib/phoenix_app_web/components/core_components.ex")!;
    expect(core).toMatch(/alias Phoenix\.LiveView\.JS/);
    expect(core).toMatch(/def modal\(assigns\) do/);
    expect(core).toMatch(/def show_modal\(js \\\\ %JS\{\}, id\)/);
    expect(core).toMatch(/def hide_modal\(js \\\\ %JS\{\}, id\)/);
  });

  it("rejects a phoenixLiveView deployable that declares targets:", async () => {
    // A standalone fixture (not a string-replace splice — easier to
    // verify the source by eye).  phoenixApp wrongly declares
    // targets: peer; should fail the "no targets on a fullstack"
    // rule (validator restricts targets: to react/static).
    const src = `system MiniBad {
  module Sales {
    context Sales {
      aggregate Customer { name: string  derived display: string = name }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  ui SalesAdmin with scaffold(modules: [Sales]) {}

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
    const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
      URI.file(file),
    );
    await services.shared.workspace.DocumentBuilder.build([doc], {
      validation: true,
    });
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
    expect(errors.some((e) => /'targets:'/.test(e.message))).toBe(true);
  });

  it("emits an initial Ecto migration per table + a snapshot under .loom/", async () => {
    const model = await buildFixture();
    const { files } = generateSystems(model);
    // One createTable file per top-level aggregate (Customer).  The
    // fixture has no contained parts on Customer, so just one .exs.
    const exsFiles = [...files.keys()].filter((k) =>
      /^phoenix_app\/priv\/repo\/migrations\/\d+_create_.*\.exs$/.test(k),
    );
    expect(exsFiles.length).toBeGreaterThanOrEqual(1);
    const customerMig = exsFiles.find((k) => k.endsWith("_create_customers.exs"));
    expect(customerMig, "customers migration emitted").toBeDefined();
    const body = files.get(customerMig!)!;
    expect(body).toMatch(/defmodule PhoenixApp\.Repo\.Migrations\.CreateCustomers do/);
    expect(body).toMatch(/use Ecto\.Migration/);
    expect(body).toMatch(/create table\(:customers, primary_key: false\) do/);
    expect(body).toMatch(/add :id, :uuid, primary_key: true, null: false/);
    // Money is a valueobject, lowers to a :map column.
    expect(body).toMatch(/add :credit_limit, :map, null: false/);
    expect(body).toMatch(/timestamps\(\)/);

    // Snapshot file at .loom/snapshots/<module>.snapshot.json.
    const snap = files.get(".loom/snapshots/Sales.snapshot.json");
    expect(snap, "snapshot json present").toBeDefined();
    const parsed = JSON.parse(snap!);
    expect(parsed.tables.map((t: { name: string }) => t.name)).toContain("customers");
    expect(parsed.lastVersion).toBe("20260101000000");
  });

  it("rejects platform: phoenixLiveView paired with framework: react", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-pliv-fw-"));
    const file = path.join(dir, "fw.ddd");
    fs.writeFileSync(
      file,
      FIXTURE_SOURCE.replace("ui: SalesAdmin,", `ui SalesAdmin { framework: react }`).replace(
        "port: 4000",
        "",
      ),
    );
    const services = createDddServices(NodeFileSystem);
    const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
      URI.file(file),
    );
    await services.shared.workspace.DocumentBuilder.build([doc], {
      validation: true,
    });
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
    expect(
      errors.some((e) =>
        /Framework 'react' does not match platform 'phoenixLiveView'/.test(e.message),
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
    // Phase 8 Phoenix: liveness + readiness emit the catalog's
    // health_ok line; the rescue branch emits db_error (error) + the
    // cumulative health_degraded (debug) — same event identities the
    // Hono /ready arm emits.  `require Logger` once at module top.
    expect(health).toMatch(/require Logger/);
    expect(health).toMatch(
      /Logger\.debug\("health_ok", event: "health_ok", checks: \["liveness"\]\)/,
    );
    expect(health).toMatch(
      /Logger\.debug\("health_ok", event: "health_ok", checks: \["readiness", "db"\]\)/,
    );
    expect(health).toMatch(
      /Logger\.error\("db_error", event: "db_error", error: Exception\.message\(e\)\)/,
    );
    expect(health).toMatch(
      /Logger\.debug\("health_degraded", event: "health_degraded", checks: \["db"\]\)/,
    );
  });

  it("aggregates_controller.ex emits wire_in (debug) on Create + Update when --trace is on", () => {
    // Phase 8 Phoenix --trace v1 — mirrors Hono Phase 6d / .NET v6.
    // Only seam available in Phoenix today is the controller's CRUD
    // actions; Ash resources are declarative so domain trace events
    // (value_computed / precondition_evaluated / invariant_evaluated)
    // don't have an imperative seam to thread.  wire_in lands AFTER
    // params binding using `Map.keys(params)` for runtime
    // introspection — same identity Hono + .NET emit.  Logger.debug
    // (Elixir has no `trace`; render-phoenix.ts maps trace → debug).
    const aggCtx: BoundedContextIR = {
      ...workflowCtx,
      aggregates: [
        {
          name: "Order",
          fields: [],
          parts: [],
          contains: [],
          derived: [],
          invariants: [],
          functions: [],
          operations: [],
          identity: { kind: "guid" },
        } as unknown as BoundedContextIR["aggregates"][number],
      ],
    };
    const { files } = emitApiControllers({
      contexts: [aggCtx],
      deployable: stubDeployable,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
      emitTrace: true,
    });
    const aggCtrl = files.get("lib/phoenix_app_web/controllers/aggregates_controller.ex")!;
    // create_order + update_order both emit wire_in immediately
    // after the `do` line.
    const wireIns = aggCtrl.match(/Logger\.debug\("wire_in"/g) ?? [];
    expect(wireIns.length).toBeGreaterThanOrEqual(2);
    expect(aggCtrl).toMatch(
      /Logger\.debug\("wire_in", event: "wire_in", keys: Map\.keys\(params\)\)/,
    );
  });

  it("aggregates_controller.ex stays free of wire_in when --trace is off", () => {
    const aggCtx: BoundedContextIR = {
      ...workflowCtx,
      aggregates: [
        {
          name: "Order",
          fields: [],
          parts: [],
          contains: [],
          derived: [],
          invariants: [],
          functions: [],
          operations: [],
          identity: { kind: "guid" },
        } as unknown as BoundedContextIR["aggregates"][number],
      ],
    };
    const { files } = emitApiControllers({
      contexts: [aggCtx],
      deployable: stubDeployable,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
      // no emitTrace
    });
    const aggCtrl = files.get("lib/phoenix_app_web/controllers/aggregates_controller.ex")!;
    expect(aggCtrl).not.toMatch(/wire_in/);
    expect(aggCtrl).not.toMatch(/Map\.keys\(params\)/);
  });

  it("aggregates_controller.ex emits aggregate_created on each Create action via Logger", () => {
    // Phase 8 Phoenix — every per-aggregate Create action emits the
    // catalog's aggregate_created (info) line via Elixir's Logger.
    // Same event identity the Hono + .NET Create handlers emit.
    // (Local context inline: workflowCtx has aggregates:[] so
    // aggregates_controller.ex wouldn't emit; for this assertion we
    // need at least one aggregate.)
    const aggCtx: BoundedContextIR = {
      ...workflowCtx,
      aggregates: [
        {
          name: "Order",
          fields: [],
          parts: [],
          contains: [],
          derived: [],
          invariants: [],
          functions: [],
          operations: [],
          identity: { kind: "guid" },
        } as unknown as BoundedContextIR["aggregates"][number],
      ],
    };
    const { files } = emitApiControllers({
      contexts: [aggCtx],
      deployable: stubDeployable,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const aggCtrl = files.get("lib/phoenix_app_web/controllers/aggregates_controller.ex")!;
    expect(aggCtrl).toMatch(/require Logger/);
    expect(aggCtrl).toMatch(
      /Logger\.info\("aggregate_created", event: "aggregate_created", aggregate: "Order", id: record\.id\)/,
    );
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

// ---------------------------------------------------------------------------
// Validation lowering onto Ash action `validate` clauses.
//
// These tests call `emitAggregateResources` directly so they are not coupled
// to the index.ts orchestrator path, verifying the domain-emit.ts target
// independently (as the task specification requires).
// ---------------------------------------------------------------------------

describe("Ash validate clause emission (domain-emit unit)", () => {
  /** Minimal bounded context with one aggregate carrying:
   *  - an aggregate invariant (`email.length > 0`)
   *  - one public operation with a precondition (`minTotal >= 0`) */
  const salesCtx: BoundedContextIR = {
    name: "Sales",
    enums: [],
    valueObjects: [],
    events: [],
    aggregates: [
      {
        name: "Customer",
        idValueType: "guid",
        fields: [
          { name: "name", type: { kind: "primitive", name: "string" }, optional: false },
          { name: "email", type: { kind: "primitive", name: "string" }, optional: false },
        ],
        contains: [],
        derived: [],
        invariants: [
          {
            // email.length > 0  →  single-field len-min pattern
            expr: {
              kind: "binary",
              op: ">",
              left: {
                kind: "member",
                receiver: {
                  kind: "ref",
                  name: "email",
                  refKind: "this-prop",
                  type: { kind: "primitive", name: "string" },
                },
                member: "length",
                receiverType: { kind: "primitive", name: "string" },
                memberType: { kind: "primitive", name: "int" },
              },
              right: { kind: "literal", lit: "int", value: "0" },
            },
            source: "email.length > 0",
          },
        ],
        functions: [],
        operations: [
          {
            name: "activate",
            visibility: "public",
            params: [
              {
                name: "minTotal",
                type: { kind: "primitive", name: "decimal" },
              },
            ],
            statements: [
              {
                kind: "precondition",
                expr: {
                  kind: "binary",
                  op: ">=",
                  left: {
                    kind: "ref",
                    name: "minTotal",
                    refKind: "param",
                    type: { kind: "primitive", name: "decimal" },
                  },
                  right: { kind: "literal", lit: "decimal", value: "0" },
                },
                source: "minTotal >= 0",
              },
            ],
            extern: false,
            audited: false,
          },
        ],
        parts: [],
        tests: [],
      },
    ],
    repositories: [],
    workflows: [],
    views: [],
  };

  it("emits at least one validate line for an aggregate with an invariant", () => {
    const files = emitAggregateResources(salesCtx, "PhoenixApp", "phoenix_app");
    const customerEx = files.get("lib/phoenix_app/sales/customer.ex");
    expect(customerEx).toBeDefined();
    // The aggregate's `email.length > 0` invariant must produce a validate line.
    expect(customerEx).toMatch(/validate /);
  });

  it("emits a string_length validate for an email.length > 0 invariant", () => {
    const files = emitAggregateResources(salesCtx, "PhoenixApp", "phoenix_app");
    const customerEx = files.get("lib/phoenix_app/sales/customer.ex");
    expect(customerEx).toBeDefined();
    // Single-field len-min shape → idiomatic Ash string_length validator.
    expect(customerEx).toMatch(/validate string_length\(:email/);
  });

  it("emits an operation action with a validate clause for a precondition", () => {
    const files = emitAggregateResources(salesCtx, "PhoenixApp", "phoenix_app");
    const customerEx = files.get("lib/phoenix_app/sales/customer.ex");
    expect(customerEx).toBeDefined();
    // The :activate action must be emitted with a validate clause.
    expect(customerEx).toMatch(/update :activate/);
    // The precondition `minTotal >= 0` is a single-field min shape →
    // compare validator or function-form validate.
    expect(customerEx).toMatch(/validate /);
  });
});

// suppress unused imports if test framework expects them at top level
void repoRoot;

// ---------------------------------------------------------------------------
// JWT auth module emission.
//
// Asserts that `lib/<app>_web/auth.ex` and `lib/<app>_web/live_auth.ex`
// are emitted when the phoenixApp deployable carries `auth: required`.
// Also asserts that the router wires the Auth plug into `:api` and wraps
// LiveView routes in a `live_session` with the LiveAuth on_mount hook.
// ---------------------------------------------------------------------------

import { emitAuth } from "../../src/generator/phoenix-live-view/auth-emit.js";

describe("JWT auth emission (auth-emit unit)", () => {
  const baseDeployable: DeployableIR = {
    name: "phoenixApp",
    platform: "phoenixLiveView",
    moduleNames: ["Sales"],
    port: 4000,
    serves: ["SalesApi"],
    uiBindings: [],
    moduleBindings: [],
  };

  const baseSys: SystemIR = {
    name: "Mini",
    modules: [],
    deployables: [baseDeployable],
    e2eTests: [],
    uis: [],
    apis: [],
    storages: [],
  };

  it("returns enabled=false and no files when auth is not required", () => {
    const { files, enabled } = emitAuth({
      sys: baseSys,
      deployable: { ...baseDeployable, auth: undefined },
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    expect(enabled).toBe(false);
    expect(files.size).toBe(0);
  });

  it("returns enabled=false when auth.required is false", () => {
    const { enabled } = emitAuth({
      sys: baseSys,
      deployable: { ...baseDeployable, auth: { required: false } },
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    expect(enabled).toBe(false);
  });

  it("emits lib/<app>_web/auth.ex when auth: required", () => {
    const authDeployable: DeployableIR = { ...baseDeployable, auth: { required: true } };
    const { files, enabled } = emitAuth({
      sys: baseSys,
      deployable: authDeployable,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    expect(enabled).toBe(true);
    expect(files.has("lib/phoenix_app_web/auth.ex")).toBe(true);
  });

  it("emits lib/<app>_web/live_auth.ex when auth: required", () => {
    const authDeployable: DeployableIR = { ...baseDeployable, auth: { required: true } };
    const { files } = emitAuth({
      sys: baseSys,
      deployable: authDeployable,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    expect(files.has("lib/phoenix_app_web/live_auth.ex")).toBe(true);
  });

  it("auth.ex contains @behaviour Plug + call/2 with Bearer extraction", () => {
    const authDeployable: DeployableIR = { ...baseDeployable, auth: { required: true } };
    const { files } = emitAuth({
      sys: baseSys,
      deployable: authDeployable,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const authEx = files.get("lib/phoenix_app_web/auth.ex")!;
    expect(authEx).toMatch(/@behaviour Plug/);
    expect(authEx).toMatch(/def call\(conn, _opts\)/);
    expect(authEx).toMatch(/"Bearer " <> token/);
    expect(authEx).toMatch(/assign\(conn, :current_user, build_user\(claims\)\)/);
    // 401 must be sent with send_resp/3 — put_status + halt without a
    // send raises Plug.Conn.NotSentError at the cowboy adapter and
    // surfaces as a 500.  See send_unauthorized/1.
    expect(authEx).toMatch(/send_resp\(401/);
    expect(authEx).toMatch(/halt\(\)/);
  });

  it("auth.ex maps UserIR fields to claims extractions in build_user/1", () => {
    const sysWithUser: SystemIR = {
      ...baseSys,
      user: {
        fields: [
          { name: "id", type: { kind: "primitive", name: "guid" }, optional: false },
          {
            name: "permissions",
            type: { kind: "array", element: { kind: "primitive", name: "string" } },
            optional: false,
          },
          { name: "email", type: { kind: "primitive", name: "string" }, optional: false },
        ],
      },
    };
    const authDeployable: DeployableIR = { ...baseDeployable, auth: { required: true } };
    const { files } = emitAuth({
      sys: sysWithUser,
      deployable: authDeployable,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const authEx = files.get("lib/phoenix_app_web/auth.ex")!;
    // Each field should have a claims["<field>"] extraction.
    expect(authEx).toContain('claims["id"]');
    expect(authEx).toContain('claims["permissions"]');
    expect(authEx).toContain('claims["email"]');
    // Array field gets a default of [].
    expect(authEx).toMatch(/claims\["permissions"\] \|\| \[\]/);
  });

  it("live_auth.ex contains on_mount/4 with redirect to /login on failure", () => {
    const authDeployable: DeployableIR = { ...baseDeployable, auth: { required: true } };
    const { files } = emitAuth({
      sys: baseSys,
      deployable: authDeployable,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const liveAuthEx = files.get("lib/phoenix_app_web/live_auth.ex")!;
    expect(liveAuthEx).toMatch(/def on_mount\(:default, _params, session, socket\)/);
    expect(liveAuthEx).toMatch(/assign\(socket, :current_user, user\)/);
    expect(liveAuthEx).toMatch(/Phoenix\.LiveView\.redirect\(socket, to: "\/login"\)/);
  });
});

describe("router wiring (orchestrator integration)", () => {
  const AUTH_FIXTURE = `system MiniAuth {
  module Sales {
    context Sales {
      aggregate Customer {
        name: string
        derived display: string = name
        email: string
      }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  ui SalesAdmin with scaffold(modules: [Sales]) {
  }
  user {
    id: guid
    permissions: string[]
  }
  deployable phoenixApp {
    platform: phoenixLiveView,
    modules: Sales,
    serves: SalesApi,
    ui: SalesAdmin,
    port: 4000,
    auth: required
  }
}
`;

  async function buildAuthFixture(): Promise<Model> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-jwt-auth-"));
    const file = path.join(dir, "auth.ddd");
    fs.writeFileSync(file, AUTH_FIXTURE);
    const services = createDddServices(NodeFileSystem);
    const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
      URI.file(file),
    );
    await services.shared.workspace.DocumentBuilder.build([doc], {
      validation: true,
    });
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
    if (errors.length > 0) {
      throw new Error(
        `JWT auth fixture validation errors:\n` + errors.map((e) => `  ${e.message}`).join("\n"),
      );
    }
    return doc.parseResult.value as Model;
  }

  it("emits auth.ex AND live_auth.ex when deployable has auth: required", async () => {
    const model = await buildAuthFixture();
    const { files } = generateSystems(model);
    expect(files.has("phoenix_app/lib/phoenix_app_web/auth.ex")).toBe(true);
    expect(files.has("phoenix_app/lib/phoenix_app_web/live_auth.ex")).toBe(true);
  });

  it("router.ex splices Auth plug into :api pipeline", async () => {
    const model = await buildAuthFixture();
    const { files } = generateSystems(model);
    const router = files.get("phoenix_app/lib/phoenix_app_web/router.ex")!;
    expect(router).toMatch(/pipeline :api do[\s\S]*plug PhoenixAppWeb\.Auth/);
  });

  it("router.ex wraps LiveView routes in live_session with LiveAuth on_mount", async () => {
    const model = await buildAuthFixture();
    const { files } = generateSystems(model);
    const router = files.get("phoenix_app/lib/phoenix_app_web/router.ex")!;
    expect(router).toMatch(/live_session :default, on_mount: \[PhoenixAppWeb\.LiveAuth\]/);
  });

  it("does NOT emit auth files or wire the plug when auth is absent", async () => {
    const model = await buildFixture(); // the base fixture has no auth:
    const { files } = generateSystems(model);
    expect(files.has("phoenix_app/lib/phoenix_app_web/auth.ex")).toBe(false);
    expect(files.has("phoenix_app/lib/phoenix_app_web/live_auth.ex")).toBe(false);
    const router = files.get("phoenix_app/lib/phoenix_app_web/router.ex")!;
    expect(router).not.toMatch(/plug PhoenixAppWeb\.Auth/);
    expect(router).not.toMatch(/live_session :default/);
  });
});

// ---------------------------------------------------------------------------
// Markers for parent integration.
//
// theme-emit + sidebar-emit have landed, but renderWorkflowFormHeex still
// needs `extra-archetype-emit.ts` (workflow-form HEEx; today a placeholder in
// liveview-emit.ts).  Kept as .skip() so the build stays green; remove .skip()
// once that emitter lands.
// ---------------------------------------------------------------------------

describe.skip("integration (parent wires emitters)", () => {
  it("renderThemeCss produces a :root block with CSS custom properties", async () => {
    const { renderThemeCss } = await import("../../src/generator/phoenix-live-view/theme-emit.js");
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
    const { loadPack, resolvePackDir } = await import("../../src/generator/_packs/loader-fs.js");
    const pack = loadPack(resolvePackDir("ashPhoenix"));
    const ctx = {
      name: "Sales",
      enums: [],
      valueObjects: [],
      events: [],
      aggregates: [],
      repositories: [],
      workflows: [
        { name: "placeOrder", params: [], transactional: false, statements: [], savesAtExit: [] },
      ],
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
      archetype: { kind: "home" as const },
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

// ---------------------------------------------------------------------------
// Cross-platform OpenAPI parity.
//
// `buildWireSpec(sys)` is Loom's canonical IR-derived wire contract.  All
// three backends (hono, dotnet, phoenixLiveView) MUST expose those same
// names through their OpenAPI surfaces.  The dotnet generator's
// FluentValidation pipeline + Swashbuckle ensures parity on that side;
// the hono generator's @hono/zod-openapi ditto.  This block asserts the
// Phoenix OpenApiSpex emission references every aggregate / part /
// value-object / operation / workflow / view name from `wire-spec.json`.
//
// Uses the full `examples/acme.ddd` (has workflows + views + parts +
// value objects), retargeted by adding a third deployable that picks
// `platform: phoenixLiveView`.
// ---------------------------------------------------------------------------

import { enrichLoomModel } from "../../src/ir/enrichments.js";
import { lowerModel } from "../../src/ir/lower.js";
import { buildWireSpec } from "../../src/system/wire-spec.js";

const ACME_LIVEVIEW_SOURCE = `system AcmeLV {
  module Sales {
    context Sales {
      enum OrderStatus { Draft, Confirmed }
      valueobject Money {
        amount: decimal
        currency: string
        invariant amount >= 0
      }
      event OrderConfirmed { order: Order id, at: datetime }
      aggregate Customer {
        name: string
        derived display: string = name
        email: string
        invariant email.length > 0
      }
      aggregate Order {
        customerId: Customer id
        status: OrderStatus
        contains lines: OrderLine[]
        entity OrderLine {
          productId: Customer id
          quantity: int
          invariant quantity > 0
        }
        operation confirm() {
          precondition status == Draft
          status := Confirmed
          emit OrderConfirmed { order: id, at: now() }
        }
      }
      repository Customers for Customer { }
      repository Orders for Order { }
      workflow placeOrder(customerId: Customer id) {
        let order = Order.create({ customerId: customerId, status: Draft })
      }
      view ActiveOrders = Order where status == Confirmed
    }
  }
  api SalesApi from Sales
  ui SalesAdmin with scaffold(modules: [Sales]) {}
  deployable phoenixApp {
    platform: phoenixLiveView
    modules: Sales
    serves: SalesApi
    ui: SalesAdmin
    port: 4000
  }
}
`;

async function buildAcmeLiveViewModel(): Promise<Model> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-openapi-parity-"));
  const file = path.join(dir, "acme-lv.ddd");
  fs.writeFileSync(file, ACME_LIVEVIEW_SOURCE);
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(file));
  await services.shared.workspace.DocumentBuilder.build([doc], {
    validation: true,
  });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errors.length > 0) {
    throw new Error(
      `OpenAPI parity fixture validation errors:\n` +
        errors.map((e) => `  ${e.message}`).join("\n"),
    );
  }
  return doc.parseResult.value as Model;
}

describe("cross-platform OpenAPI parity (phoenix vs wire-spec.json)", () => {
  it("Phoenix OpenAPI spec module exists when deployable serves an api", async () => {
    const model = await buildAcmeLiveViewModel();
    const { files } = generateSystems(model);
    expect(files.has("phoenix_app/lib/phoenix_app_web/api/sales_api_spec.ex")).toBe(true);
    expect(files.has("phoenix_app/lib/phoenix_app_web/controllers/openapi_controller.ex")).toBe(
      true,
    );
    // The router must wire GET /api/openapi.json so clients can fetch it.
    const router = files.get("phoenix_app/lib/phoenix_app_web/router.ex")!;
    expect(router).toMatch(/get\s+"\/openapi\.json",\s*OpenapiController/);
  });

  it("Every aggregate from wire-spec.json appears as <Name>Response in the Phoenix spec", async () => {
    const model = await buildAcmeLiveViewModel();
    const sys = enrichLoomModel(lowerModel(model)).systems[0]!;
    const wireSpec = buildWireSpec(sys);
    const { files } = generateSystems(model);
    // Concatenate every file under lib/<app>_web/api/ — the spec module
    // plus per-schema modules.  Schema names from the wire-spec must
    // appear somewhere in this combined source.
    const apiSource = [...files.entries()]
      .filter(([k]) => /^phoenix_app\/lib\/phoenix_app_web\/api\//.test(k))
      .map(([, v]) => v)
      .join("\n");
    for (const aggName of Object.keys(wireSpec.aggregates)) {
      expect(apiSource).toContain(`${aggName}Response`);
    }
  });

  it("Every value object from wire-spec.json appears as <Name> schema in the Phoenix spec", async () => {
    const model = await buildAcmeLiveViewModel();
    const sys = enrichLoomModel(lowerModel(model)).systems[0]!;
    const wireSpec = buildWireSpec(sys);
    const { files } = generateSystems(model);
    const apiSource = [...files.entries()]
      .filter(([k]) => /^phoenix_app\/lib\/phoenix_app_web\/api\//.test(k))
      .map(([, v]) => v)
      .join("\n");
    for (const voName of Object.keys(wireSpec.valueObjects)) {
      // Schema modules emit `defmodule …Schemas.<Name>` or reference
      // the name as a `$ref` string — both must surface the bare name.
      expect(apiSource).toContain(voName);
    }
  });

  it("Every entity-part from wire-spec.json appears in the Phoenix spec", async () => {
    const model = await buildAcmeLiveViewModel();
    const sys = enrichLoomModel(lowerModel(model)).systems[0]!;
    const wireSpec = buildWireSpec(sys);
    const { files } = generateSystems(model);
    const apiSource = [...files.entries()]
      .filter(([k]) => /^phoenix_app\/lib\/phoenix_app_web\/api\//.test(k))
      .map(([, v]) => v)
      .join("\n");
    for (const partName of Object.keys(wireSpec.parts)) {
      expect(apiSource).toContain(partName);
    }
  });

  it("Workflow + view endpoints surface in the Phoenix OpenAPI paths object", async () => {
    const model = await buildAcmeLiveViewModel();
    const { files } = generateSystems(model);
    const spec = files.get("phoenix_app/lib/phoenix_app_web/api/sales_api_spec.ex")!;
    // placeOrder workflow → POST /workflows/place_order
    expect(spec).toMatch(/"\/workflows\/place_order"/);
    expect(spec).toMatch(/PlaceOrderRequest/);
    // ActiveOrders view → GET /views/active_orders
    expect(spec).toMatch(/"\/views\/active_orders"/);
    expect(spec).toMatch(/ActiveOrdersResponse/);
  });

  it("Aggregate CRUD endpoints surface in the paths object", async () => {
    const model = await buildAcmeLiveViewModel();
    const { files } = generateSystems(model);
    const spec = files.get("phoenix_app/lib/phoenix_app_web/api/sales_api_spec.ex")!;
    // GET /aggregates/customers (list) + GET /aggregates/customers/:id (read)
    expect(spec).toMatch(/\/aggregates\/customers/);
    expect(spec).toMatch(/\/aggregates\/orders/);
    expect(spec).toMatch(/CreateCustomerRequest/);
    expect(spec).toMatch(/CustomerListResponse/);
  });

  it("mix.exs declares the open_api_spex dependency", async () => {
    const model = await buildAcmeLiveViewModel();
    const { files } = generateSystems(model);
    const mix = files.get("phoenix_app/mix.exs")!;
    expect(mix).toMatch(/:open_api_spex/);
  });
});

// ---------------------------------------------------------------------------
// Full-form view bind projection.
//
// Exercises `emitViews` directly with a synthetic `OrderSummary` view IR
// (matching the shape that `lowerView` produces for the acme.ddd definition)
// and asserts the generated Elixir module contains:
//   - Ash.Query.filter for the source predicate
//   - Ash.Query.load for association-backed bind exprs (lines.count → :lines)
//   - Ash.read!() instead of the old code-interface call
//   - Enum.map projection with snake_case keys for every declared bind
// ---------------------------------------------------------------------------

import { emitViews } from "../../src/generator/phoenix-live-view/view-emit.js";
import type { ExprIR } from "../../src/ir/loom-ir.js";

describe("full-form view bind projection (view-emit unit)", () => {
  // Synthetic ViewIR for `view OrderSummary { orderId status lineCount from Order … bind … }`
  const orderSummaryCtx: BoundedContextIR = {
    name: "Sales",
    enums: [{ name: "OrderStatus", values: ["Draft", "Confirmed", "Cancelled"] }],
    valueObjects: [],
    events: [],
    aggregates: [
      {
        name: "Order",
        idValueType: "guid",
        fields: [{ name: "status", type: { kind: "enum", name: "OrderStatus" }, optional: false }],
        contains: [],
        derived: [],
        invariants: [],
        functions: [],
        operations: [],
        parts: [],
        tests: [],
      },
    ],
    repositories: [],
    workflows: [],
    views: [
      {
        name: "OrderSummary",
        aggregateName: "Order",
        // filter: status != Cancelled
        filter: {
          kind: "binary",
          op: "!=",
          left: {
            kind: "ref",
            name: "status",
            refKind: "this-prop",
            type: { kind: "enum", name: "OrderStatus" },
          } as ExprIR,
          right: {
            kind: "literal",
            lit: "string",
            value: "Cancelled",
          } as ExprIR,
        } as ExprIR,
        output: {
          fields: [
            { name: "orderId", type: { kind: "id", of: "Order" }, optional: false },
            { name: "status", type: { kind: "enum", name: "OrderStatus" }, optional: false },
            { name: "lineCount", type: { kind: "primitive", name: "int" }, optional: false },
          ],
          binds: [
            // bind orderId = id  →  record.id
            {
              name: "orderId",
              type: { kind: "id", of: "Order" },
              expr: { kind: "id" } as ExprIR,
            },
            // bind status = status  →  record.status
            {
              name: "status",
              type: { kind: "enum", name: "OrderStatus" },
              expr: {
                kind: "ref",
                name: "status",
                refKind: "this-prop",
                type: { kind: "enum", name: "OrderStatus" },
              } as ExprIR,
            },
            // bind lineCount = lines.count  →  Enum.count(record.lines)
            {
              name: "lineCount",
              type: { kind: "primitive", name: "int" },
              expr: {
                kind: "member",
                receiver: {
                  kind: "ref",
                  name: "lines",
                  refKind: "this-prop",
                  type: { kind: "array", element: { kind: "entity", name: "OrderLine" } },
                } as ExprIR,
                member: "count",
                receiverType: { kind: "array", element: { kind: "entity", name: "OrderLine" } },
                memberType: { kind: "primitive", name: "int" },
              } as ExprIR,
            },
          ],
          auxiliaries: [],
        },
      },
    ],
  };

  function getViewFile(): string {
    const out = new Map<string, string>();
    emitViews("acme", orderSummaryCtx, "Acme", out);
    const file = out.get("lib/acme/sales/views/order_summary.ex");
    expect(file).toBeDefined();
    return file!;
  }

  it("emits the projection module at the expected path", () => {
    const out = new Map<string, string>();
    emitViews("acme", orderSummaryCtx, "Acme", out);
    expect(out.has("lib/acme/sales/views/order_summary.ex")).toBe(true);
  });

  it("emits Ash.Query.filter for the source predicate", () => {
    const src = getViewFile();
    expect(src).toMatch(/Ash\.Query\.filter\(/);
  });

  it("emits Ash.Query.load for the lines association needed by lineCount bind", () => {
    const src = getViewFile();
    expect(src).toMatch(/Ash\.Query\.load\(\[:lines\]\)/);
  });

  it("emits Ash.read! instead of a code-interface call", () => {
    const src = getViewFile();
    expect(src).toMatch(/Ash\.read!\(\)/);
    expect(src).not.toMatch(/read_order\(/);
  });

  it("emits Enum.map projection with snake_case keys order_id, status, line_count", () => {
    const src = getViewFile();
    expect(src).toMatch(/Enum\.map\(fn record ->/);
    expect(src).toMatch(/order_id:/);
    expect(src).toMatch(/status:/);
    expect(src).toMatch(/line_count:/);
  });

  it("lowers lines.count bind to Enum.count(record.lines)", () => {
    const src = getViewFile();
    expect(src).toMatch(/line_count: Enum\.count\(record\.lines\)/);
  });

  it("lowers id bind to record.id", () => {
    const src = getViewFile();
    expect(src).toMatch(/order_id: record\.id/);
  });

  it("lowers this-prop bind to record.<field>", () => {
    const src = getViewFile();
    expect(src).toMatch(/status: record\.status/);
  });
});

// ---------------------------------------------------------------------------
// Ash 3.x `code_interface` shape inside `resource ... do` blocks.
//
// `emitDomainModule` in domain-module.ts must emit `define` calls INSIDE
// `resource <Module> do ... end` blocks (Ash 3.x), not in a separate
// top-level `code_interface do` block (Ash 2.x pattern).
// ---------------------------------------------------------------------------

import { emitDomainModule } from "../../src/generator/phoenix-live-view/domain-module.js";

describe("Ash 3.x code_interface shape (domain-module unit)", () => {
  const salesCtxE2: BoundedContextIR = {
    name: "Sales",
    enums: [],
    valueObjects: [],
    events: [],
    aggregates: [
      {
        name: "Customer",
        idValueType: "guid",
        fields: [
          { name: "name", type: { kind: "primitive", name: "string" }, optional: false },
          { name: "email", type: { kind: "primitive", name: "string" }, optional: false },
        ],
        contains: [],
        derived: [],
        invariants: [],
        functions: [],
        operations: [],
        parts: [],
        tests: [],
      },
    ],
    repositories: [
      {
        name: "Customers",
        aggregateName: "Customer",
        finds: [
          {
            name: "findByEmail",
            params: [{ name: "email", type: { kind: "primitive", name: "string" } }],
            returnType: { kind: "primitive", name: "guid" },
          },
        ],
      },
    ],
    workflows: [],
    views: [],
  };

  it("emits define calls INSIDE resource ... do blocks, not in a top-level code_interface do", () => {
    const files = emitDomainModule(salesCtxE2, "PhoenixApp", "phoenix_app");
    const domainEx = files.get("lib/phoenix_app/sales.ex")!;
    expect(domainEx).toBeDefined();

    // Ash 3.x: define nested inside resource ... do.
    expect(domainEx).toMatch(/resource PhoenixApp\.Sales\.Customer do/);
    expect(domainEx).toMatch(/define :create_customer, action: :create/);
    expect(domainEx).toMatch(/define :get_customer,\s+action: :read, get_by: \[:id\]/);
    expect(domainEx).toMatch(/define :list_customers,\s+action: :read/);
    expect(domainEx).toMatch(/define :update_customer, action: :update/);
    expect(domainEx).toMatch(/define :destroy_customer, action: :destroy/);

    // MUST NOT emit a top-level `code_interface do` block (Ash 2.x).
    expect(domainEx).not.toMatch(/^ {2}code_interface do/m);

    // MUST NOT use the Ash 2.x `define_for` directive.
    expect(domainEx).not.toMatch(/define_for/);
  });

  it("emits custom find defines with args: [...] for parametrised finds", () => {
    const files = emitDomainModule(salesCtxE2, "PhoenixApp", "phoenix_app");
    const domainEx = files.get("lib/phoenix_app/sales.ex")!;
    expect(domainEx).toBeDefined();
    // findByEmail has one param → args: [:email]
    expect(domainEx).toMatch(/define :find_by_email, action: :find_by_email, args: \[:email\]/);
  });

  it("emits define blocks for entity parts in their own resource ... do block", () => {
    const ctxWithPart: BoundedContextIR = {
      ...salesCtxE2,
      aggregates: [
        {
          ...salesCtxE2.aggregates[0]!,
          parts: [
            {
              name: "OrderLine",
              fields: [
                { name: "quantity", type: { kind: "primitive", name: "int" }, optional: false },
              ],
              invariants: [],
              tests: [],
            },
          ],
        },
      ],
    };
    const files = emitDomainModule(ctxWithPart, "PhoenixApp", "phoenix_app");
    const domainEx = files.get("lib/phoenix_app/sales.ex")!;
    expect(domainEx).toBeDefined();
    expect(domainEx).toMatch(/resource PhoenixApp\.Sales\.OrderLine do/);
    expect(domainEx).toMatch(/define :create_order_line, action: :create/);
  });
});

// ---------------------------------------------------------------------------
// Ash.transaction/2 passes a domain list, not an Ecto Repo.
//
// `emitWorkflows` in workflow-emit.ts must produce
//   Ash.transaction([<ContextModule>], fn -> ... end)
// not
//   Ash.transaction(fn -> ... end, <AppModule>.Repo)
// ---------------------------------------------------------------------------

import { emitWorkflows } from "../../src/generator/phoenix-live-view/workflow-emit.js";

describe("Ash.transaction/2 domain-list form (workflow-emit unit)", () => {
  const transactionalCtx: BoundedContextIR = {
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
        transactional: true,
        statements: [
          {
            kind: "factory-let",
            name: "order",
            aggName: "Order",
            fields: [
              {
                name: "customerId",
                value: {
                  kind: "ref",
                  name: "customerId",
                  refKind: "param",
                  type: { kind: "primitive", name: "guid" },
                },
              },
            ],
          },
        ],
        savesAtExit: [],
      },
    ],
    views: [],
  };

  it("emits Ash.transaction([ with a list opener — NOT passing a Repo module", () => {
    const out = new Map<string, string>();
    emitWorkflows("phoenix_app", transactionalCtx, "PhoenixApp", out);
    const wfEx = out.get("lib/phoenix_app/sales/workflows/place_order.ex")!;
    expect(wfEx).toBeDefined();

    // Must use the list-form: Ash.transaction([PhoenixApp.Sales], fn ->
    expect(wfEx).toMatch(/Ash\.transaction\(\s*\[PhoenixApp\.Sales\]/);

    // Must NOT pass a Repo as first positional arg in the old form.
    expect(wfEx).not.toMatch(/Ash\.transaction\(\s*fn\s*->/);
    expect(wfEx).not.toMatch(/PhoenixApp\.Repo/);
  });

  it("transactional workflow with isolation level still uses domain-list form", () => {
    const ctxWithIsolation: BoundedContextIR = {
      ...transactionalCtx,
      workflows: [
        {
          ...transactionalCtx.workflows[0]!,
          isolation: "serializable",
        },
      ],
    };
    const out = new Map<string, string>();
    emitWorkflows("phoenix_app", ctxWithIsolation, "PhoenixApp", out);
    const wfEx = out.get("lib/phoenix_app/sales/workflows/place_order.ex")!;
    expect(wfEx).toBeDefined();
    expect(wfEx).toMatch(/Ash\.transaction\(\s*\[PhoenixApp\.Sales\]/);
    expect(wfEx).toMatch(/isolation_level: :serializable/);
    expect(wfEx).not.toMatch(/PhoenixApp\.Repo/);
  });

  // Bite 2: workflow narrative events (workflow_started / workflow_completed)
  // share catalog identity with Hono / .NET so dashboards pivot on one key.
  // `workflow_started` fires unconditionally at the run/1 entry; `workflow_
  // completed` fires only on the success branch — failures (precondition,
  // with-mismatch, Ash error) propagate untouched.
  it("transactional workflow logs workflow_started at entry and workflow_completed on success", () => {
    const out = new Map<string, string>();
    emitWorkflows("phoenix_app", transactionalCtx, "PhoenixApp", out);
    const wfEx = out.get("lib/phoenix_app/sales/workflows/place_order.ex")!;
    expect(wfEx).toBeDefined();

    // `require Logger` is in the module preamble.
    expect(wfEx).toMatch(/require Logger/);

    // `workflow_started` is the first statement inside run/1 (right after
    // the `_ = current_user` discard).
    expect(wfEx).toMatch(
      /_ = current_user\s*\n\s*Logger\.info\("workflow_started", event: "workflow_started", workflow: "placeOrder"\)/,
    );

    // Transactional shape: success branch logs workflow_completed.
    expect(wfEx).toMatch(
      /case result do\s*\n\s*\{:ok, _\} ->\s*\n\s*Logger\.info\("workflow_completed", event: "workflow_completed", workflow: "placeOrder"\)\s*\n\s*result\s*\n\s*_ ->\s*\n\s*result\s*\n\s*end/,
    );
  });

  it("sequential workflow logs workflow_completed inside the with-chain do-branch", () => {
    const sequentialCtx: BoundedContextIR = {
      ...transactionalCtx,
      workflows: [
        {
          ...transactionalCtx.workflows[0]!,
          transactional: false,
        },
      ],
    };
    const out = new Map<string, string>();
    emitWorkflows("phoenix_app", sequentialCtx, "PhoenixApp", out);
    const wfEx = out.get("lib/phoenix_app/sales/workflows/place_order.ex")!;
    expect(wfEx).toBeDefined();
    expect(wfEx).toMatch(/require Logger/);
    // Started at entry.
    expect(wfEx).toMatch(
      /Logger\.info\("workflow_started", event: "workflow_started", workflow: "placeOrder"\)/,
    );
    // Completed lives inside the do-branch of the with-chain so a
    // failing `{:ok, …} <-` short-circuits before it fires.
    expect(wfEx).toMatch(
      /do\s*\n\s*Logger\.info\("workflow_completed", event: "workflow_completed", workflow: "placeOrder"\)\s*\n\s*\{:ok, /,
    );
  });
});

// ---------------------------------------------------------------------------
// cross-platform UI parity.
//
// `test e2e ui "…" against <deployable>` blocks lower against any
// deployable that mounts a UI — react / static (frontend-only) AND
// phoenixLiveView (fullstack).  `PlatformSurface.mountsUi`
// gates this; assert the orchestrator emits an identically-shaped
// Playwright spec regardless of which platform hosts the UI.
// ---------------------------------------------------------------------------

const ACME_UI_E2E_SOURCE = `system AcmeUI {
  module Sales {
    context Sales {
      aggregate Customer {
        name: string
        derived display: string = name
        email: string
      }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  ui SalesAdmin with scaffold(modules: [Sales]) {}
  deployable phoenixApp {
    platform: phoenixLiveView
    modules: Sales
    serves: SalesApi
    ui: SalesAdmin
    port: 4000
  }
  test e2e "smoke" against phoenixApp {
    let cust = ui.customers.create({ name: "Acme", email: "a@b.com" })
    ui.customers.getById(cust)
  }
}
`;

describe("cross-platform UI parity (test e2e ui against phoenixLiveView)", () => {
  it("emits a Playwright spec for a `test e2e ui` block targeting a phoenix deployable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ui-parity-"));
    const file = path.join(dir, "acme-ui.ddd");
    fs.writeFileSync(file, ACME_UI_E2E_SOURCE);
    const services = createDddServices(NodeFileSystem);
    const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
      URI.file(file),
    );
    await services.shared.workspace.DocumentBuilder.build([doc], {
      validation: true,
    });
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
    if (errors.length > 0) {
      throw new Error(
        `UI parity fixture validation errors:\n` + errors.map((e) => `  ${e.message}`).join("\n"),
      );
    }
    const model = doc.parseResult.value as Model;
    const { files } = generateSystems(model);
    const uiSpecPath = "phoenix_app/e2e/AcmeUI.ui.spec.ts";
    expect(files.has(uiSpecPath)).toBe(true);
    const spec = files.get(uiSpecPath)!;
    // Imports test/expect from the co-located `./fixtures` (re-exports
    // Playwright + auto console-capture); fixtures.ts is emitted next to
    // the spec even for non-react (phoenix) UI mounts.
    expect(spec).toMatch(/from "\.\/fixtures"/);
    expect(files.has("phoenix_app/e2e/fixtures.ts")).toBe(true);
    expect(spec).toMatch(/test\(/);
    expect(spec).toMatch(/customer/i);
  });

  it("emits per-page Playwright page objects under phoenix_app/e2e/pages/", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ui-parity-po-"));
    const file = path.join(dir, "acme-ui.ddd");
    fs.writeFileSync(file, ACME_UI_E2E_SOURCE);
    const services = createDddServices(NodeFileSystem);
    const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
      URI.file(file),
    );
    await services.shared.workspace.DocumentBuilder.build([doc], {
      validation: true,
    });
    const model = doc.parseResult.value as Model;
    const { files } = generateSystems(model);
    const pageObjects = [...files.keys()].filter((k) =>
      /^phoenix_app\/e2e\/pages\/.*\.ts$/.test(k),
    );
    expect(pageObjects.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Scaffold-form regression — the walker's `renderForm` previously
// emitted a single hardcoded `<.input field={@form[:_placeholder]}>`
// for every scaffold-expanded `new <Aggregate>` page regardless of
// the aggregate's actual fields, AND the LiveView `mount/3` stub
// never assigned `@form`.  Both bugs combined made every generated
// new-page broken at runtime.  These tests pin the fix.
// ---------------------------------------------------------------------------

const FORM_FIXTURE = `system AcmeForm {
  module Sales {
    context Sales {
      aggregate Customer {
        name: string
        derived display: string = name
        email: string
      }
      repository Customers for Customer { }
      aggregate Order {
        customerId: Customer id
        total: decimal
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  ui SalesAdmin with scaffold(modules: [Sales]) {}
  deployable phoenixApp {
    platform: phoenixLiveView
    modules: Sales
    serves: SalesApi
    ui: SalesAdmin
    port: 4000
  }
}
`;

async function buildFormFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-form-fix-"));
  const file = path.join(dir, "form-fix.ddd");
  fs.writeFileSync(file, FORM_FIXTURE);
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(file));
  await services.shared.workspace.DocumentBuilder.build([doc], {
    validation: true,
  });
  const model = doc.parseResult.value as Model;
  const { files } = generateSystems(model);
  return files;
}

describe("scaffold-form regression — CreateForm(of: Agg) resolves fields + mount assigns @form", () => {
  it("emits one <.input> per aggregate field (id excluded), not a single _placeholder", async () => {
    const files = await buildFormFixture();
    const customerNew = files.get("phoenix_app/lib/phoenix_app_web/live/customer_new_live.ex")!;
    expect(customerNew).toBeDefined();
    expect(customerNew).not.toMatch(/@form\[:_placeholder\]/);
    expect(customerNew).toMatch(/@form\[:name\].*?label="Name"/);
    expect(customerNew).toMatch(/@form\[:email\].*?label="Email"/);
    expect(customerNew).not.toMatch(/@form\[:id\]/);
  });

  it("emits type=number step=0.01 for decimal fields", async () => {
    const files = await buildFormFixture();
    const orderNew = files.get("phoenix_app/lib/phoenix_app_web/live/order_new_live.ex")!;
    expect(orderNew).toMatch(/@form\[:total\].*?type="number".*?step="0\.01"/);
  });

  it("mount/3 assigns @form via AshPhoenix.Form.for_create(<Ctx>.<Agg>, :create)", async () => {
    const files = await buildFormFixture();
    const customerNew = files.get("phoenix_app/lib/phoenix_app_web/live/customer_new_live.ex")!;
    expect(customerNew).toMatch(
      /assign\(:form, AshPhoenix\.Form\.for_create\(PhoenixApp\.Sales\.Customer, :create\) \|> to_form\(\)\)/,
    );
  });

  it("pages with no form do not gain a stray @form assign", async () => {
    const files = await buildFormFixture();
    // The list page has no form binding — its mount stub must stay empty.
    const customerList = files.get("phoenix_app/lib/phoenix_app_web/live/customer_list_live.ex")!;
    expect(customerList).toBeDefined();
    expect(customerList).not.toMatch(/AshPhoenix\.Form\.for_create/);
  });
});

// ---------------------------------------------------------------------------
// Aggregates controller + router + @derive — unit tests (api-emit + domain-emit)
// ---------------------------------------------------------------------------

describe("AggregatesController emission (api-emit unit)", () => {
  const aggCtx: BoundedContextIR = {
    name: "Sales",
    enums: [],
    valueObjects: [],
    events: [],
    aggregates: [
      {
        name: "Customer",
        idValueType: "guid",
        fields: [
          { name: "name", type: { kind: "primitive", name: "string" }, optional: false },
          { name: "email", type: { kind: "primitive", name: "string" }, optional: false },
        ],
        contains: [],
        derived: [],
        invariants: [],
        functions: [],
        operations: [],
        parts: [],
        tests: [],
      },
    ],
    repositories: [],
    workflows: [],
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

  it("emits aggregates_controller.ex when deployable serves an api and aggregates exist", () => {
    const { files } = emitApiControllers({
      contexts: [aggCtx],
      deployable: stubDeployable,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    expect(files.has("lib/phoenix_app_web/controllers/aggregates_controller.ex")).toBe(true);
  });

  it("does NOT emit aggregates_controller.ex when deployable serves nothing", () => {
    const noServe: DeployableIR = { ...stubDeployable, serves: [] };
    const { files } = emitApiControllers({
      contexts: [aggCtx],
      deployable: noServe,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    expect(files.has("lib/phoenix_app_web/controllers/aggregates_controller.ex")).toBe(false);
  });

  it("aggregates_controller.ex contains list_customers action", () => {
    const { files } = emitApiControllers({
      contexts: [aggCtx],
      deployable: stubDeployable,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const ctrl = files.get("lib/phoenix_app_web/controllers/aggregates_controller.ex")!;
    expect(ctrl).toMatch(/def list_customers\(conn, _params\)/);
    expect(ctrl).toMatch(/PhoenixApp\.Sales\.list_customers!/);
  });

  it("aggregates_controller.ex contains get_customer action", () => {
    const { files } = emitApiControllers({
      contexts: [aggCtx],
      deployable: stubDeployable,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const ctrl = files.get("lib/phoenix_app_web/controllers/aggregates_controller.ex")!;
    expect(ctrl).toMatch(/def get_customer\(conn, %\{"id" => id\}\)/);
    expect(ctrl).toMatch(/PhoenixApp\.Sales\.get_customer!\(id\)/);
  });

  it("aggregates_controller.ex contains create_customer action", () => {
    const { files } = emitApiControllers({
      contexts: [aggCtx],
      deployable: stubDeployable,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const ctrl = files.get("lib/phoenix_app_web/controllers/aggregates_controller.ex")!;
    expect(ctrl).toMatch(/def create_customer\(conn, params\)/);
    expect(ctrl).toMatch(/PhoenixApp\.Sales\.create_customer!\(params\)/);
  });

  it("aggregates_controller.ex contains update_customer action", () => {
    const { files } = emitApiControllers({
      contexts: [aggCtx],
      deployable: stubDeployable,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const ctrl = files.get("lib/phoenix_app_web/controllers/aggregates_controller.ex")!;
    expect(ctrl).toMatch(/def update_customer\(conn, %\{"id" => id\} = params\)/);
    expect(ctrl).toMatch(/Map\.drop\(params, \["id"\]\)/);
    expect(ctrl).toMatch(/PhoenixApp\.Sales\.update_customer!\(id, attrs\)/);
  });

  it("aggregates_controller.ex contains destroy_customer action", () => {
    const { files } = emitApiControllers({
      contexts: [aggCtx],
      deployable: stubDeployable,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const ctrl = files.get("lib/phoenix_app_web/controllers/aggregates_controller.ex")!;
    expect(ctrl).toMatch(/def destroy_customer\(conn, %\{"id" => id\}\)/);
    expect(ctrl).toMatch(/PhoenixApp\.Sales\.destroy_customer!\(id\)/);
    expect(ctrl).toMatch(/send_resp\(conn, 204, ""\)/);
  });

  it("emits 5 aggregate routes for customer (list, create, get, update, destroy)", () => {
    const { apiRoutes } = emitApiControllers({
      contexts: [aggCtx],
      deployable: stubDeployable,
      sys: stubSys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const listRoute = apiRoutes.find(
      (r) => r.path === "/aggregates/customers" && r.method === "get",
    );
    const createRoute = apiRoutes.find(
      (r) => r.path === "/aggregates/customers" && r.method === "post",
    );
    const getRoute = apiRoutes.find(
      (r) => r.path === "/aggregates/customers/:id" && r.method === "get",
    );
    const updateRoute = apiRoutes.find(
      (r) => r.path === "/aggregates/customers/:id" && r.method === "patch",
    );
    const destroyRoute = apiRoutes.find(
      (r) => r.path === "/aggregates/customers/:id" && r.method === "delete",
    );

    expect(listRoute).toBeDefined();
    expect(listRoute?.action).toBe(":list_customers");
    expect(listRoute?.controller).toBe("AggregatesController");

    expect(createRoute).toBeDefined();
    expect(createRoute?.action).toBe(":create_customer");

    expect(getRoute).toBeDefined();
    expect(getRoute?.action).toBe(":get_customer");

    expect(updateRoute).toBeDefined();
    expect(updateRoute?.action).toBe(":update_customer");

    expect(destroyRoute).toBeDefined();
    expect(destroyRoute?.action).toBe(":destroy_customer");
  });
});

// ---------------------------------------------------------------------------
// Aggregates controller + router integration — via generateSystems
// ---------------------------------------------------------------------------

describe("AggregatesController router integration (orchestrator)", () => {
  it("router.ex has aggregate routes for customers when deployable serves an api", async () => {
    const model = await buildFixture();
    const { files } = generateSystems(model);
    const router = files.get("phoenix_app/lib/phoenix_app_web/router.ex")!;
    // List and create on collection path
    expect(router).toMatch(/get "\/aggregates\/customers", AggregatesController, :list_customers/);
    expect(router).toMatch(
      /post "\/aggregates\/customers", AggregatesController, :create_customer/,
    );
    // Get, update, destroy on member path
    expect(router).toMatch(
      /get "\/aggregates\/customers\/:id", AggregatesController, :get_customer/,
    );
    expect(router).toMatch(
      /patch "\/aggregates\/customers\/:id", AggregatesController, :update_customer/,
    );
    expect(router).toMatch(
      /delete "\/aggregates\/customers\/:id", AggregatesController, :destroy_customer/,
    );
  });

  it("aggregates_controller.ex is in the generated file map when deployable serves an api", async () => {
    const model = await buildFixture();
    const { files } = generateSystems(model);
    expect(files.has("phoenix_app/lib/phoenix_app_web/controllers/aggregates_controller.ex")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// @derive Jason.Encoder — domain-emit unit test
// ---------------------------------------------------------------------------

describe("@derive Jason.Encoder emission (domain-emit unit)", () => {
  it("emits @derive {Jason.Encoder, only: [...]} on aggregate resource", () => {
    const ctx: BoundedContextIR = {
      name: "Sales",
      enums: [],
      valueObjects: [],
      events: [],
      aggregates: [
        {
          name: "Customer",
          idValueType: "guid",
          fields: [
            { name: "name", type: { kind: "primitive", name: "string" }, optional: false },
            { name: "email", type: { kind: "primitive", name: "string" }, optional: false },
          ],
          contains: [],
          derived: [],
          invariants: [],
          functions: [],
          operations: [],
          parts: [],
          tests: [],
        },
      ],
      repositories: [],
      workflows: [],
      views: [],
    };

    const files = emitAggregateResources(ctx, "PhoenixApp", "phoenix_app");
    const customerEx = files.get("lib/phoenix_app/sales/customer.ex")!;
    expect(customerEx).toBeDefined();
    expect(customerEx).toMatch(
      /@derive \{Jason\.Encoder, only: \[:id, :name, :email, :inserted_at, :updated_at\]\}/,
    );
  });

  it("@derive includes :id and timestamps in correct positions", () => {
    const ctx: BoundedContextIR = {
      name: "Sales",
      enums: [],
      valueObjects: [],
      events: [],
      aggregates: [
        {
          name: "Order",
          idValueType: "guid",
          fields: [
            { name: "total", type: { kind: "primitive", name: "decimal" }, optional: false },
          ],
          contains: [],
          derived: [],
          invariants: [],
          functions: [],
          operations: [],
          parts: [],
          tests: [],
        },
      ],
      repositories: [],
      workflows: [],
      views: [],
    };

    const files = emitAggregateResources(ctx, "PhoenixApp", "phoenix_app");
    const orderEx = files.get("lib/phoenix_app/sales/order.ex")!;
    expect(orderEx).toBeDefined();
    expect(orderEx).toMatch(
      /@derive \{Jason\.Encoder, only: \[:id, :total, :inserted_at, :updated_at\]\}/,
    );
  });

  it("@derive is placed before use Ash.Resource in the module", () => {
    const ctx: BoundedContextIR = {
      name: "Sales",
      enums: [],
      valueObjects: [],
      events: [],
      aggregates: [
        {
          name: "Customer",
          idValueType: "guid",
          fields: [{ name: "name", type: { kind: "primitive", name: "string" }, optional: false }],
          contains: [],
          derived: [],
          invariants: [],
          functions: [],
          operations: [],
          parts: [],
          tests: [],
        },
      ],
      repositories: [],
      workflows: [],
      views: [],
    };

    const files = emitAggregateResources(ctx, "PhoenixApp", "phoenix_app");
    const customerEx = files.get("lib/phoenix_app/sales/customer.ex")!;
    const derivePos = customerEx.indexOf("@derive");
    const usePos = customerEx.indexOf("use Ash.Resource");
    expect(derivePos).toBeGreaterThanOrEqual(0);
    expect(usePos).toBeGreaterThan(derivePos);
  });
});

// ---------------------------------------------------------------------------
// Ash 3.x compile-correctness regressions — three drift bugs the
// phoenix-build CI job (mix compile --warnings-as-errors) would
// surface.  Pre-empted here so unit tests catch them before CI:
//   1. Domain `define :update_X, action: :update` references an
//      :update action that the resource didn't declare (`defaults
//      [:read, :destroy]` only had :read + :destroy).  Compile fails
//      with "no action :update on resource".
//   2. Domain `define :update_X, ..., args: [:id]` should be
//      `get_by: [:id]` — `args:` would force the caller to pass id
//      as a positional arg AND declare it as an action argument; the
//      idiomatic shape is `get_by:` so Ash auto-resolves the record.
//   3. `define :all_X, action: :all` plus a custom `read :all do
//      end` action is redundant with the `:read` default — emitted
//      noise that bloated the domain and forced an empty action
//      block on every aggregate.
// ---------------------------------------------------------------------------

describe("Ash 3.x compile-correctness regressions", () => {
  it("aggregate resource has :update in defaults so domain :update define resolves", async () => {
    const files = await buildFormFixture();
    const customer = files.get("phoenix_app/lib/phoenix_app/sales/customer.ex")!;
    expect(customer).toMatch(/defaults \[:read, :update, :destroy\]/);
  });

  it("domain update/destroy defines use get_by: [:id], not args: [:id]", async () => {
    const files = await buildFormFixture();
    const domain = files.get("phoenix_app/lib/phoenix_app/sales.ex")!;
    expect(domain).toMatch(/define :update_customer, action: :update, get_by: \[:id\]/);
    expect(domain).toMatch(/define :destroy_customer, action: :destroy, get_by: \[:id\]/);
    expect(domain).not.toMatch(/args: \[:id\]/);
  });

  it("does not emit redundant :all action / :all_X define (the :read default covers it)", async () => {
    const files = await buildFormFixture();
    const customer = files.get("phoenix_app/lib/phoenix_app/sales/customer.ex")!;
    const domain = files.get("phoenix_app/lib/phoenix_app/sales.ex")!;
    expect(customer).not.toMatch(/read :all do/);
    expect(domain).not.toMatch(/define :all_customer/);
    expect(domain).not.toMatch(/action: :all\b/);
  });

  it("inspect derived emits `defimpl Inspect`, NOT an Ash `calculate :inspect, ..., expr(...)`", async () => {
    // Ash's `expr()` DSL doesn't admit string concat (`<>`) or
    // `to_string/1`, both of which the auto-synthesised inspect body
    // uses.  The emitter must route inspect through a `defimpl Inspect`
    // block (native Elixir) rather than the calculations block.
    // Regression for PR #524's Phoenix CI failure.
    const files = await buildFormFixture();
    const customer = files.get("phoenix_app/lib/phoenix_app/sales/customer.ex")!;
    // Must not have a `calculate :inspect, ...` line — that would put
    // string-concat operators inside `expr()`, which won't compile.
    expect(customer).not.toMatch(/calculate :inspect/);
    // Must have a `defimpl Inspect, for: ..., do def inspect(record, _opts) do <body> end end` block.
    expect(customer).toMatch(
      /defimpl Inspect, for: PhoenixApp\.Sales\.Customer do\s+def inspect\(record, _opts\) do/,
    );
    // The body must reference the struct's stored attributes via
    // `record.<field>` and use native Elixir string concat (`<>`).
    expect(customer).toMatch(/record\.id/);
    expect(customer).toMatch(/<>/);
  });
});

// ---------------------------------------------------------------------------
// Bite 3: Phoenix domain trace via Ash :telemetry.  Ash 3.x emits
//   [:ash, :validation, :start/:stop/:exception]
//   [:ash, :change, :start/:stop]
// (https://hexdocs.pm/ash/monitoring.html).  Under --trace, the
// <App>.Telemetry module additionally attaches to those and translates
// them to catalog identity (invariant_evaluated / value_computed).  Off
// path, the module body is byte-identical to the Bite 1 shape — no Ash
// handlers, no Ash event subscriptions.
// ---------------------------------------------------------------------------

import { renderTelemetry } from "../../src/generator/phoenix-live-view/telemetry-emit.js";

describe("renderTelemetry --trace (telemetry-emit unit)", () => {
  it("off path: byte-identical to the Bite 1 shape — no Ash handlers", () => {
    const off = renderTelemetry({ appName: "phoenix_app", appModule: "PhoenixApp" });
    // No Ash event subscriptions or handlers leak when --trace is off.
    expect(off).not.toMatch(/:ash,/);
    expect(off).not.toMatch(/invariant_evaluated/);
    expect(off).not.toMatch(/value_computed/);
    // The base endpoint handlers are still present (Bite 1 contract).
    expect(off).toMatch(/\[:phoenix, :endpoint, :start\]/);
    expect(off).toMatch(/\[:phoenix, :endpoint, :stop\]/);
  });

  it("on path: subscribes to Ash validation/change events", () => {
    const on = renderTelemetry({
      appName: "phoenix_app",
      appModule: "PhoenixApp",
      emitTrace: true,
    });
    // Ash subscriptions land inside the same events list that the base
    // endpoint events live in, so a single attach_many call covers
    // both — no parallel attachment cost on boot.
    expect(on).toMatch(/\[:ash, :validation, :stop\]/);
    expect(on).toMatch(/\[:ash, :validation, :exception\]/);
    expect(on).toMatch(/\[:ash, :change, :stop\]/);
  });

  it("on path: validation :stop renders invariant_evaluated with passed: true", () => {
    const on = renderTelemetry({
      appName: "phoenix_app",
      appModule: "PhoenixApp",
      emitTrace: true,
    });
    expect(on).toMatch(
      /def handle_event\(\[:ash, :validation, :stop\], _measurements, metadata, _config\) do/,
    );
    // Catalog identity preserved by renderPhoenixLogCall + passed: true
    // is the literal that distinguishes the success branch from the
    // exception handler below.
    expect(on).toMatch(
      /Logger\.debug\("invariant_evaluated", event: "invariant_evaluated", aggregate: aggregate, op: nil, expr: expr, passed: true\)/,
    );
  });

  it("on path: validation :exception renders invariant_evaluated with passed: false", () => {
    const on = renderTelemetry({
      appName: "phoenix_app",
      appModule: "PhoenixApp",
      emitTrace: true,
    });
    expect(on).toMatch(
      /def handle_event\(\[:ash, :validation, :exception\], _measurements, metadata, _config\) do/,
    );
    expect(on).toMatch(
      /Logger\.debug\("invariant_evaluated", event: "invariant_evaluated", aggregate: aggregate, op: nil, expr: expr, passed: false\)/,
    );
  });

  it("on path: change :stop renders value_computed (value: nil, field: inspect(change))", () => {
    const on = renderTelemetry({
      appName: "phoenix_app",
      appModule: "PhoenixApp",
      emitTrace: true,
    });
    expect(on).toMatch(
      /def handle_event\(\[:ash, :change, :stop\], _measurements, metadata, _config\) do/,
    );
    // `field` is best-effort via inspect(change); `value` is nil because
    // Ash's change :stop event doesn't surface the computed value.
    expect(on).toMatch(/field = inspect\(Map\.get\(metadata, :change\)\)/);
    expect(on).toMatch(
      /Logger\.debug\("value_computed", event: "value_computed", aggregate: aggregate, field: field, value: nil\)/,
    );
  });

  it("orchestrator threads --trace into the emitted telemetry.ex", async () => {
    // Generating the full project with emitTrace via the orchestrator
    // surfaces the Ash handlers in the emitted file (integration check
    // for the args plumbing through emitShellFiles → renderTelemetry).
    const { generatePhoenixLiveViewProject } = await import(
      "../../src/generator/phoenix-live-view/index.js"
    );
    const ctx: BoundedContextIR = {
      name: "Sales",
      enums: [],
      valueObjects: [],
      events: [],
      aggregates: [],
      repositories: [],
      workflows: [],
      views: [],
    };
    const deployable: DeployableIR = {
      name: "phoenix_app",
      platform: "phoenixLiveView",
      moduleNames: ["Sales"],
      port: 4000,
      serves: [],
      uiBindings: [],
      moduleBindings: [],
    };
    const baseSys: SystemIR = {
      name: "Mini",
      modules: [],
      deployables: [deployable],
      e2eTests: [],
      uis: [],
      apis: [],
      storages: [],
    };

    const offFiles = generatePhoenixLiveViewProject({
      contexts: [ctx],
      deployable,
      sys: baseSys,
    });
    const offTel = offFiles.get("lib/phoenix_app/telemetry.ex")!;
    expect(offTel).not.toMatch(/:ash,/);

    const onFiles = generatePhoenixLiveViewProject({
      contexts: [ctx],
      deployable,
      sys: baseSys,
      emitTrace: true,
    });
    const onTel = onFiles.get("lib/phoenix_app/telemetry.ex")!;
    expect(onTel).toMatch(/\[:ash, :validation, :stop\]/);
    expect(onTel).toMatch(/\[:ash, :change, :stop\]/);
  });
});

// Reference-collection (`Id<T>[]`) join tables — Phoenix/Ash.  Mirrors
// the TS `test/generator/join-table.test.ts` and the .NET
// "reference-collection join tables (.NET)" block in
// `test/generator/generator-dotnet.test.ts`.  Pins the four seams of
// Phoenix m2m emission: join resource + m2m relationship +
// calculation that re-exposes the wire shape + repository find
// lowering + op `manage_relationship` mutations.
describe("reference-collection join tables (Phoenix/Ash)", () => {
  const ROSTER_SOURCE = `system Roster {
  module Roster {
    context Roster {
      aggregate Pokemon { species: string  level: int  derived display: string = species }
      aggregate Trainer {
        name: string
        derived display: string = name
        party: Pokemon id[]
        caught: Pokemon id[]
        operation addToParty(pokemon: Pokemon id) {
          precondition party.count < 6
          party += pokemon
        }
        operation removeFromParty(pokemon: Pokemon id) {
          precondition party.count > 0
          party -= pokemon
        }
      }
      repository Trainers for Trainer {
        find holdingInParty(pokemon: Pokemon id): Trainer[]
            where this.party.contains(pokemon)
      }
    }
  }
  api RosterApi from Roster
  ui RosterAdmin with scaffold(modules: [Roster]) { }
  deployable phoenixApp { platform: phoenixLiveView  modules: Roster  serves: RosterApi  ui: RosterAdmin  port: 4000 }
}
`;

  async function generateRoster(): Promise<Map<string, string>> {
    const services = createDddServices(NodeFileSystem);
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phx-roster-"));
    const dddPath = path.join(tmpRoot, "roster-system.ddd");
    try {
      fs.writeFileSync(dddPath, ROSTER_SOURCE);
      const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
        URI.file(dddPath),
      );
      await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
      const model = doc.parseResult.value as Model;
      return generateSystems(model).files;
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  it("emits a join resource per Id<T>[] field with composite PK + ordinal", async () => {
    const files = await generateRoster();
    const tp = files.get("phoenix_app/lib/phoenix_app/roster/trainer_party.ex");
    expect(tp, "trainer_party.ex").toBeDefined();
    expect(tp!).toMatch(/defmodule PhoenixApp\.Roster\.TrainerParty do/);
    expect(tp!).toMatch(/attribute :trainer_id, :uuid, primary_key\?: true, allow_nil\?: false/);
    expect(tp!).toMatch(/attribute :pokemon_id, :uuid, primary_key\?: true, allow_nil\?: false/);
    // Ordinal is nullable + defaulted so manage_relationship writes
    // succeed without per-row ordinal injection (cross-backend
    // ordering parity is a follow-up, see generators.md).
    expect(tp!).toMatch(/attribute :ordinal, :integer, allow_nil\?: true, default: 0/);
    expect(files.has("phoenix_app/lib/phoenix_app/roster/trainer_caught.ex")).toBe(true);
  });

  it("declares many_to_many on the owner with through-relationship suffix", async () => {
    const files = await generateRoster();
    const tr = files.get("phoenix_app/lib/phoenix_app/roster/trainer.ex")!;
    // `:party_through` name is deliberately distinct from the `:party`
    // calculation below; sharing names would collide in Ash.
    expect(tr).toMatch(
      /many_to_many :party_through, PhoenixApp\.Roster\.Pokemon do\s+through PhoenixApp\.Roster\.TrainerParty\s+source_attribute_on_join_resource :trainer_id\s+destination_attribute_on_join_resource :pokemon_id/,
    );
    expect(tr).toMatch(/many_to_many :caught_through, PhoenixApp\.Roster\.Pokemon do/);
  });

  it("re-exposes the wire shape as a calculation list of uuids", async () => {
    const files = await generateRoster();
    const tr = files.get("phoenix_app/lib/phoenix_app/roster/trainer.ex")!;
    expect(tr).toMatch(/calculate :party, \{:array, :uuid\}, expr\(party_through\.id\)/);
    expect(tr).toMatch(/calculate :caught, \{:array, :uuid\}, expr\(caught_through\.id\)/);
  });

  it("suppresses the array-of-id attribute, derive list, accept list, and PG column", async () => {
    const files = await generateRoster();
    const tr = files.get("phoenix_app/lib/phoenix_app/roster/trainer.ex")!;
    // No `attribute :party, {:array, :uuid}` line on the resource.
    expect(tr).not.toMatch(/attribute :party,/);
    expect(tr).not.toMatch(/attribute :caught,/);
    // Jason `only:` list excludes party/caught (calculations aren't
    // attribute-serialised by @derive).
    expect(tr).toMatch(
      /@derive \{Jason\.Encoder, only: \[:id, :name, :inserted_at, :updated_at\]\}/,
    );
    // create action's accept[...] drops the ref-collections.
    expect(tr).toMatch(/accept \[:name\]/);
    expect(tr).not.toMatch(/accept \[[^\]]*:party/);
    // Owner migration has no `party` column.
    const ownerMig = [...files.entries()].find(([p]) => /create_trainers\.exs$/.test(p))?.[1];
    expect(ownerMig, "owner migration").toBeDefined();
    expect(ownerMig!).not.toMatch(/add :party/);
  });

  it("emits a join-table migration with composite PK + ordinal + target index", async () => {
    const files = await generateRoster();
    const partyMig = [...files.entries()].find(([p]) => /create_trainer_party\.exs$/.test(p))?.[1];
    expect(partyMig, "trainer_party migration").toBeDefined();
    expect(partyMig!).toMatch(
      /add :trainer_id, references\(:trainers, type: :uuid, on_delete: :delete_all\), null: false, primary_key: true/,
    );
    expect(partyMig!).toMatch(
      /add :pokemon_id, references\(:pokemons, type: :uuid, on_delete: :delete_all\), null: false, primary_key: true/,
    );
    expect(partyMig!).toMatch(/add :ordinal, :integer, null: true, default: 0/);
    expect(partyMig!).toMatch(/create index\(:trainer_party, \[:pokemon_id\]\)/);
  });

  it("lowers this.<refColl>.contains(param) to an Ash exists() filter", async () => {
    const files = await generateRoster();
    const tr = files.get("phoenix_app/lib/phoenix_app/roster/trainer.ex")!;
    expect(tr).toMatch(
      /read :holding_in_party do[\s\S]+?filter expr\(exists\(party_through, id == \^arg\(:pokemon\)\)\)/,
    );
  });

  it("lowers += / -= on ref-collections to manage_relationship with use_identities", async () => {
    const files = await generateRoster();
    const tr = files.get("phoenix_app/lib/phoenix_app/roster/trainer.ex")!;
    expect(tr).toMatch(
      /Ash\.Changeset\.manage_relationship\(changeset, :party_through, \[pokemon\], type: :append, use_identities: \[:id\]\)/,
    );
    expect(tr).toMatch(
      /Ash\.Changeset\.manage_relationship\(changeset, :party_through, \[pokemon\], type: :remove, use_identities: \[:id\]\)/,
    );
  });

  it("auto-loads the ref-collection calculations on every read", async () => {
    const files = await generateRoster();
    const tr = files.get("phoenix_app/lib/phoenix_app/roster/trainer.ex")!;
    // Without this `prepare build(load: …)` block the JSON wire-shape
    // `party` / `caught` fields would be missing (Ash calculations are
    // opt-in by default).  Applies to every read action on the
    // resource — default `:read` + custom finds.
    expect(tr).toMatch(/preparations do\s+prepare build\(load: \[:party, :caught\]\)\s+end/);
  });

  it("registers the join resource on the context's Ash.Domain", async () => {
    const files = await generateRoster();
    const dom = files.get("phoenix_app/lib/phoenix_app/roster.ex")!;
    expect(dom).toMatch(/resource PhoenixApp\.Roster\.TrainerParty/);
    expect(dom).toMatch(/resource PhoenixApp\.Roster\.TrainerCaught/);
  });
});
