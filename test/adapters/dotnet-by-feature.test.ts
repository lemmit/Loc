// byFeature — real LayoutAdapter for dotnet (D-REALIZATION-AXES Phase 5a/5b).
// The dotnet layout where a `directoryLayout:` selection has an observable
// effect: it colocates EVERY per-aggregate artifact — domain model +
// persistence + application + API — under `Features/<Aggregate>/` (vertical
// slice) instead of byLayer's layer folders.  Cross-cutting / shared artifacts
// (context-level Domain primitives, shared Infrastructure, views, workflows,
// the Tests project, the root) delegate to byLayer, so the tree stays coherent.

import { describe, expect, it } from "vitest";
import type { EmitCtx } from "../../src/generator/_adapters/index.js";
import { byFeatureLayoutAdapter } from "../../src/generator/dotnet/adapters/by-feature-layout.js";
import {
  byLayerLayoutAdapter,
  type DotnetArtifact,
} from "../../src/generator/dotnet/adapters/by-layer-layout.js";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { EnrichedBoundedContextIR } from "../../src/ir/types/loom-ir.js";
import dotnetPlatform from "../../src/platform/dotnet.js";
import { resolveLayout, resolveStyle } from "../../src/platform/resolve-adapters.js";
import { parseValid } from "../_helpers/parse.js";

const ctx = {} as EmitCtx; // path routing ignores ctx

function p(
  a: Partial<DotnetArtifact> & { name: string; category: DotnetArtifact["category"] },
): string {
  return byFeatureLayoutAdapter.pathFor({ content: "", ...a } as DotnetArtifact, ctx);
}

