// Channel IR lowering + the `.loom/asyncapi.yaml` artifact (channels.md, Slice 1).

import { describe, expect, it } from "vitest";
import { allContexts } from "../../src/ir/types/loom-ir.js";
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
