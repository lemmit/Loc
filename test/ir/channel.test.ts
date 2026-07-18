// Channel IR lowering + the `.loom/asyncapi.yaml` artifact (channels.md, Slice 1).

import { describe, expect, it } from "vitest";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { renderAsyncApi } from "../../src/system/asyncapi.js";
import { buildLoomModel } from "../_helpers/index.js";

const SRC = `
system Acme {
  subdomain Sales {
    context Orders {
      aggregate Order { customerId: string }
      event OrderPlaced  { order: string, at: string }
      event OrderShipped { order: string, at: string }
      channel Lifecycle {
        carries: OrderPlaced, OrderShipped
        delivery: broadcast
        retention: log
        key: order
      }
    }
  }
  storage eventLog { type: kafka }
  channelSource lifecycleBus { for: Lifecycle, use: eventLog }
}
`;

describe("channel lowering", () => {
  it("lowers a channel onto its context's `channels`", async () => {
    const loom = await buildLoomModel(SRC);
    const ctx = allContexts(loom).find((c) => c.name === "Orders")!;
    const ch = ctx.channels.find((c) => c.name === "Lifecycle")!;
    expect(ch.carries).toEqual(["OrderPlaced", "OrderShipped"]);
    expect(ch.delivery).toBe("broadcast");
    expect(ch.retention).toBe("log");
    expect(ch.key).toBe("order");
  });

  it("lowers channelSources onto the system", async () => {
    const loom = await buildLoomModel(SRC);
    expect(loom.systems[0].channelSources).toEqual([
      { name: "lifecycleBus", channelName: "Lifecycle", storageName: "eventLog" },
    ]);
  });

  it("defaults delivery/retention to broadcast/ephemeral when omitted", async () => {
    const loom = await buildLoomModel(`
      system S { subdomain M { context C {
        event E { order: string }
        channel Bare { carries: E }
      }}}
    `);
    const ch = allContexts(loom)[0].channels[0];
    expect(ch.delivery).toBe("broadcast");
    expect(ch.retention).toBe("ephemeral");
    expect(ch.key).toBeUndefined();
  });

  it("emits an AsyncAPI view of the channels", async () => {
    const loom = await buildLoomModel(SRC);
    const yaml = renderAsyncApi(loom.systems[0]);
    expect(yaml).toContain("asyncapi: 3.0.0");
    expect(yaml).toContain('"Orders.Lifecycle":');
    expect(yaml).toContain("retention: log");
    expect(yaml).toContain('"OrderPlaced":');
    expect(yaml).toContain('transport: "eventLog"');
    // A bound transport is DECLARED, not provisioned (no broker/redis is
    // emitted or compose-provisioned) — the artifact must say so, not imply
    // a live hop.
    expect(yaml).toContain('transportStatus: "declared, not provisioned"');
  });
});

// ---------------------------------------------------------------------------
// M-T4.4 slice 1 — the deployable `channels:` wiring clause + the
// system-level wiring validators.
// ---------------------------------------------------------------------------

/** Producer deployable (hosts Orders, which owns the channel) + consumer
 *  deployable (hosts Shipping, whose workflow reacts to a carried event).
 *  `producerChannels` / `consumerChannels` inject the `channels:` clause. */
function wiredSrc(producerChannels: string, consumerChannels: string): string {
  return `
    system Acme {
      subdomain Sales {
        context Orders {
          event OrderPlaced { orderId: string }
          channel Lifecycle { carries: OrderPlaced }
        }
        context Shipping {
          workflow Fulfil {
            orderId: string
            on(e: OrderPlaced) { let x = e.orderId }
          }
        }
      }
      storage bus { type: redis }
      channelSource lifecycleBus { for: Lifecycle, use: bus }
      deployable salesApi { platform: node contexts: [Orders] ${producerChannels} port: 3000 }
      deployable shipApi  { platform: node contexts: [Shipping] ${consumerChannels} port: 3001 }
    }
  `;
}

async function channelCodes(src: string): Promise<string[]> {
  const loom = await buildLoomModel(src);
  return validateLoomModel(loom)
    .map((d) => d.code ?? "")
    .filter((c) => c.startsWith("loom.channel") || c.startsWith("loom.deployable-channel"));
}