describe("byFeature LayoutAdapter — dotnet (real, Phase 5a)", () => {
  it("is registered as the dotnet byFeature layout adapter", () => {
    const resolved = resolveLayout("dotnet", "byFeature");
    expect(resolved).toBe(byFeatureLayoutAdapter);
    expect(resolved.name).toBe("byFeature");
  });

  it("colocates an aggregate's CQRS artifacts under Features/<Aggregate>/", () => {
    expect(p({ name: "CreateOrder.cs", category: "command", aggregateName: "Order" })).toBe(
      "Features/Order/Commands/CreateOrder.cs",
    );
    expect(
      p({ name: "CreateOrderHandler.cs", category: "command-handler", aggregateName: "Order" }),
    ).toBe("Features/Order/Commands/CreateOrderHandler.cs");
    expect(
      p({ name: "CreateOrderValidator.cs", category: "command-validator", aggregateName: "Order" }),
    ).toBe("Features/Order/Commands/CreateOrderValidator.cs");
    expect(p({ name: "GetOrderById.cs", category: "query", aggregateName: "Order" })).toBe(
      "Features/Order/Queries/GetOrderById.cs",
    );
    expect(
      p({ name: "GetOrderByIdHandler.cs", category: "query-handler", aggregateName: "Order" }),
    ).toBe("Features/Order/Queries/GetOrderByIdHandler.cs");
    expect(
      p({ name: "CreateOrderRequest.cs", category: "request-dto", aggregateName: "Order" }),
    ).toBe("Features/Order/Requests/CreateOrderRequest.cs");
    expect(p({ name: "OrderResponse.cs", category: "response-dto", aggregateName: "Order" })).toBe(
      "Features/Order/Responses/OrderResponse.cs",
    );
  });

  it("colocates extern handlers + the controller at the feature root", () => {
    expect(
      p({
        name: "IExternFooHandler.cs",
        category: "extern-handler-interface",
        aggregateName: "Order",
      }),
    ).toBe("Features/Order/Handlers/IExternFooHandler.cs");
    expect(
      p({
        name: "ExternFooHandlerStub.cs",
        category: "extern-handler-stub",
        aggregateName: "Order",
      }),
    ).toBe("Features/Order/Handlers/ExternFooHandlerStub.cs");
    // The controller sits at the feature root — the slice's API surface.
    expect(p({ name: "OrdersController.cs", category: "controller", aggregateName: "Order" })).toBe(
      "Features/Order/OrdersController.cs",
    );
  });

  it("uses the singular aggregate name (not byLayer's plural) for the folder", () => {
    expect(p({ name: "x.cs", category: "command", aggregateName: "category" })).toBe(
      "Features/Category/Commands/x.cs",
    );
    expect(p({ name: "x.cs", category: "command", aggregateName: "Box" })).toBe(
      "Features/Box/Commands/x.cs",
    );
  });

  it("colocates the aggregate's domain model + persistence under Features/<Aggregate>/", () => {
    // The rest of the vertical slice: entity (root/parts/abstract/snapshots),
    // repository interface + impl, EF config (relational + document), join
    // tables, and the document POCO — all flatten to the feature root.
    expect(p({ name: "Order.cs", category: "entity", aggregateName: "Order" })).toBe(
      "Features/Order/Order.cs",
    );
    expect(
      p({ name: "IOrderRepository.cs", category: "repository-interface", aggregateName: "Order" }),
    ).toBe("Features/Order/IOrderRepository.cs");
    expect(
      p({ name: "OrderRepository.cs", category: "repository-impl", aggregateName: "Order" }),
    ).toBe("Features/Order/OrderRepository.cs");
    expect(
      p({ name: "OrderConfiguration.cs", category: "ef-configuration", aggregateName: "Order" }),
    ).toBe("Features/Order/OrderConfiguration.cs");
    expect(p({ name: "OrderTags.cs", category: "join-entity", aggregateName: "Order" })).toBe(
      "Features/Order/OrderTags.cs",
    );
    expect(p({ name: "OrderDocument.cs", category: "document-poco", aggregateName: "Order" })).toBe(
      "Features/Order/OrderDocument.cs",
    );
  });

  it("still delegates CROSS-CUTTING categories to byLayer (shared Infra / root / views / tests)", () => {
    // Context-level + shared artifacts return the IDENTICAL path byLayer would.
    for (const a of [
      { name: "OrderId.cs", category: "id" },
      { name: "Status.cs", category: "enum" },
      { name: "Money.cs", category: "valueobject" },
      { name: "OrderPlaced.cs", category: "event" },
      { name: "AppDbContext.cs", category: "dbcontext" },
      { name: "NoopDomainEventDispatcher.cs", category: "event-dispatcher" },
      { name: "ActiveOrdersQuery.cs", category: "view-query" },
      { name: "PlaceOrderHandler.cs", category: "workflow-handler" },
      { name: "ValidationBehavior.cs", category: "validation-behavior" },
      { name: "Program.cs", category: "program" },
      { name: "OrderTests.cs", category: "test-class", ns: "api", aggregateName: "Order" },
    ] as const) {
      const art = { content: "", ...a } as DotnetArtifact;
      expect(byFeatureLayoutAdapter.pathFor(art, ctx)).toBe(byLayerLayoutAdapter.pathFor(art, ctx));
    }
  });

  it("throws a clear error when a feature category lacks aggregateName", () => {
    expect(() => p({ name: "CreateOrder.cs", category: "command" })).toThrow(
      /missing aggregateName/,
    );
  });

  it("throws when an artifact arrives without a category tag", () => {
    expect(() => byFeatureLayoutAdapter.pathFor({ name: "X.cs", content: "" }, ctx)).toThrow(
      /missing a category/,
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a `directoryLayout: byFeature` selection actually relocates the
// emitted files — and does so as a PURE relocation (identical file contents,
// only the app/API paths differ from the byLayer default).
// ---------------------------------------------------------------------------

const SRC = (layout: string) => `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order {
        name: string
        status: int
        invariant name.length > 0
        operation confirm() { precondition status == 0  status := 1 }
      }
      repository Orders for Order {
        find byName(name: string): Order? where this.name == name
      }
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: dotnet${layout}
    contexts: [Orders]
    dataSources: [ordersState]
    port: 5000
  }
}
`;

async function emit(layout: string): Promise<Map<string, string>> {
  const loom = enrichLoomModel(lowerModel(await parseValid(SRC(layout))));
  const sys = loom.systems[0]!;
  const d = sys.deployables[0]!;
  const contexts: EnrichedBoundedContextIR[] = sys.subdomains
    .flatMap((s) => s.contexts)
    .filter((c) => d.contextNames.includes(c.name));
  // Mirror the system orchestrator: resolve the deployable's axis selection
  // and thread the adapters into emitProject.
  return dotnetPlatform.emitProject({
    contexts,
    deployable: d,
    sys,
    migrations: [],
    styleAdapter: resolveStyle("dotnet", d.application),
    layoutAdapter: resolveLayout("dotnet", d.directoryLayout),
  });
}

describe("byFeature end-to-end emit — dotnet", () => {
  it("colocates the whole feature (domain + persistence + app + API) under Features/Order/", async () => {
    const files = await emit(" { directoryLayout: byFeature }");
    const paths = [...files.keys()];
    // CQRS + controller…
    expect(paths.some((p) => p.startsWith("Features/Order/Commands/"))).toBe(true);
    expect(paths).toContain("Features/Order/OrdersController.cs");
    // …domain model + persistence join the feature folder…
    expect(paths).toContain("Features/Order/Order.cs");
    expect(paths).toContain("Features/Order/IOrderRepository.cs");
    expect(paths).toContain("Features/Order/OrderRepository.cs");
    expect(paths).toContain("Features/Order/OrderConfiguration.cs");
    // …and the per-aggregate byLayer folders are now empty of Order's files.
    expect(paths.some((p) => p.startsWith("Application/Orders/"))).toBe(false);
    expect(paths.some((p) => p === "Api/OrdersController.cs")).toBe(false);
    expect(paths.some((p) => p.startsWith("Domain/Orders/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("Infrastructure/Repositories/"))).toBe(false);
    // Shared, cross-cutting infrastructure STAYS layered.
    expect(paths).toContain("Infrastructure/Persistence/AppDbContext.cs");
  });

  it("the default (byLayer) emit produces NO Features/ folder", async () => {
    const files = await emit("");
    expect([...files.keys()].some((p) => p.startsWith("Features/"))).toBe(false);
    expect(files.has("Api/OrdersController.cs")).toBe(true);
  });

  it("is a pure relocation: the same set of file CONTENTS, only paths differ", async () => {
    const byLayer = await emit(" { directoryLayout: byLayer }");
    const byFeature = await emit(" { directoryLayout: byFeature }");
    // Same number of files.
    expect(byFeature.size).toBe(byLayer.size);
    // The multiset of file CONTENTS is identical — byFeature moves files,
    // it never changes a byte of any artifact.
    const sortedContents = (m: Map<string, string>) => [...m.values()].sort();
    expect(sortedContents(byFeature)).toEqual(sortedContents(byLayer));
    // But the path sets differ (the app/API files moved).
    const sortedPaths = (m: Map<string, string>) => [...m.keys()].sort();
    expect(sortedPaths(byFeature)).not.toEqual(sortedPaths(byLayer));
  });
});
