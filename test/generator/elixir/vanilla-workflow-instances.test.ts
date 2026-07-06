// Vanilla foundation — workflow-instance read endpoints (vanilla-foundation
// -tdd-plan.md slice 5; workflow-instance-visibility.md).
//
// This is the slice that retires the deferred-Phoenix workflow-instance-views
// gap.  On `foundation: vanilla` a correlation-bearing workflow gets:
//   - a saga-state Ecto schema (already plain Ecto on the ash path — reused),
//   - a `WorkflowInstancesController` reading it via the app Repo
//     (`Repo.all` / `Repo.get`) and projecting the cross-backend
//     `instanceWireShape` (camelCase keys ← snake struct fields),
//   - `GET /api/workflows/<snake>/instances` + `.../instances/:id` routes.
// No Ash anywhere — the read is a plain `from … |> Repo.all` analogue, exactly
// as the visibility proposal promised for the vanilla path.

import { describe, expect, it } from "vitest";
import { emitVanillaWorkflowInstances } from "../../../src/generator/elixir/vanilla/workflow-instances-emit.js";
import type { EnrichedBoundedContextIR, WorkflowIR } from "../../../src/ir/types/loom-ir.js";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const wf = {
  name: "OrderFulfillment",
  correlationField: "orderId",
  stateFields: [
    { name: "orderId", type: { kind: "id", valueType: "guid" }, optional: false },
    { name: "attempts", type: { kind: "primitive", name: "int" }, optional: false },
  ],
  instanceWireShape: [
    { name: "orderId", type: { kind: "id", valueType: "guid" }, optional: false },
    { name: "attempts", type: { kind: "primitive", name: "int" }, optional: false },
  ],
} as unknown as WorkflowIR;

function ctxWith(workflows: WorkflowIR[]): EnrichedBoundedContextIR {
  return {
    name: "Fulfillment",
    enums: [],
    valueObjects: [],
    events: [],
    aggregates: [],
    repositories: [],
    workflows,
    views: [],
    eventSubscriptions: [],
  } as unknown as EnrichedBoundedContextIR;
}

function emit(workflows: WorkflowIR[]): {
  out: Map<string, string>;
  routes: ReturnType<typeof emitVanillaWorkflowInstances>;
} {
  const out = new Map<string, string>();
  const routes = emitVanillaWorkflowInstances("acme", "Acme", ctxWith(workflows), out);
  return { out, routes };
}

describe("vanilla foundation — workflow-instance read endpoints", () => {
  it("emits the saga-state Ecto schema (plain Ecto, no Ash)", () => {
    const { out } = emit([wf]);
    const schema = out.get("lib/acme/fulfillment/workflows/order_fulfillment_state.ex");
    expect(schema, "saga-state schema not emitted").toBeDefined();
    expect(schema!).toContain("defmodule Acme.Fulfillment.Workflows.OrderFulfillmentState do");
    expect(schema!).toContain("use Ecto.Schema");
    expect(schema!).toContain("@primary_key {:order_id, :binary_id, autogenerate: false}");
    expect(schema!).toContain("field :attempts, :integer");
    expect(schema!).not.toContain("Ash");
  });

  it("emits a WorkflowInstancesController with index + show over the saga schema", () => {
    const { out } = emit([wf]);
    const ctrl = out.get("lib/acme_web/controllers/workflow_instances_controller.ex");
    expect(ctrl, "WorkflowInstancesController not emitted").toBeDefined();
    expect(ctrl!).toContain("defmodule AcmeWeb.WorkflowInstancesController do");
    expect(ctrl!).toContain("def order_fulfillment_instances(conn, _params) do");
    expect(ctrl!).toContain("Acme.Repo.all(Acme.Fulfillment.Workflows.OrderFulfillmentState)");
    expect(ctrl!).toContain('def order_fulfillment_instance(conn, %{"id" => id}) do');
    expect(ctrl!).toContain("Acme.Repo.get(Acme.Fulfillment.Workflows.OrderFulfillmentState, id)");
    // camelCase wire keys ← snake struct fields.
    expect(ctrl!).toContain("orderId: row.order_id");
    expect(ctrl!).toContain("attempts: row.attempts");
    expect(ctrl!).not.toContain("Ash");
  });

  it("returns GET routes for the instance list + by-id endpoints", () => {
    const { routes } = emit([wf]);
    expect(routes).toContainEqual({
      method: "get",
      path: "/workflows/order_fulfillment/instances",
      controller: "WorkflowInstancesController",
      action: ":order_fulfillment_instances",
    });
    expect(routes).toContainEqual({
      method: "get",
      path: "/workflows/order_fulfillment/instances/:id",
      controller: "WorkflowInstancesController",
      action: ":order_fulfillment_instance",
    });
  });

  it("emits nothing controller-side when no workflow is observable", () => {
    const { out, routes } = emit([]);
    expect(routes).toEqual([]);
    expect(out.has("lib/acme_web/controllers/workflow_instances_controller.ex")).toBe(false);
  });

  it("wires through the full pipeline (parse → lower → generateSystems)", async () => {
    const SRC = `
      system Sys {
        subdomain F {
          context F {
            aggregate Order { customerId: string  status: string  total: int }
            repository Orders for Order {}
            aggregate Shipment {
              orderRef: Order id
              status: string
              operation markTracked() { status := "Tracked" }
            }
            repository Shipments for Shipment {}
            event OrderPlaced { order: Order id, at: datetime }
            event ShipmentRequested { shipment: Shipment id, order: Order id, at: datetime }
            workflow OrderFulfillment {
              orderId: Order id
              attempts: int
              create(p: OrderPlaced) by p.order {
                let ship = Shipment.create({ orderRef: p.order, status: "Pending" })
                emit ShipmentRequested { shipment: ship.id, order: p.order, at: now() }
              }
              on(s: ShipmentRequested) by s.order {
                let ship = Shipments.getById(s.shipment)
                ship.markTracked()
              }
            }
          }
        }
        storage primary { type: postgres }
        deployable api { platform: elixir  contexts: [F]  port: 4000 }
      }
    `;
    const { model } = await parseString(SRC, { validate: false });
    const files = generateSystems(model).files;
    const keys = [...files.keys()];
    const schema = keys.find((k) => k.endsWith("/workflows/order_fulfillment_state.ex"));
    const ctrl = keys.find((k) => k.endsWith("/controllers/workflow_instances_controller.ex"));
    const router = keys.find((k) => k.endsWith("_web/router.ex"));
    expect(schema, "saga-state schema not emitted").toBeDefined();
    expect(ctrl, "instances controller not emitted").toBeDefined();
    expect(files.get(ctrl!)!).not.toContain("Ash");
    expect(files.get(router!)!).toContain("/workflows/order_fulfillment/instances");
  });
});

