import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Realtime SSE wire — Python / FastAPI (channels.md Part I).  A `delivery:
// broadcast` channel makes its carried events UI-observable at GET
// /api/realtime/events.  `app/realtime.py` holds a per-subscriber asyncio.Queue
// registry + a StreamingResponse SSE endpoint; `make_dispatcher` wraps the
// in-process dispatcher in the `RealtimeDispatcher` tee so every dispatched
// event also reaches the wire.  A broadcast-free deployable emits none of it
// (byte-identical).  The `ruff` / `mypy --strict` gate is verified end-to-end
// in the compile tier.
// ---------------------------------------------------------------------------

function system(platform: string, channel: string): string {
  return `
system RealtimeShop {
  subdomain Shipping {
  context Fulfillment {
    aggregate Order { customerId: string  status: string  total: int  derived display: string = customerId }
    repository Orders for Order { }
    aggregate Shipment {
      orderRef: Order id
      status: string
      operation markTracked() { status := "Tracked" }
    }
    repository Shipments for Shipment { }

    event OrderPlaced { order: Order id, at: datetime }
    event ShipmentRequested { shipment: Shipment id, order: Order id, at: datetime }
${channel}
    workflow OrderFulfillment {
      orderId: Order id
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
  api FulfillmentApi from Shipping
  storage primary { type: postgres }
  resource fulfillmentState { for: Fulfillment, kind: state, use: primary }
  deployable backend {
    platform: ${platform}
    contexts: [Fulfillment]
    dataSources: [fulfillmentState]
    serves: FulfillmentApi
    port: 8080
  }
}
`;
}

const BROADCAST = `
    channel Lifecycle {
      carries: OrderPlaced, ShipmentRequested
      delivery: broadcast
      retention: ephemeral
    }
`;

const QUEUE = `
    channel Lifecycle {
      carries: OrderPlaced, ShipmentRequested
      delivery: queue
      retention: ephemeral
    }
`;

async function generate(src: string): Promise<Map<string, string>> {
  const model = await parseValid(src);
  return generateSystems(model).files;
}

const get = (files: Map<string, string>, suffix: string): string =>
  files.get([...files.keys()].find((k) => k.endsWith(suffix)) ?? "") ?? "";

describe("realtime SSE wire — Python (delivery: broadcast)", () => {
  it("emits app/realtime.py with the router, the serializer, and the tee", async () => {
    const files = await generate(system("python", BROADCAST));

    // (a) The SSE endpoint file + route.
    const rt = get(files, "app/realtime.py");
    expect(rt).toContain(
      'REALTIME_EVENT_TYPES: frozenset[str] = frozenset({"OrderPlaced", "ShipmentRequested"})',
    );
    // include_in_schema=False: the SSE stream stays out of the OpenAPI doc
    // (node/.NET/Java exclude theirs too — the cross-backend parity contract).
    expect(rt).toContain('@realtime_router.get("/realtime/events", include_in_schema=False)');
    expect(rt).toContain('media_type="text/event-stream"');
    expect(rt).toContain('yield "event: ping\\ndata: \\n\\n"');
    // camelCase JSON with the `type` tag; branded-str ids + StrEnum are wire-safe.
    expect(rt).toContain(
      '{"type": "OrderPlaced", "order": event.order, "at": event.at.isoformat()}',
    );

    // (c) The tee wraps the in-process dispatcher in make_dispatcher.
    expect(rt).toContain("class RealtimeDispatcher:");
    expect(rt).toContain("        publish_realtime(event)");
    const dispatch = get(files, "app/dispatch.py");
    expect(dispatch).toContain("def make_dispatcher(session: AsyncSession) -> RealtimeDispatcher:");
    expect(dispatch).toContain("return RealtimeDispatcher(InProcessDispatcher(session))");
    const main = get(files, "app/main.py");
    expect(main).toContain("from app.realtime import realtime_router");
    expect(main).toContain('app.include_router(realtime_router, prefix="/api")');
  });

  it("(b) a non-broadcast channel keeps the wire-free output (byte-identical)", async () => {
    const files = await generate(system("python", QUEUE));
    expect([...files.keys()].some((k) => k.endsWith("app/realtime.py"))).toBe(false);
    const dispatch = get(files, "app/dispatch.py");
    expect(dispatch).not.toContain("RealtimeDispatcher");
    expect(dispatch).toContain("return InProcessDispatcher(session)");
    const main = get(files, "app/main.py");
    expect(main).not.toContain("realtime_router");
  });
});
