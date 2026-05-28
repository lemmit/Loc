// Unit tests for the per-aggregate dataSource resolver.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import {
  dataSourceKindForAggregate,
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
    // No schema declared on this binding → undefined (emitter falls back
    // to the default single-arg ToTable).
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
