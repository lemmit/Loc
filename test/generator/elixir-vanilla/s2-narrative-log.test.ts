import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// S2 — info-narrative log events on the vanilla foundation
// (docs/audits/domain-seam-log-parity.md).  The vanilla controller +
// context module emit the three catalog `info` events at the create /
// operation / dispatch seams via `renderPhoenixLogCall` (Logger.info), with
// `require Logger` in the host module — matching Hono/.NET/Java/Python so the
// log stream is uniform cross-backend:
//
//   aggregate_created {aggregate, id}   — create action success arm
//   operation_invoked {aggregate,op,id} — every op action entry
//   event_dispatched {event_type,aggregate} — the named-op `emit` broadcast seam
// ---------------------------------------------------------------------------

const SOURCE = `
system Sales {
  subdomain Sales {
    context Sales {
      event OrderConfirmed { order: Order id, at: datetime }
      aggregate Order with crudish {
        name: string
        confirmed: bool = false
        invariant name.length > 0
        operation confirm() {
          confirmed := true
          emit OrderConfirmed { order: id, at: now() }
        }
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 4000
  }
}
`;

async function controller(): Promise<string> {
  const files = await generateSystemFiles(SOURCE);
  return files.get([...files.keys()].find((k) => k.endsWith("/controllers/order_controller.ex"))!)!;
}

async function context(): Promise<string> {
  const files = await generateSystemFiles(SOURCE);
  return files.get([...files.keys()].find((k) => k.endsWith("lib/api/sales.ex"))!)!;
}

describe("vanilla — S2 info narrative log events", () => {
  it("the controller declares require Logger", async () => {
    expect(await controller()).toContain("  require Logger");
  });

  it("the create success arm logs aggregate_created", async () => {
    expect(await controller()).toContain(
      'Logger.info("aggregate_created", event: "aggregate_created", aggregate: "Order", id: record.id)',
    );
  });

  it("each op action logs operation_invoked with aggregate/op/id", async () => {
    expect(await controller()).toContain(
      'Logger.info("operation_invoked", event: "operation_invoked", aggregate: "Order", op: "confirm", id: id)',
    );
  });

  it("the context module logs event_dispatched at the emit broadcast seam (+ require Logger)", async () => {
    const ctx = await context();
    expect(ctx).toContain("  require Logger");
    expect(ctx).toContain(
      'Logger.info("event_dispatched", event: "event_dispatched", event_type: "OrderConfirmed", aggregate: "Order")',
    );
    // The narrative line precedes the broadcast it announces.
    const logAt = ctx.indexOf('Logger.info("event_dispatched"');
    const castAt = ctx.indexOf("Phoenix.PubSub.broadcast");
    expect(logAt).toBeGreaterThan(-1);
    expect(logAt).toBeLessThan(castAt);
  });
});
