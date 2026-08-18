// Rooms + policy-derived routing v1 (channels.md — "Realtime topology").
// Two IR-level gates:
//   - `loom.relay-target-not-subscribed` (error): a ui subscribes to a channel
//     via an `on <chan>.<Event>` handler, but its relay backend (the one its
//     frontend `targets:`) neither hosts the channel's owning context nor binds
//     it — the SSE relay can't legally serve those events.
//
// The former `loom.realtime-tenant-broadcast` warning (tenant-owned realtime
// on a non-node SSE backend over-delivers cross-tenant) is retired: per-tenant
// rooms now ship on ALL SSE backends (node/dotnet/java/python), so the gap the
// warning tracked no longer exists.  Per-backend room emission is asserted in
// test/generator/{dotnet,java,python}/realtime-emission.test.ts.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { BoundedContextIR, SystemIR } from "../../src/ir/types/loom-ir.js";
import { type RealtimeRoomPlan, realtimeRoomPlan } from "../../src/ir/util/realtime-rooms.js";
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

// ─── rooms parity: no residual tenant-broadcast warning ─────────────────────

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

describe("realtime rooms parity (`loom.realtime-tenant-broadcast` retired)", () => {
  // Per-tenant rooms ship on every SSE backend now, so the honesty warning
  // that flagged the .NET / Java / Python over-delivery gap is gone entirely.
  it.each([
    "dotnet",
    "java",
    "python",
    "node",
  ])("raises no tenant-broadcast warning on %s", async (backend) => {
    expect(await diags(tenantSys(backend), "loom.realtime-tenant-broadcast")).toEqual([]);
  });
});

// ─── Fail-closed tenant classification (A4) ─────────────────────────────────
//
// `realtimeRoomPlan` used to mark an event tenant-scoped IFF it carried an
// `<Agg> id` field pointing at a `tenantOwned` aggregate.  An event with a
// scalar payload about tenant data but no id reference therefore landed in the
// GLOBAL set — its full payload streamed to every connected tenant.  The
// default is inverted now: inside a tenant-owned context an event is global
// only on POSITIVE evidence that it is about `crossTenant` (shared) data.

const CLASSIFY_SYS = `
system Classify {
  user { id: guid  orgId: string }
  tenancy by user.orgId of Organization
  subdomain Core {
    context Billing {
      aggregate Invoice with tenantOwned, crudish {
        number: string
        operation issue() { emit InvoiceIssued { invoice: id } }
        // Carries no id reference at all — the fail-open case.
        operation remind() { emit ReminderSent { note: number } }
      }
      repository Invoices for Invoice { }
      aggregate Plan crossTenant with crudish {
        title: string
        operation publish() { emit PlanPublished { title: title } }
      }
      repository Plans for Plan { }
      event InvoiceIssued { invoice: Invoice id }
      event ReminderSent { note: string }
      event PlanPublished { title: string }
      channel Lifecycle {
        carries: InvoiceIssued, ReminderSent, PlanPublished
        delivery: broadcast
        retention: ephemeral
      }
    }
    context Accounts {
      aggregate Organization with crudish { name: string }
    }
  }
  api BillingApi from Core
  storage primary { type: postgres }
  resource billingSt { for: Billing, kind: state, use: primary }
  resource acctSt { for: Accounts, kind: state, use: primary }
  deployable backend {
    platform: node
    contexts: [Billing, Accounts]
    dataSources: [billingSt, acctSt]
    serves: BillingApi
    port: 3000
    auth: required
  }
}
`;

async function planFor(source: string, contextName: string): Promise<RealtimeRoomPlan> {
  const { model } = await parseString(source, { validate: false });
  const ir = enrichLoomModel(lowerModel(model));
  const sys: SystemIR = ir.systems[0]!;
  let ctx: BoundedContextIR | undefined;
  for (const sub of sys.subdomains) {
    const hit = sub.contexts.find((c) => c.name === contextName);
    if (hit) ctx = hit;
  }
  expect(ctx, `context ${contextName} not found`).toBeDefined();
  return realtimeRoomPlan(ctx as BoundedContextIR, sys);
}

describe("realtime tenant classification is fail-closed", () => {
  it("an id-less event out of a tenant-owned context is NOT in the global set", async () => {
    const plan = await planFor(CLASSIFY_SYS, "Billing");
    expect(plan.tenantScoped).toBe(true);
    expect(plan.tenantEventTypes.has("ReminderSent")).toBe(true);
    // No id reference to keep — the ticket degrades to the `type` alone, which
    // is the point: no scalar payload crosses a tenant boundary.
    expect(plan.eventIdFields.get("ReminderSent")).toEqual([]);
  });

  it("an event referencing a tenantOwned aggregate stays tenant-scoped with its ids", async () => {
    const plan = await planFor(CLASSIFY_SYS, "Billing");
    expect(plan.tenantEventTypes.has("InvoiceIssued")).toBe(true);
    expect(plan.eventIdFields.get("InvoiceIssued")).toEqual(["invoice"]);
  });

  it("an event out of a `crossTenant` aggregate stays global", async () => {
    const plan = await planFor(CLASSIFY_SYS, "Billing");
    expect(plan.tenantEventTypes.has("PlanPublished")).toBe(false);
  });

  it("carries the bound tenancy claim, never the row column", async () => {
    const plan = await planFor(CLASSIFY_SYS, "Billing");
    expect(plan.tenantClaimField).toBe("orgId");
  });

  it("an untenanted context keeps the v1 broadcast plan", async () => {
    const untenanted = tenantSys("node").replace("with tenantOwned, crudish", "with crudish");
    const plan = await planFor(untenanted, "Fulfillment");
    expect(plan.tenantScoped).toBe(false);
    expect(plan.tenantEventTypes.size).toBe(0);
  });
});
