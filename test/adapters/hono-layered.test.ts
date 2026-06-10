// layered — real StyleAdapter for hono (F6b).  Verifies the adapter
// dispatches through to the existing `buildRoutesFile` via
// `emitForAggregate(agg, ctx)` and tags the produced artifact with
// the right HonoArtifactCategory.

import { describe, expect, it } from "vitest";
import { AdapterNotImplementedError, type EmitCtx } from "../../src/generator/_adapters/index.js";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { EnrichedBoundedContextIR } from "../../src/ir/types/loom-ir.js";
import { layeredStyleAdapter } from "../../src/platform/hono/v4/adapters/layered-style.js";
import { resolveStyle } from "../../src/platform/resolve-adapters.js";
import { parseValid } from "../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order {
        name: string
        invariant name.length > 0
      }
      repository Orders for Order {
        find byName(name: string): Order? where this.name == name
      }
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: hono
    contexts: [Orders]
    dataSources: [ordersState]
    port: 3000
  }
}
`;

async function buildCtx(): Promise<EmitCtx> {
  const loom = enrichLoomModel(lowerModel(await parseValid(SRC)));
  const sys = loom.systems[0]!;
  const deployable = sys.deployables.find((d) => d.platform === "node")!;
  const all: EnrichedBoundedContextIR[] = sys.subdomains.flatMap((s) => s.contexts);
  const contexts = all.filter((c) => deployable.contextNames.includes(c.name));
  return { deployable, contexts, sys, migrations: [] };
}

describe("layered StyleAdapter — hono (real)", () => {
  it("is registered as the hono layered style adapter", () => {
    const resolved = resolveStyle("hono", "layered");
    expect(resolved).toBe(layeredStyleAdapter);
    expect(resolved.name).toBe("layered");
  });

  it("answers capability fields directly", () => {
    expect(layeredStyleAdapter.supportedStrategies).toEqual(["state"]);
    // Both layouts — style/layout are orthogonal (the layout adapter only
    // remaps paths); `layered` emits identically into either.
    expect(layeredStyleAdapter.supportedLayouts).toEqual(["byLayer", "byFeature"]);
  });

  it("emitDi returns no lines (hono wiring lives inline in createApp)", async () => {
    const ctx = await buildCtx();
    expect(layeredStyleAdapter.emitDi(ctx)).toEqual([]);
  });

  it("emitForAggregate wraps buildRoutesFile and returns one http-routes artifact", async () => {
    const ctx = await buildCtx();
    const agg = ctx.contexts[0]!.aggregates.find((a) => a.name === "Order")!;
    const artifacts = layeredStyleAdapter.emitForAggregate!(agg, ctx);
    expect(artifacts).toHaveLength(1);
    const a = artifacts[0]! as (typeof artifacts)[number] & {
      category: string;
      aggregateName: string;
    };
    expect(a.name).toBe("order.routes.ts");
    expect(a.category).toBe("http-routes");
    expect(a.aggregateName).toBe("Order");
    // Spot-check the produced source — `buildRoutesFile` emits an
    // OpenAPIHono router that surfaces the user-declared find.
    expect(a.content).toContain("OpenAPIHono");
    expect(a.content).toContain("byName");
  });

  it("per-op emitEndpoint + emitHandlerOrService throw until F6d decomposes buildRoutesFile", async () => {
    const ctx = await buildCtx();
    // The fixture's aggregate has no user-declared op, so synthesise
    // a stand-in OperationIR — these methods throw before reading op
    // anyway.
    const op = { name: "stub" } as never;
    expect(() => layeredStyleAdapter.emitEndpoint(op, ctx)).toThrow(AdapterNotImplementedError);
    expect(() => layeredStyleAdapter.emitHandlerOrService(op, ctx)).toThrow(
      AdapterNotImplementedError,
    );
  });
});
