// Ash/Phoenix foundation — workflow-sourced `view` emission
// (workflow-instance-views.md).  A shorthand `view X = <Workflow> where <pred>`
// over an observable (correlation-bearing) state-based saga emits a PLAIN Ecto
// read of the saga-state `<Wf>State` schema with the filter, projecting
// `instanceWireShape` (camelCase wire key <- snake struct field) — the Ash
// sibling of the vanilla workflow-view path (`vanilla-workflow-view.test.ts`).
//
// The aggregate-sourced view path stays on `Ash.Query`/`Ash.read!` — only the
// workflow source switches to the Ecto read, because on Ash the saga-state
// schema is a plain Ecto schema and `<App>.Repo` is an `AshPostgres.Repo` (an
// `Ecto.Repo`), so `from(record in <State>, where: ...) |> Repo.all()` compiles
// and runs.  Before the fix the workflow source wasn't in `ctx.aggregates`, so
// the view was silently skipped, yet `views_controller.ex` still called
// `<Ctx>.Views.<V>.run/1` (undefined-function under --warnings-as-errors).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// State-based saga with a correlation field + a typed `int` state field, an
// event-triggered `create ... by`, and a workflow-sourced view filtered on the
// state field.  Mirrors `vanilla-channels.ddd` but pins `foundation: vanilla`.
const SYSTEM = `
system FulfillmentSys {
  subdomain Fulfillment {
    context Fulfillment {
      aggregate Order with crudish {
        customerId: string
        status: string
        total: int
      }
      repository Orders for Order { }

      aggregate Shipment with crudish {
        orderRef: Order id
        status: string
        operation markTracked() { status := "Tracked" }
      }
      repository Shipments for Shipment { }

      event OrderPlaced { order: Order id, at: datetime }
      event ShipmentRequested { shipment: Shipment id, order: Order id, at: datetime }

      workflow OrderFulfillment {
        orderId: Order id          // correlation — one instance per order
        attempts: int              // typed saga state

        create(p: OrderPlaced) by p.order {
          let ship = Shipment.create({ orderRef: p.order, status: "Pending" })
          emit ShipmentRequested { shipment: ship.id, order: p.order, at: now() }
        }

        on(s: ShipmentRequested) by s.order {
          let ship = Shipments.getById(s.shipment)
          ship.markTracked()
        }
      }

      // Workflow-sourced view: a curated saga projection over the persisted
      // correlation state, filtered on the typed state field.
      view BusyFulfillments = OrderFulfillment where attempts > 0
    }
  }
  api FulfillmentApi from Fulfillment
  storage primary { type: postgres }
  resource fulfillmentState { for: Fulfillment, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Fulfillment]
    dataSources: [fulfillmentState]
    serves: FulfillmentApi
    port: 4000
  }
}
`;

const VIEW_PATH = "api/lib/api/fulfillment/views/busy_fulfillments.ex";

describe("phoenix (ash) — workflow-sourced view", () => {
  it("emits the view module at <ctx>/views/<v>.ex with a def run", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const view = files.get(VIEW_PATH);
    expect(view, "workflow view module not emitted").toBeDefined();
    // Module is <Ctx>.Views.<V> with a run/1.
    expect(view).toMatch(/^defmodule Api\.Fulfillment\.Views\.BusyFulfillments do/m);
    expect(view).toMatch(/def run\(current_user \\\\ nil\) do/);
  });

  it("reads the saga-state Ecto schema via from/where |> Repo.all() (not the aggregate Ash path)", async () => {
    const view = (await generateSystemFiles(SYSTEM)).get(VIEW_PATH)!;
    // Ecto read over the saga-state schema, filtered on the lowered state field.
    expect(view).toContain("import Ecto.Query");
    expect(view).toContain(
      "from(record in Api.Fulfillment.Workflows.OrderFulfillmentState, where: record.attempts > 0)",
    );
    expect(view).toContain("|> Repo.all()");
    // This module is an Ecto read, NOT the aggregate Ash.read! path.
    expect(view).not.toContain("Ash.read!");
    expect(view).not.toContain("Ash.Query");
  });

  it("projects instanceWireShape via Enum.map (camelCase wire key <- snake struct field)", async () => {
    const view = (await generateSystemFiles(SYSTEM)).get(VIEW_PATH)!;
    expect(view).toContain(
      "|> Enum.map(fn record -> %{orderId: record.order_id, attempts: record.attempts} end)",
    );
    expect(view).toContain("@spec run(any()) :: [map()]");
  });

  it("wires the view into the project-wide ViewsController + emits the saga-state schema", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const ctrl = files.get("api/lib/api_web/controllers/views_controller.ex")!;
    expect(ctrl).toContain("Api.Fulfillment.Views.BusyFulfillments.run(current_user)");
    // The schema the view reads must actually be emitted.
    expect(
      files.get("api/lib/api/fulfillment/workflows/order_fulfillment_state.ex"),
      "saga-state schema not emitted",
    ).toBeDefined();
  });

  it("keeps the aggregate-sourced view on the Ecto from/where |> Repo.all() path", async () => {
    // Sanity: the workflow branch must not regress the aggregate path — add an
    // aggregate-sourced view to the same context and assert it stays on Ecto.
    const withAggView = SYSTEM.replace(
      "view BusyFulfillments = OrderFulfillment where attempts > 0",
      `view BusyFulfillments = OrderFulfillment where attempts > 0
      view OpenOrders = Order where total > 0`,
    );
    const files = await generateSystemFiles(withAggView);
    const aggView = files.get("api/lib/api/fulfillment/views/open_orders.ex");
    expect(aggView, "aggregate view module not emitted").toBeDefined();
    expect(aggView).toContain("|> Repo.all()");
    expect(aggView).not.toContain("Ash.read!");
  });
});