describe("deployable channels: wiring (M-T4.4 slice 1)", () => {
  it("lowers the channels: clause onto DeployableIR.channelSourceNames", async () => {
    const loom = await buildLoomModel(wiredSrc("channels: [lifecycleBus]", ""));
    const dep = loom.systems[0].deployables.find((d) => d.name === "salesApi")!;
    expect(dep.channelSourceNames).toEqual(["lifecycleBus"]);
    const other = loom.systems[0].deployables.find((d) => d.name === "shipApi")!;
    expect(other.channelSourceNames).toEqual([]);
  });

  it("warns loom.channelsource-unbound when no deployable wires the binding", async () => {
    expect(await channelCodes(wiredSrc("", ""))).toContain("loom.channelsource-unbound");
  });

  it("errors loom.channel-consumer-unwired when the consumer misses a broker-bound channel", async () => {
    const codes = await channelCodes(wiredSrc("channels: [lifecycleBus]", ""));
    expect(codes).toContain("loom.channel-consumer-unwired");
  });

  it("is quiet when producer and consumer both wire the binding", async () => {
    const codes = await channelCodes(
      wiredSrc("channels: [lifecycleBus]", "channels: [lifecycleBus]"),
    );
    expect(codes).toEqual([]);
  });

  it("warns loom.deployable-channel-unrelated on a deployable with no stake in the channel", async () => {
    const src = `
      system Acme {
        subdomain Sales {
          context Orders {
            event OrderPlaced { orderId: string }
            channel Lifecycle { carries: OrderPlaced }
          }
          context Billing {
            event InvoiceSent { invoiceId: string }
          }
        }
        storage bus { type: redis }
        channelSource lifecycleBus { for: Lifecycle, use: bus }
        deployable ordersApi  { platform: node contexts: [Orders] channels: [lifecycleBus] port: 3000 }
        deployable billingApi { platform: node contexts: [Billing] channels: [lifecycleBus] port: 3001 }
      }
    `;
    expect(await channelCodes(src)).toContain("loom.deployable-channel-unrelated");
  });

  it("resolves a CROSS-context event on a `create(e: X)` starter, correlation typed via the foreign event", async () => {
    // M-T4.4 slice 2: an event-triggered create is a subscription position
    // like `on(e: X)` — the event resolves system-wide (the scope widening),
    // its members type from the foreign declaration (findEventByName's
    // system-wide fallback), and the correlation validator sees the
    // model-wide event list.  This is exactly the shape the channels-e2e
    // fixture boots.
    const src = `
      system Acme {
        subdomain Sales {
          context Orders {
            aggregate Order { customerId: string }
            repository Orders for Order {}
            event OrderPlaced { order: Order id, at: datetime }
            channel Lifecycle { carries: OrderPlaced }
          }
          context Shipping {
            aggregate Shipment {
              orderRef: Order id
              status: string
            }
            repository Shipments for Shipment {}
            workflow Fulfil {
              orderId: Order id
              create(p: OrderPlaced) by p.order {
                let s = Shipment.create({ orderRef: p.order, status: "Pending" })
              }
            }
          }
        }
        storage bus { type: redis }
        channelSource lifecycleBus { for: Lifecycle, use: bus }
        deployable salesApi { platform: node contexts: [Orders] channels: [lifecycleBus] port: 3000 }
        deployable shipApi  { platform: node contexts: [Shipping] channels: [lifecycleBus] port: 3001 }
      }
    `;
    const loom = await buildLoomModel(src); // throws on any validation error
    const wf = allContexts(loom)
      .find((c) => c.name === "Shipping")!
      .workflows.find((w) => w.name === "Fulfil")!;
    const starter = wf.creates.find((c) => c.triggerKind === "event")!;
    expect(starter.eventRef).toBe("OrderPlaced");
    expect(starter.correlation).toBeDefined();
    expect(await channelCodes(src)).toEqual([]);
  });

  it("surfaces the wiring in the AsyncAPI artifact (wiredBy)", async () => {
    const loom = await buildLoomModel(
      wiredSrc("channels: [lifecycleBus]", "channels: [lifecycleBus]"),
    );
    const yaml = renderAsyncApi(loom.systems[0]);
    expect(yaml).toContain('wiredBy: ["salesApi", "shipApi"]');
  });
});
