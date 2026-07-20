// Rooms + policy-derived routing v1 (channels.md — "Realtime topology").
// Two IR-level gates:
//   - `loom.relay-target-not-subscribed` (error): a ui subscribes to a channel
//     via an `on <chan>.<Event>` handler, but its relay backend (the one its
//     frontend `targets:`) neither hosts the channel's owning context nor binds
//     it — the SSE relay can't legally serve those events.
//   - `loom.realtime-tenant-broadcast` (warning): a tenant-owned realtime
//     context served by a non-node SSE backend broadcasts tenant-scoped event
//     payloads cross-tenant (per-tenant rooms ship on node/Hono only, v1).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function diags(source: string, code: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.code === code)
    .map((d) => d.message);
}

// ─── loom.relay-target-not-subscribed ──────────────────────────────────────

// A ui subscribing to `Orders.Lifecycle`, whose frontend targets a backend
// that hosts `hostedContext` and (optionally) binds the channel via a
// channelSource.  When the target hosts `Reports` (not `Orders`) and binds
// nothing, the relay can't serve the events.
function relaySys(opts: { targetHostsOrders: boolean; bindChannel: boolean }): string {
  const backendContexts = opts.targetHostsOrders ? "[Orders, Reports]" : "[Reports]";
  const channelBinding = opts.bindChannel
    ? `\n  channelSource lifecycleSrc { for: Lifecycle, use: broker }`
    : "";
  const backendChannels = opts.bindChannel ? " channels: [lifecycleSrc]" : "";
  return `
system RelayGate {
  subdomain Sales {
    context Orders {
      aggregate Order { status: string }
      repository Orders for Order { }
      event OrderPlaced { order: Order id, at: datetime }
      channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
    }
  }
  subdomain Reporting {
    context Reports {
      aggregate Report { title: string }
      repository Reports for Report { }
    }
  }
  storage primary { type: postgres }${opts.bindChannel ? "\n  storage broker { type: kafka }" : ""}
  resource ordersSt { for: Orders, kind: state, use: primary }
  resource reportsSt { for: Reports, kind: state, use: primary }${channelBinding}
  api ReportsApi from Reporting
  ui WebApp {
    api Reports: ReportsApi
    channel Live: Orders.Lifecycle
    on Live.OrderPlaced(e) { toast("order placed") }
    page Home { route: "/" body: Heading { "hi" } }
  }
  deployable backend {
    platform: node
    contexts: ${backendContexts}
    dataSources: [ordersSt, reportsSt]${backendChannels}
    serves: ReportsApi
    port: 3000
  }
  deployable webApp { platform: react targets: backend ui: WebApp { Reports: backend } port: 3001 }
}
`;
}

describe("relay obligation gate (`loom.relay-target-not-subscribed`)", () => {
  it("errors when the relay backend neither hosts nor binds the subscribed channel", async () => {
    const errs = await diags(
      relaySys({ targetHostsOrders: false, bindChannel: false }),
      "loom.relay-target-not-subscribed",
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("subscribes to channel 'Lifecycle'");
    expect(errs[0]).toContain("neither hosts 'Orders' nor binds the channel");
  });

  it("does not error when the relay backend hosts the channel's owning context", async () => {
    expect(
      await diags(
        relaySys({ targetHostsOrders: true, bindChannel: false }),
        "loom.relay-target-not-subscribed",
      ),
    ).toEqual([]);
  });

  it("does not error when the relay backend binds the channel via a channelSource", async () => {
    expect(
      await diags(
        relaySys({ targetHostsOrders: false, bindChannel: true }),
        "loom.relay-target-not-subscribed",
      ),
    ).toEqual([]);
  });
});

// ─── loom.realtime-tenant-broadcast ────────────────────────────────────────

function tenantSys(backendPlatform: string): string {
  const dataSources = backendPlatform === "elixir" ? "" : " dataSources: [coreSt, acctSt]";
  return `
system TenantRt {
  user { id: guid  tenantId: string }
  tenancy by user.tenantId of Organization
  subdomain Core {
    context Fulfillment {
      aggregate Order with tenantOwned, crudish { status: string }
      repository Orders for Order { }
      event OrderPlaced { order: Order id, at: datetime }
      channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
    }
    context Accounts {
      aggregate Organization with crudish { name: string }
    }
  }
  api FulfillmentApi from Core
  storage primary { type: postgres }
  resource coreSt { for: Fulfillment, kind: state, use: primary }
  resource acctSt { for: Accounts, kind: state, use: primary }
  deployable backend {
    platform: ${backendPlatform}
    contexts: [Fulfillment, Accounts]${dataSources}
    serves: FulfillmentApi
    port: 3000
    auth: required
  }
}
`;
}

describe("tenant-broadcast honesty gate (`loom.realtime-tenant-broadcast`)", () => {
  it("warns for a tenant-owned realtime context on a broadcast-only backend (dotnet)", async () => {
    const warns = await diags(tenantSys("dotnet"), "loom.realtime-tenant-broadcast");
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("cross the tenant boundary on the wire");
    expect(warns[0]).toContain("OrderPlaced");
  });

  it("warns for python too", async () => {
    expect((await diags(tenantSys("python"), "loom.realtime-tenant-broadcast")).length).toBe(1);
  });

  it("does not warn on the node backend (per-tenant rooms ship there)", async () => {
    expect(await diags(tenantSys("node"), "loom.realtime-tenant-broadcast")).toEqual([]);
  });
});
