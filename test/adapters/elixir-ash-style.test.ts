// ash — real StyleAdapter for phoenixLiveView (F7b).  Ash's
// architectural shape doesn't decompose per-op or per-aggregate the
// way CQRS / layered do — actions ARE the operations, declared
// inside Resource modules that the ashPostgres PersistenceAdapter
// already emits.  This adapter therefore covers the style-level DI
// registration (ash_domains config) and leaves per-aggregate emit
// to persistence.

import { describe, expect, it } from "vitest";
import { AdapterNotImplementedError, type EmitCtx } from "../../src/generator/_adapters/index.js";
import { ashStyleAdapter } from "../../src/generator/elixir/adapters/ash-style.js";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { EnrichedBoundedContextIR } from "../../src/ir/types/loom-ir.js";
import { resolveStyle } from "../../src/platform/resolve-adapters.js";
import { parseValid } from "../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order {
        name: string
      }
    }
    context Billing {
      aggregate Invoice {
        amount: int
      }
    }
  }
  storage primary { type: postgres }
  resource ordersState  { for: Orders,  kind: state, use: primary }
  resource billingState { for: Billing, kind: state, use: primary }
  ui WebApp {}
  deployable webApp {
    platform: elixir
    contexts: [Orders, Billing]
    dataSources: [ordersState, billingState]
    ui: WebApp
    port: 4000
  }
}
`;

async function buildCtx(): Promise<EmitCtx> {
  const loom = enrichLoomModel(lowerModel(await parseValid(SRC)));
  const sys = loom.systems[0]!;
  const deployable = sys.deployables.find((d) => d.platform === "elixir")!;
  const all: EnrichedBoundedContextIR[] = sys.subdomains.flatMap((s) => s.contexts);
  const contexts = all.filter((c) => deployable.contextNames.includes(c.name));
  return { deployable, contexts, sys, migrations: [] };
}

describe("ash StyleAdapter — phoenixLiveView (real)", () => {
  it("is registered as the phoenixLiveView ash style adapter", () => {
    const resolved = resolveStyle("elixir", "ash");
    expect(resolved).toBe(ashStyleAdapter);
    expect(resolved.name).toBe("ash");
  });

  it("answers capability fields directly", () => {
    expect(ashStyleAdapter.supportedStrategies).toEqual(["state"]);
    expect(ashStyleAdapter.supportedLayouts).toEqual(["byFeature"]);
  });

  it("emitDi lists every context's Ash.Domain module under ash_domains", async () => {
    const ctx = await buildCtx();
    const lines = ashStyleAdapter.emitDi(ctx);
    const joined = lines.join("\n");
    expect(joined).toContain("config :web_app,");
    expect(joined).toContain("ash_domains:");
    // Both contexts' domain modules appear, derived as
    // `<AppModule>.<PascalContextName>`.
    expect(joined).toContain("WebApp.Orders");
    expect(joined).toContain("WebApp.Billing");
  });

  it("emitForAggregate returns [] — Ash's per-aggregate emit lives in ashPostgres", async () => {
    const ctx = await buildCtx();
    const agg = ctx.contexts[0]!.aggregates[0]!;
    expect(ashStyleAdapter.emitForAggregate!(agg, ctx)).toEqual([]);
  });

  it("per-op emitEndpoint + emitHandlerOrService throw — actions ARE the operations in Ash", async () => {
    const ctx = await buildCtx();
    const op = { name: "stub" } as never;
    expect(() => ashStyleAdapter.emitEndpoint(op, ctx)).toThrow(AdapterNotImplementedError);
    expect(() => ashStyleAdapter.emitHandlerOrService(op, ctx)).toThrow(AdapterNotImplementedError);
  });
});
