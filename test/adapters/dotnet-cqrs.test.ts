// cqrs — real StyleAdapter for dotnet (F5b).  Verifies the adapter
// dispatches through to the existing `emitCqrs` orchestrator via
// `emitForAggregate(agg, ctx)` and classifies every produced file
// into the right DotnetArtifactCategory so the byLayer layout
// adapter can route them without ambiguity.
//
// The per-op `emitEndpoint` / `emitHandlerOrService` methods are real
// since the F5d decomposition split `emitCqrs` into per-op pieces;
// byte-equality with the per-aggregate packaging is gated by
// `cqrs-style-per-op.test.ts`.

import { describe, expect, it } from "vitest";
import type { EmitCtx } from "../../src/generator/_adapters/index.js";
import { cqrsStyleAdapter } from "../../src/generator/dotnet/adapters/cqrs-style.js";
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
        status: int
        invariant name.length > 0
        create(name: string, status: int) { name := name  status := status }
        operation confirm() {
          precondition status == 0
          status := 1
        }
      }
      repository Orders for Order {
        find byName(name: string): Order? where this.name == name
      }
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: dotnet
    contexts: [Orders]
    dataSources: [ordersState]
    port: 5000
  }
}
`;

async function buildCtx(): Promise<EmitCtx> {
  const loom = enrichLoomModel(lowerModel(await parseValid(SRC)));
  const sys = loom.systems[0]!;
  const deployable = sys.deployables.find((d) => d.platform === "dotnet")!;
  const all: EnrichedBoundedContextIR[] = sys.subdomains.flatMap((s) => s.contexts);
  const contexts = all.filter((c) => deployable.contextNames.includes(c.name));
  return { deployable, contexts, sys, migrations: [] };
}

describe("cqrs StyleAdapter — dotnet (real)", () => {
  it("is registered as the dotnet cqrs style adapter", () => {
    const resolved = resolveStyle("dotnet", "cqrs");
    expect(resolved).toBe(cqrsStyleAdapter);
    expect(resolved.name).toBe("cqrs");
  });

  it("answers capability fields directly", () => {
    expect(cqrsStyleAdapter.supportedStrategies).toEqual(["state", "eventLog"]);
    expect(cqrsStyleAdapter.supportedLayouts).toEqual(["byLayer", "byFeature"]);
  });

  it("emitDi returns MediatR + FluentValidation registration lines (when validators are present)", async () => {
    const ctx = await buildCtx();
    const lines = cqrsStyleAdapter.emitDi(ctx);
    const joined = lines.join("\n");
    // The fixture has an op with a precondition → wire-validator branch fires.
    expect(joined).toContain("AddValidatorsFromAssembly");
    expect(joined).toContain("ValidationBehavior");
    // The deployable's namespace flows through into the behavior type.
    expect(joined).toContain("Api.Application.Common.ValidationBehavior");
  });

  it("emitForAggregate wraps emitCqrs end-to-end", async () => {
    const ctx = await buildCtx();
    const agg = ctx.contexts[0]!.aggregates.find((a) => a.name === "Order")!;
    const artifacts = cqrsStyleAdapter.emitForAggregate!(agg, ctx);
    expect(artifacts.length).toBeGreaterThan(0);
    // Every artifact carries the right aggregate + a recognised category.
    for (const a of artifacts) {
      const tagged = a as typeof a & {
        category: string;
        aggregateName: string;
      };
      expect(tagged.aggregateName).toBe("Order");
      expect(tagged.category).toBeDefined();
    }
    // Spot-check the produced surface: there's a controller, a
    // create-command, a get-by-id query, and the named find.
    const names = artifacts.map((a) => a.name);
    expect(names.some((n) => n === "OrdersController.cs")).toBe(true);
    expect(names.some((n) => n.startsWith("CreateOrder") && n.endsWith("Command.cs"))).toBe(true);
    expect(names.some((n) => n.startsWith("GetOrderById"))).toBe(true);
    expect(names.some((n) => n.includes("ByName"))).toBe(true);
  });

  it("emitForAggregate categorises produced artifacts so the byLayer adapter routes them", async () => {
    const ctx = await buildCtx();
    const agg = ctx.contexts[0]!.aggregates.find((a) => a.name === "Order")!;
    const artifacts = cqrsStyleAdapter.emitForAggregate!(agg, ctx);
    const byCategory = new Map<string, string[]>();
    for (const a of artifacts) {
      const cat = (a as typeof a & { category: string }).category;
      const list = byCategory.get(cat) ?? [];
      list.push(a.name);
      byCategory.set(cat, list);
    }
    // Every category that should turn up for a CQRS aggregate emit
    // appears at least once.
    expect(byCategory.has("controller")).toBe(true);
    expect(byCategory.has("command")).toBe(true);
    expect(byCategory.has("command-handler")).toBe(true);
    expect(byCategory.has("query")).toBe(true);
    expect(byCategory.has("query-handler")).toBe(true);
    expect(byCategory.has("request-dto")).toBe(true);
    expect(byCategory.has("response-dto")).toBe(true);
  });

  it("emitForAggregate validators surface under command-validator when invariants opt-in", async () => {
    const ctx = await buildCtx();
    const agg = ctx.contexts[0]!.aggregates.find((a) => a.name === "Order")!;
    const artifacts = cqrsStyleAdapter.emitForAggregate!(agg, ctx);
    // The fixture's `confirm` op carries a precondition that lowers
    // to a FluentValidation rule on the matching command.
    const validators = artifacts.filter(
      (a) => (a as typeof a & { category: string }).category === "command-validator",
    );
    expect(validators.length).toBeGreaterThan(0);
    for (const v of validators) {
      expect(v.name).toMatch(/Validator\.cs$/);
    }
  });

  it("per-op emitEndpoint + emitHandlerOrService are real (F5d) — byte-equality is gated in cqrs-style-per-op.test.ts", async () => {
    const ctx = await buildCtx();
    const op = ctx.contexts[0]!.aggregates[0]!.operations[0]!;
    const endpoint = cqrsStyleAdapter.emitEndpoint(op, ctx);
    expect(endpoint.join("\n")).toContain("[HttpPost(");
    const artifacts = cqrsStyleAdapter.emitHandlerOrService(op, ctx);
    expect(artifacts.map((a) => a.name)).toContain(
      `${op.name[0]!.toUpperCase()}${op.name.slice(1)}Command.cs`,
    );
  });
});
