import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// The vanilla `WorkflowsController` is a DEPLOYABLE-level artifact: a deployable
// hosting N contexts that each declare a command workflow must emit ONE
// `workflows_controller.ex` aggregating every context's actions.  It used to be
// emitted per-context to a fixed path, so the last context clobbered the rest —
// the routed action was then undefined → runtime 500 (compile-clean, since
// Phoenix doesn't verify route actions at compile).  Each workflow stays
// context-local; the controller only composes the deployable's contexts.
// ---------------------------------------------------------------------------

const SOURCE = `
system MultiCtxWf {
  subdomain Sales {
    context Orders {
      aggregate Order { code: string  active: bool }
      repository Orders for Order { }
      workflow placeOrder {
        create(code: string) {
          precondition code.length > 0
          let o = Order.create({ code: code, active: true })
        }
      }
    }
  }
  subdomain Delivery {
    context Shipments {
      aggregate Shipment { tracking: string }
      repository Shipments for Shipment { }
      workflow scheduleShipment {
        create(tracking: string) {
          precondition tracking.length > 0
          let s = Shipment.create({ tracking: tracking })
        }
      }
    }
  }
  api SalesApi from Sales
  api DeliveryApi from Delivery
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  resource shipmentsState { for: Shipments, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Orders, Shipments]
    dataSources: [ordersState, shipmentsState]
    serves: SalesApi, DeliveryApi
    port: 4000
  }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla WorkflowsController aggregates across the deployable's contexts", () => {
  it("emits exactly ONE workflows_controller.ex (no per-context clobber)", async () => {
    const files = await generateSystemFiles(SOURCE);
    const controllers = [...files.keys()].filter((k) => k.endsWith("workflows_controller.ex"));
    expect(controllers.length).toBe(1);
  });

  it("the single controller defines BOTH contexts' actions, each routed to its own context module", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "workflows_controller.ex");
    // Orders' workflow.
    expect(ctrl).toContain("def place_order(conn, params)");
    expect(ctrl).toContain("Api.Orders.Workflows.PlaceOrder.run(params)");
    // Shipments' workflow — the one the old per-context emit clobbered.
    expect(ctrl).toContain("def schedule_shipment(conn, params)");
    expect(ctrl).toContain("Api.Shipments.Workflows.ScheduleShipment.run(params)");
  });

  it("both routes mount on the one controller", async () => {
    const router = file(await generateSystemFiles(SOURCE), "router.ex");
    expect(router).toContain('post "/workflows/place_order", WorkflowsController, :place_order');
    expect(router).toContain(
      'post "/workflows/schedule_shipment", WorkflowsController, :schedule_shipment',
    );
  });
});
