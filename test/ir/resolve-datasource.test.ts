// Unit tests for the per-aggregate resource resolver.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import {
  dataSourceKindForAggregate,
  isDocumentShaped,
  resolveDataSourceConfig,
  resolveDataSourceForAggregate,
  resolveWorkflowIsolation,
} from "../../src/ir/util/resolve-datasource.js";
import { parseValid } from "../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order {
        name: string
      }
      aggregate Invoice persistedAs: eventLog {
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
  resource ordersState { for: Orders, kind: state, use: primary, schema: "orders" }
  resource ordersEventLog {
    for: Orders, kind: eventLog, use: events, schema: "events", tablePrefix: "orders_"
  }
  resource receiptsState { for: Billing, kind: state, use: primary }
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

  it("returns undefined when no resource matches (no implicit default)", async () => {
    // Construct a system whose deployable has no resource for the
    // hosted (context, kind) pair.  Resolver returns undefined; emitter
    // falls back to its pre-resource default shape.
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
  resource oh { for: OrderHistory, kind: state, use: primary }
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

// ---------------------------------------------------------------------------
// resolveWorkflowIsolation — workflow.transactional(<level>) overrides the
// state-kind dataSource's `isolationLevel:` default; otherwise the dataSource
// value flows through; otherwise undefined.
// ---------------------------------------------------------------------------

describe("resolveWorkflowIsolation", () => {
  async function build(src: string) {
    const loom = enrichLoomModel(lowerModel(await parseValid(src)));
    const sys = loom.systems[0]!;
    const ctx = sys.subdomains[0]!.contexts[0]!;
    return { sys, ctx };
  }

  it("returns the workflow's explicit level when set", async () => {
    const { sys, ctx } = await build(`
system Sys {
  subdomain M { context C {
    aggregate A { x: int }
    workflow doIt transactional(serializable) {
      create() { }
    }
  } }
  storage pg { type: postgres }
  resource cState {
    for: C, kind: state, use: pg, isolationLevel: readCommitted
  }
  deployable api {
    platform: dotnet, contexts: [C], dataSources: [cState], port: 5000
  }
}`);
    const wf = ctx.workflows[0]!;
    expect(resolveWorkflowIsolation(wf, ctx, sys)).toBe("serializable");
  });

  it("falls back to the resource isolationLevel when workflow has none", async () => {
    const { sys, ctx } = await build(`
system Sys {
  subdomain M { context C {
    aggregate A { x: int }
    workflow doIt transactional {
      create() { }
    }
  } }
  storage pg { type: postgres }
  resource cState {
    for: C, kind: state, use: pg, isolationLevel: repeatableRead
  }
  deployable api {
    platform: dotnet, contexts: [C], dataSources: [cState], port: 5000
  }
}`);
    const wf = ctx.workflows[0]!;
    expect(resolveWorkflowIsolation(wf, ctx, sys)).toBe("repeatableRead");
  });

  it("returns undefined when neither workflow nor resource sets a level", async () => {
    const { sys, ctx } = await build(`
system Sys {
  subdomain M { context C {
    aggregate A { x: int }
    workflow doIt transactional {
      create() { }
    }
  } }
  storage pg { type: postgres }
  resource cState { for: C, kind: state, use: pg }
  deployable api {
    platform: dotnet, contexts: [C], dataSources: [cState], port: 5000
  }
}`);
    const wf = ctx.workflows[0]!;
    expect(resolveWorkflowIsolation(wf, ctx, sys)).toBeUndefined();
  });

  it("only consults the state-kind dataSource, not eventLog/cache/etc.", async () => {
    // The state-kind resource has no isolationLevel; an eventLog
    // resource for the same context does — and is correctly ignored.
    const { sys, ctx } = await build(`
system Sys {
  subdomain M { context C {
    aggregate A { x: int }
    aggregate B persistedAs: eventLog { y: int }
    workflow doIt transactional {
      create() { }
    }
  } }
  storage pg { type: postgres }
  resource cState { for: C, kind: state, use: pg }
  resource cLog {
    for: C, kind: eventLog, use: pg, isolationLevel: serializable
  }
  deployable api {
    platform: dotnet, contexts: [C], dataSources: [cState, cLog], port: 5000
  }
}`);
    const wf = ctx.workflows[0]!;
    // The state binding has no level; eventLog binding is ignored.
    expect(resolveWorkflowIsolation(wf, ctx, sys)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isDocumentShaped — per-projection saving-shape resolution
// (D-DOCUMENT-AXIS §8 Q4).  Binding `shape:` wins; aggregate header
// `shape(…)` is the default; absent everywhere ⇒ relational (false).
// ---------------------------------------------------------------------------

describe("isDocumentShaped", () => {
  async function build(src: string) {
    const loom = enrichLoomModel(lowerModel(await parseValid(src)));
    const sys = loom.systems[0]!;
    const ctx = sys.subdomains[0]!.contexts[0]!;
    return { sys, ctx };
  }
  const agg = (ctx: { aggregates: { name: string }[] }, name: string) =>
    ctx.aggregates.find((a) => a.name === name)! as never;

  it("defaults to relational when nothing declares a shape", async () => {
    const { sys, ctx } = await build(`
system Sys {
  subdomain M { context C { aggregate A { x: int } } }
  storage pg { type: postgres }
  resource cState { for: C, kind: state, use: pg }
  deployable api { platform: dotnet, contexts: [C], dataSources: [cState], port: 5000 }
}`);
    const a = agg(ctx, "A");
    expect(isDocumentShaped(a, resolveDataSourceConfig(a, ctx, sys))).toBe(false);
  });

  it("honours the aggregate header `shape: document` with no binding override", async () => {
    const { sys, ctx } = await build(`
system Sys {
  subdomain M { context C { aggregate A shape: document { x: int } } }
  storage pg { type: postgres }
  resource cState { for: C, kind: state, use: pg }
  deployable api { platform: dotnet, contexts: [C], dataSources: [cState], port: 5000 }
}`);
    const a = agg(ctx, "A");
    expect(isDocumentShaped(a, resolveDataSourceConfig(a, ctx, sys))).toBe(true);
  });

  it("honours the aggregate header even with no resource binding at all", async () => {
    const { sys, ctx } = await build(`
system Sys {
  subdomain M { context C { aggregate A shape: document { x: int } } }
  storage pg { type: postgres }
  deployable api { platform: dotnet, contexts: [C], port: 5000 }
}`);
    const a = agg(ctx, "A");
    // resolveDataSourceConfig returns undefined (no binding) — header decides.
    expect(isDocumentShaped(a, resolveDataSourceConfig(a, ctx, sys))).toBe(true);
  });

  it("lets the per-projection binding `shape: document` override a shape: relational header", async () => {
    const { sys, ctx } = await build(`
system Sys {
  subdomain M { context C { aggregate A shape: relational { x: int } } }
  storage pg { type: postgres }
  resource cState { for: C, kind: state, use: pg, shape: document }
  deployable api { platform: dotnet, contexts: [C], dataSources: [cState], port: 5000 }
}`);
    const a = agg(ctx, "A");
    expect(isDocumentShaped(a, resolveDataSourceConfig(a, ctx, sys))).toBe(true);
  });

  it("lets the binding `shape: relational` override a shape: document header", async () => {
    const { sys, ctx } = await build(`
system Sys {
  subdomain M { context C { aggregate A shape: document { x: int } } }
  storage pg { type: postgres }
  resource cState { for: C, kind: state, use: pg, shape: relational }
  deployable api { platform: dotnet, contexts: [C], dataSources: [cState], port: 5000 }
}`);
    const a = agg(ctx, "A");
    expect(isDocumentShaped(a, resolveDataSourceConfig(a, ctx, sys))).toBe(false);
  });
});