// An event-sourced workflow on the vanilla foundation
// (workflow-and-applier.md A2-S5b): the instance-read body diverges — instead
// of `Repo.all(<Wf>State)` / `Repo.get`, the actions fold the stream via the
// `<Wf>Stream` module (`list_instances/0` for LIST, `instance_by_id/1` for
// byId).  Route paths + action names + wire keys stay identical to the state
// path (the projection reads `row.<field>` on both the Ecto row and the folded
// struct), so cross-backend OpenAPI parity holds.
describe("vanilla foundation — event-sourced workflow-instance reads", () => {
  const ES_SRC = `system Sys {
    subdomain F {
      context F {
        aggregate Order { status: string  create place() { status := "Placed"  emit OrderPlaced { order: id } } }
        repository Orders for Order {}
        event OrderPlaced { order: Order id }
        event PaymentRegistered { order: Order id, amount: int }
        channel L { carries: OrderPlaced, PaymentRegistered  delivery: broadcast  retention: ephemeral }
        workflow OrderFulfillment eventSourced {
          orderId: Order id
          paid: int
          create(p: OrderPlaced) by p.order { emit PaymentRegistered { order: p.order, amount: 0 } }
          on(pr: PaymentRegistered) by pr.order { precondition paid >= 0  emit PaymentRegistered { order: pr.order, amount: paid } }
          apply(pr: PaymentRegistered) { paid := paid + pr.amount }
        }
      }
    }
    api A from F
    storage primary { type: postgres }
    resource fState { for: F, kind: state, use: primary }
    deployable api { platform: elixir  contexts: [F]  serves: A  dataSources: [fState]  port: 4000 }
  }`;

  it("routes the instance actions through the <Wf>Stream fold helpers", async () => {
    const { model } = await parseString(ES_SRC, { validate: false });
    const files = generateSystems(model).files;
    const ctrlKey = [...files.keys()].find((k) =>
      k.endsWith("/controllers/workflow_instances_controller.ex"),
    );
    expect(ctrlKey, "instances controller not emitted").toBeDefined();
    const ctrl = files.get(ctrlKey!)!;
    const Stream = "Api.F.Workflows.OrderFulfillmentStream";
    // LIST folds every stream; byId folds one (nil → 404).
    expect(ctrl).toContain(`data = Enum.map(${Stream}.list_instances(), fn row -> %{`);
    expect(ctrl).toContain(`case ${Stream}.instance_by_id(id) do`);
    expect(ctrl).toContain("orderId: row.order_id");
    expect(ctrl).toContain("paid: row.paid");
    // NOT the state-path Repo read.
    expect(ctrl).not.toContain("Repo.all(Api.F.Workflows.OrderFulfillmentState)");
    expect(ctrl).not.toContain("Repo.get(Api.F.Workflows.OrderFulfillmentState");
    // Route paths/action names unchanged across ES vs state.
    const routerKey = [...files.keys()].find((k) => k.endsWith("_web/router.ex"));
    expect(files.get(routerKey!)!).toContain("/workflows/order_fulfillment/instances");
  });
});
