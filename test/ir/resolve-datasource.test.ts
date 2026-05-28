// Unit tests for the per-aggregate dataSource resolver.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import {
  dataSourceKindForAggregate,
  resolveDataSourceConfig,
  resolveDataSourceForAggregate,
} from "../../src/ir/util/resolve-datasource.js";
import { parseValid } from "../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order {
        name: string
      }
      aggregate Invoice {
        persistenceStrategy: eventSourced
        amount: int
      }
    }
    context Billing {
      aggregate Receipt {
        amount: int
      }
    }
  }
  storage primary { type: postgres }
  storage events { type: postgres }
  dataSource ordersState { for: Orders, kind: state, use: primary, schema: "orders" }
  dataSource ordersEventLog {
    for: Orders, kind: eventLog, use: events, schema: "events", tablePrefix: "orders_"
  }
  dataSource receiptsState { for: Billing, kind: state, use: primary }
  deployable api {
    platform: dotnet
    contexts: [Orders, Billing]
    dataSources: [ordersState, ordersEventLog, receiptsState]
    port: 5000
  }
}
`;

describe("dataSourceKindForAggregate", () => {
  it("maps stateBased + (default) to `state`", async () => {
    const loom = enrichLoomModel(lowerModel(await parseValid(SRC)));
    const ctx = loom.systems[0]!.subdomains[0]!.contexts.find((c) => c.name === "Orders")!;
    const order = ctx.aggregates.find((a) => a.name === "Order")!;
    expect(dataSourceKindForAggregate(order)).toBe("state");
  });

  it("maps eventSourced to `eventLog`", async () => {
    const loom = enrichLoomModel(lowerModel(await parseValid(SRC)));
    const ctx = loom.systems[0]!.subdomains[0]!.contexts.find((c) => c.name === "Orders")!;
    const invoice = ctx.aggregates.find((a) => a.name === "Invoice")!;
    expect(dataSourceKindForAggregate(invoice)).toBe("eventLog");
  });
});

describe("resolveDataSourceForAggregate", () => {
  it("resolves a stateBased aggregate to its kind:state dataSource", async () => {
    const loom = enrichLoomModel(lowerModel(await parseValid(SRC)));
    const sys = loom.systems[0]!;
    const ctx = sys.subdomains[0]!.contexts.find((c) => c.name === "Orders")!;
    const order = ctx.aggregates.find((a) => a.name === "Order")!;
    const ds = resolveDataSourceForAggregate(order, ctx, sys);
    expect(ds?.name).toBe("ordersState");
    expect(ds?.schema).toBe("orders");
  });

  it("resolves an eventSourced aggregate to its kind:eventLog dataSource", async () => {
    const loom = enrichLoomModel(lowerModel(await parseValid(SRC)));
    const sys = loom.systems[0]!;
    const ctx = sys.subdomains[0]!.contexts.find((c) => c.name === "Orders")!;
    const invoice = ctx.aggregates.find((a) => a.name === "Invoice")!;
    const ds = resolveDataSourceForAggregate(invoice, ctx, sys);
    expect(ds?.name).toBe("ordersEventLog");
    expect(ds?.schema).toBe("events");
    expect(ds?.tablePrefix).toBe("orders_");
  });

  it("resolves a different context's aggregate to its own dataSource", async () => {
    const loom = enrichLoomModel(lowerModel(await parseValid(SRC)));
    const sys = loom.systems[0]!;
    const ctx = sys.subdomains[0]!.contexts.find((c) => c.name === "Billing")!;
    const receipt = ctx.aggregates.find((a) => a.name === "Receipt")!;
    const ds = resolveDataSourceForAggregate(receipt, ctx, sys);
    expect(ds?.name).toBe("receiptsState");
    // No schema declared on this binding → raw IR value is undefined.
    // (The defaulting to `snake(ctx.name)` lives in resolveDataSourceConfig,
    // not the raw resolver — see resolveDataSourceConfig tests below.)
    expect(ds?.schema).toBeUndefined();
  });

  it("returns undefined when the aggregate doesn't belong to the passed context", async () => {
    const loom = enrichLoomModel(lowerModel(await parseValid(SRC)));
    const sys = loom.systems[0]!;
    const ordersCtx = sys.subdomains[0]!.contexts.find((c) => c.name === "Orders")!;
    const billingCtx = sys.subdomains[0]!.contexts.find((c) => c.name === "Billing")!;
    const order = ordersCtx.aggregates.find((a) => a.name === "Order")!;
    // Order belongs to Orders, not Billing → no match.
    expect(resolveDataSourceForAggregate(order, billingCtx, sys)).toBeUndefined();
  });
});

describe("resolveDataSourceConfig (with implicit defaults)", () => {
  it("passes the DSL `schema:` through verbatim when set", async () => {
    const loom = enrichLoomModel(lowerModel(await parseValid(SRC)));
    const sys = loom.systems[0]!;
    const ctx = sys.subdomains[0]!.contexts.find((c) => c.name === "Orders")!;
    const order = ctx.aggregates.find((a) => a.name === "Order")!;
    const cfg = resolveDataSourceConfig(order, ctx, sys);
    expect(cfg?.schema).toBe("orders");
    expect(cfg?.name).toBe("ordersState");
  });

  it("defaults schema to snake(context.name) when DSL omits `schema:`", async () => {
    const loom = enrichLoomModel(lowerModel(await parseValid(SRC)));
    const sys = loom.systems[0]!;
    const ctx = sys.subdomains[0]!.contexts.find((c) => c.name === "Billing")!;
    const receipt = ctx.aggregates.find((a) => a.name === "Receipt")!;
    const cfg = resolveDataSourceConfig(receipt, ctx, sys);
    // Billing context, no DSL schema → defaulted to "billing".
    expect(cfg?.schema).toBe("billing");
  });

  it("returns undefined when no dataSource matches (no implicit default)", async () => {
    // Construct a system whose deployable has no dataSource for the
    // hosted (context, kind) pair.  Resolver returns undefined; emitter
    // falls back to its pre-dataSource default shape.
    const noDsSrc = `
system Sys {
  subdomain Sales { context Orders { aggregate Order { name: string } } }
  storage primary { type: postgres }
  deployable api { platform: dotnet, contexts: [Orders], port: 5000 }
}`;
    const loom = enrichLoomModel(lowerModel(await parseValid(noDsSrc)));
    const sys = loom.systems[0]!;
    const ctx = sys.subdomains[0]!.contexts[0]!;
    const order = ctx.aggregates[0]!;
    expect(resolveDataSourceConfig(order, ctx, sys)).toBeUndefined();
  });

  it("snake-cases a multi-word context name for the default", async () => {
    const camelSrc = `
system Sys {
  subdomain S { context OrderHistory { aggregate Snapshot { tag: string } } }
  storage primary { type: postgres }
  dataSource oh { for: OrderHistory, kind: state, use: primary }
  deployable api {
    platform: dotnet, contexts: [OrderHistory], dataSources: [oh], port: 5000
  }
}`;
    const loom = enrichLoomModel(lowerModel(await parseValid(camelSrc)));
    const sys = loom.systems[0]!;
    const ctx = sys.subdomains[0]!.contexts[0]!;
    const agg = ctx.aggregates[0]!;
    const cfg = resolveDataSourceConfig(agg, ctx, sys);
    // OrderHistory → order_history.
    expect(cfg?.schema).toBe("order_history");
  });
});
