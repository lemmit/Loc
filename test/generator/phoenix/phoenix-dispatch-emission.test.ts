import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

// ---------------------------------------------------------------------------
// Phoenix in-process event dispatch (channels.md) — the Phoenix mirror of
// the Hono (#970) and .NET (#1012) slices.  Each channel-routed
// `on(e: Event)` reactor / event-triggered `create(e: Event) by` starter
// becomes a handler module with `handle(event)`; a per-context `Dispatcher`
// routes an emitted event struct to its handler(s), and a handler that
// `emit`s re-enters the dispatcher (choreography).  Correlation persists
// through a saga-state `Ecto.Schema` keyed by the correlation field
// (load-or-allocate for `create`, route-or-drop+log for `on`).  An
// event-triggered-only workflow has no `run/2` / HTTP command surface.  The
// `mix compile --warnings-as-errors` gate lives in
// test/e2e/generated-phoenix-build.test.ts (dispatch.ddd fixture).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");

async function generate(file: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(root, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  expect(
    errors.map((d) => d.message),
    "fixture validation errors",
  ).toEqual([]);
  return generateSystems(doc.parseResult.value as Model).files;
}

const DISPATCH = "test/e2e/fixtures/phoenix-build/dispatch.ddd";
const base = "phoenix_app/lib/phoenix_app/fulfillment";

describe("Phoenix in-process event dispatch emission", () => {
  it("emits one handler module per reactor / event-create", async () => {
    const files = await generate(DISPATCH);

    // create(OrderPlaced) starter → Start handler.
    const start = files.get(`${base}/workflows/order_fulfillment/start_order_placed.ex`);
    expect(start).toBeDefined();
    expect(start!).toContain(
      "defmodule PhoenixApp.Fulfillment.Workflows.OrderFulfillment.StartOrderPlaced do",
    );
    expect(start!).toContain("def handle(%PhoenixApp.Fulfillment.Events.OrderPlaced{} = event) do");
    // Event param binds to `event`; the body creates a shipment + re-dispatches.
    expect(start!).toContain(
      'PhoenixApp.Fulfillment.create_shipment(%{order_ref: event.order, status: "Pending"})',
    );
    expect(start!).toMatch(
      /PhoenixApp\.Fulfillment\.Dispatcher\.dispatch\(%PhoenixApp\.Fulfillment\.Events\.ShipmentRequested\{shipment: ship\.id, order: event\.order/,
    );

    // on(ShipmentRequested) continuation → On handler.
    const onH = files.get(`${base}/workflows/order_fulfillment/on_shipment_requested.ex`);
    expect(onH).toBeDefined();
    expect(onH!).toContain(
      "defmodule PhoenixApp.Fulfillment.Workflows.OrderFulfillment.OnShipmentRequested do",
    );
    expect(onH!).toContain(
      "def handle(%PhoenixApp.Fulfillment.Events.ShipmentRequested{} = event) do",
    );
    expect(onH!).toContain("PhoenixApp.Fulfillment.get_shipment(event.shipment)");
    expect(onH!).toContain("PhoenixApp.Fulfillment.mark_tracked_shipment(ship)");
  });

  it("emits a per-context dispatcher routing each event struct to its handler(s)", async () => {
    const files = await generate(DISPATCH);
    const disp = files.get(`${base}/dispatcher.ex`);
    expect(disp).toBeDefined();
    expect(disp!).toContain("defmodule PhoenixApp.Fulfillment.Dispatcher do");
    expect(disp!).toContain(
      "def dispatch(%PhoenixApp.Fulfillment.Events.OrderPlaced{} = event) do",
    );
    expect(disp!).toContain(
      "PhoenixApp.Fulfillment.Workflows.OrderFulfillment.StartOrderPlaced.handle(event)",
    );
    expect(disp!).toContain(
      "def dispatch(%PhoenixApp.Fulfillment.Events.ShipmentRequested{} = event) do",
    );
    expect(disp!).toContain(
      "PhoenixApp.Fulfillment.Workflows.OrderFulfillment.OnShipmentRequested.handle(event)",
    );
    // Events with no subscriber are a no-op.
    expect(disp!).toContain("def dispatch(_event), do: :ok");
  });

  it("persists correlation: saga Ecto.Schema + correlation-keyed migration", async () => {
    const files = await generate(DISPATCH);

    // Saga state Ecto schema — correlation field as primary key.
    const state = files.get(`${base}/workflows/order_fulfillment_state.ex`);
    expect(state).toBeDefined();
    expect(state!).toContain("defmodule PhoenixApp.Fulfillment.Workflows.OrderFulfillmentState do");
    expect(state!).toContain("use Ecto.Schema");
    expect(state!).toContain("@primary_key {:order_id, :binary_id, autogenerate: false}");
    expect(state!).toContain('schema "order_fulfillments" do');
    expect(state!).toContain("field :attempts, :integer");

    // Migration — correlation-keyed table (no synthetic `id`).
    const migKey = [...files.keys()].find((k) => k.endsWith("_create_order_fulfillments.exs"));
    expect(migKey).toBeDefined();
    const mig = files.get(migKey!) ?? "";
    expect(mig).toContain("create table(:order_fulfillments, primary_key: false) do");
    expect(mig).toContain("add :order_id, :uuid, primary_key: true, null: false");
    expect(mig).toContain("add :attempts, :integer");
  });

  it("create loads-or-allocates the saga row; on routes-or-drops+logs", async () => {
    const files = await generate(DISPATCH);

    // create: load by correlation key, allocate (typed default) when new.
    const start = files.get(`${base}/workflows/order_fulfillment/start_order_placed.ex`) ?? "";
    expect(start).toContain("key = event.order");
    expect(start).toContain(
      "case PhoenixApp.Repo.get(PhoenixApp.Fulfillment.Workflows.OrderFulfillmentState, key) do",
    );
    expect(start).toContain(
      "nil -> PhoenixApp.Repo.insert!(%PhoenixApp.Fulfillment.Workflows.OrderFulfillmentState{order_id: key, attempts: 0})",
    );

    // on: route-to-existing, else drop + log event_unrouted.
    const onH = files.get(`${base}/workflows/order_fulfillment/on_shipment_requested.ex`) ?? "";
    expect(onH).toContain("require Logger");
    expect(onH).toMatch(/Logger\.warning\("event_unrouted".*workflow: "OrderFulfillment"/);
    expect(onH).toMatch(/nil ->[\s\S]*:ok/);
  });

  it("emits no run/2 command surface for an event-triggered-only workflow", async () => {
    const files = await generate(DISPATCH);
    const keys = [...files.keys()];
    // No `run/2` workflow module, no workflows controller (the saga is
    // dispatch-only — an event has no command DTO, so an HTTP route would
    // reference the event as a workflow param and wouldn't compile).
    expect(keys).not.toContain(`${base}/workflows/order_fulfillment.ex`);
    expect(keys).not.toContain(
      "phoenix_app/lib/phoenix_app_web/controllers/workflows_controller.ex",
    );
  });

  it("scaffolds no UI form page for an event-triggered-only workflow", async () => {
    const files = await generate(DISPATCH);
    const keys = [...files.keys()];
    // The scaffold synthesises no Form page for a dispatch-only workflow
    // (it would phx-submit to a non-existent route), so no workflow
    // LiveView page and no WorkflowsIndex singleton — the saga has no
    // command surface to drive from the UI.
    expect(keys.some((k) => /\/live\/.*workflow.*\.ex$/.test(k))).toBe(false);
    expect(keys.some((k) => /workflows_index_live\.ex$/.test(k))).toBe(false);
  });

  it("emits no dispatch wiring for a channel-less project (byte-identical / no-op)", async () => {
    const files = await generate("test/e2e/fixtures/phoenix-build/roster.ddd");
    const keys = [...files.keys()];
    // No dispatcher, no reactor handlers, no saga schema.
    expect(keys.some((k) => k.endsWith("/dispatcher.ex"))).toBe(false);
    expect(keys.some((k) => /workflows\/.+\/(start|on)_.+\.ex$/.test(k))).toBe(false);
    expect(keys.some((k) => /_state\.ex$/.test(k))).toBe(false);
    // The command-triggered `verifyByName` workflow still emits its run/2.
    expect(keys.some((k) => k.endsWith("/workflows/verify_by_name.ex"))).toBe(true);
  });
});
