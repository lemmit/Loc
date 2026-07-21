// byFeature — real LayoutAdapter for dotnet (D-REALIZATION-AXES Phase 5a/5b/5e).
// The dotnet layout where a `directoryLayout:` selection has an observable
// effect: it colocates EVERY per-aggregate artifact — domain model +
// persistence + application + API — under `Features/<Plural>/` (vertical
// slice) instead of byLayer's layer folders, and (Phase 5e) rewrites each
// relocated file's C# namespace to MIRROR its feature folder
// (`namespace <Ns>.Features.Orders.Commands;`), fixing every `using` /
// qualified reference project-wide.  Cross-cutting / shared artifacts
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

  it("colocates an aggregate's CQRS artifacts under Features/<Plural>/", () => {
    expect(p({ name: "CreateOrder.cs", category: "command", aggregateName: "Order" })).toBe(
      "Features/Orders/Commands/CreateOrder.cs",
    );
    expect(
      p({ name: "CreateOrderHandler.cs", category: "command-handler", aggregateName: "Order" }),
    ).toBe("Features/Orders/Commands/CreateOrderHandler.cs");
    expect(
      p({ name: "CreateOrderValidator.cs", category: "command-validator", aggregateName: "Order" }),
    ).toBe("Features/Orders/Commands/CreateOrderValidator.cs");
    expect(p({ name: "GetOrderById.cs", category: "query", aggregateName: "Order" })).toBe(
      "Features/Orders/Queries/GetOrderById.cs",
    );
    expect(
      p({ name: "GetOrderByIdHandler.cs", category: "query-handler", aggregateName: "Order" }),
    ).toBe("Features/Orders/Queries/GetOrderByIdHandler.cs");
    expect(
      p({ name: "CreateOrderRequest.cs", category: "request-dto", aggregateName: "Order" }),
    ).toBe("Features/Orders/Requests/CreateOrderRequest.cs");
    expect(p({ name: "OrderResponse.cs", category: "response-dto", aggregateName: "Order" })).toBe(
      "Features/Orders/Responses/OrderResponse.cs",
    );
  });

  it("colocates extern handlers + the controller at the feature root", () => {
    expect(
      p({
        name: "IExternFooHandler.cs",
        category: "extern-handler-interface",
        aggregateName: "Order",
      }),
    ).toBe("Features/Orders/Handlers/IExternFooHandler.cs");
    expect(
      p({
        name: "ExternFooHandlerStub.cs",
        category: "extern-handler-stub",
        aggregateName: "Order",
      }),
    ).toBe("Features/Orders/Handlers/ExternFooHandlerStub.cs");
    // The controller sits at the feature root — the slice's API surface.
    expect(p({ name: "OrdersController.cs", category: "controller", aggregateName: "Order" })).toBe(
      "Features/Orders/OrdersController.cs",
    );
  });

  it("uses the PLURAL aggregate name for the folder (the namespace-mirror invariant)", () => {
    // Plural on purpose: the namespace mirrors the folder, and a SINGULAR
    // segment would collide with the aggregate's type name — C# resolves
    // simple names against enclosing namespaces before `using` directives,
    // so cross-feature references (`class Customer : Party`) would bind the
    // namespace instead of the type (CS0118).  See by-feature-layout.ts.
    expect(p({ name: "x.cs", category: "command", aggregateName: "category" })).toBe(
      "Features/Categories/Commands/x.cs",
    );
    expect(p({ name: "x.cs", category: "command", aggregateName: "Box" })).toBe(
      "Features/Boxes/Commands/x.cs",
    );
  });

  it("colocates the aggregate's domain model + persistence under Features/<Plural>/", () => {
    // The rest of the vertical slice: entity (root/parts/abstract/snapshots),
    // repository interface + impl, EF config (relational + document), join
    // tables, and the document POCO — all flatten to the feature root.
    expect(p({ name: "Order.cs", category: "entity", aggregateName: "Order" })).toBe(
      "Features/Orders/Order.cs",
    );
    expect(
      p({ name: "IOrderRepository.cs", category: "repository-interface", aggregateName: "Order" }),
    ).toBe("Features/Orders/IOrderRepository.cs");
    expect(
      p({ name: "OrderRepository.cs", category: "repository-impl", aggregateName: "Order" }),
    ).toBe("Features/Orders/OrderRepository.cs");
    expect(
      p({ name: "OrderConfiguration.cs", category: "ef-configuration", aggregateName: "Order" }),
    ).toBe("Features/Orders/OrderConfiguration.cs");
    expect(p({ name: "OrderTags.cs", category: "join-entity", aggregateName: "Order" })).toBe(
      "Features/Orders/OrderTags.cs",
    );
    expect(p({ name: "OrderDocument.cs", category: "document-poco", aggregateName: "Order" })).toBe(
      "Features/Orders/OrderDocument.cs",
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
// emitted files — and (Phase 5e) rewrites each relocated file's namespace to
// mirror its feature folder, fixing every reference project-wide.
// ---------------------------------------------------------------------------

const SRC = (layout: string) => `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
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

// Inheritance is the case the PLURAL feature folder exists for: the concrete
// entity references its abstract base by simple name (`class Customer :
// Party`), which must keep resolving to the TYPE once both live under
// per-feature namespaces.
const INHERITANCE_SRC = `
system Registry {
  subdomain Core {
    context Parties {
      abstract aggregate Party inheritanceUsing: sharedTable {
        name: string
      }
      aggregate Customer extends Party {
        creditLimit: int
      }
      aggregate Vendor extends Party {
        rating: int
      }
      repository Customers for Customer { }
      repository Vendors for Vendor { }
    }
  }
  storage pg { type: postgres }
  resource partiesState { for: Parties, kind: state, use: pg }
  deployable api {
    platform: dotnet { directoryLayout: byFeature }
    contexts: [Parties]
    dataSources: [partiesState]
    port: 5000
  }
}
`;

async function emitSrc(src: string): Promise<Map<string, string>> {
  const loom = enrichLoomModel(lowerModel(await parseValid(src)));
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
    styleAdapter: resolveStyle("dotnet", null),
    layoutAdapter: resolveLayout("dotnet", d.directoryLayout),
  });
}

const emit = (layout: string) => emitSrc(SRC(layout));

/** Every namespace DECLARED somewhere in the emitted project (file-scoped
 *  and block forms). */
function declaredNamespaces(files: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const [path, content] of files) {
    if (!path.endsWith(".cs")) continue;
    for (const m of content.matchAll(/^namespace ([A-Za-z_][\w.]*)/gm)) out.add(m[1]!);
  }
  return out;
}

describe("byFeature end-to-end emit — dotnet", () => {
  it("colocates the whole feature (domain + persistence + app + API) under Features/Orders/", async () => {
    const files = await emit(" { directoryLayout: byFeature }");
    const paths = [...files.keys()];
    // CQRS + controller…
    expect(paths.some((p) => p.startsWith("Features/Orders/Commands/"))).toBe(true);
    expect(paths).toContain("Features/Orders/OrdersController.cs");
    // …domain model + persistence join the feature folder…
    expect(paths).toContain("Features/Orders/Order.cs");
    expect(paths).toContain("Features/Orders/IOrderRepository.cs");
    expect(paths).toContain("Features/Orders/OrderRepository.cs");
    expect(paths).toContain("Features/Orders/OrderConfiguration.cs");
    // …and the per-aggregate byLayer folders are now empty of Order's files.
    expect(paths.some((p) => p.startsWith("Application/Orders/"))).toBe(false);
    expect(paths.some((p) => p === "Api/OrdersController.cs")).toBe(false);
    expect(paths.some((p) => p.startsWith("Domain/Orders/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("Infrastructure/Repositories/"))).toBe(false);
    // Shared, cross-cutting infrastructure STAYS layered.
    expect(paths).toContain("Infrastructure/Persistence/AppDbContext.cs");
  });

  it("the default (byLayer) emit produces NO Features/ folder and NO Features namespaces", async () => {
    const files = await emit("");
    expect([...files.keys()].some((p) => p.startsWith("Features/"))).toBe(false);
    expect(files.has("Api/OrdersController.cs")).toBe(true);
    for (const content of files.values()) {
      expect(content).not.toContain(".Features.");
    }
  });

  it("rewrites each relocated file's namespace to mirror its feature folder", async () => {
    const files = await emit(" { directoryLayout: byFeature }");
    expect(files.get("Features/Orders/Order.cs")).toContain("namespace Api.Features.Orders;");
    expect(files.get("Features/Orders/OrdersController.cs")).toContain(
      "namespace Api.Features.Orders;",
    );
    expect(files.get("Features/Orders/Commands/CreateOrderCommand.cs")).toContain(
      "namespace Api.Features.Orders.Commands;",
    );
    expect(files.get("Features/Orders/Queries/ByNameQuery.cs")).toContain(
      "namespace Api.Features.Orders.Queries;",
    );
    expect(files.get("Features/Orders/Requests/OrderRequests.cs")).toContain(
      "namespace Api.Features.Orders.Requests;",
    );
    expect(files.get("Features/Orders/Responses/OrderResponses.cs")).toContain(
      "namespace Api.Features.Orders.Responses;",
    );
  });

  it("rewrites cross-file references: usings, DI registrations, DbContext config wiring", async () => {
    const files = await emit(" { directoryLayout: byFeature }");
    // The controller imports its sibling slice namespaces.
    const controller = files.get("Features/Orders/OrdersController.cs")!;
    expect(controller).toContain("using Api.Features.Orders.Commands;");
    expect(controller).toContain("using Api.Features.Orders.Responses;");
    // The repository impl shares the feature-root namespace with the entity +
    // interface, so its old Domain import is dropped rather than rewritten.
    const repo = files.get("Features/Orders/OrderRepository.cs")!;
    expect(repo).not.toContain("using Api.Features.Orders;");
    // Program.cs DI registration follows the moved types (it references them
    // fully qualified, not via usings).
    expect(files.get("Program.cs")).toContain(
      "builder.Services.AddScoped<Api.Features.Orders.IOrderRepository, Api.Features.Orders.OrderRepository>();",
    );
    // AppDbContext keeps its shared namespace but follows the moved entity
    // (using) + EF configuration (namespace-relative reference re-anchored
    // with global:: — `Api.…` would mis-bind against `Api.Api` inside a
    // namespaced file).
    const db = files.get("Infrastructure/Persistence/AppDbContext.cs")!;
    expect(db).toContain("namespace Api.Infrastructure.Persistence;");
    expect(db).toContain("using Api.Features.Orders;");
    expect(db).toContain(
      "modelBuilder.ApplyConfiguration(new global::Api.Features.Orders.OrderConfiguration());",
    );
  });

  it("leaves NO dangling reference to a fully-relocated byLayer namespace", async () => {
    const files = await emit(" { directoryLayout: byFeature }");
    // In this single-aggregate model every member of these byLayer
    // namespaces relocated, so no declaration NOR reference may survive.
    const gone = [
      "Api.Domain.Orders",
      "Api.Application.Orders",
      "Api.Infrastructure.Repositories",
      "Api.Infrastructure.Persistence.Configurations",
    ];
    for (const [path, content] of files) {
      if (!path.endsWith(".cs")) continue;
      for (const ns of gone) {
        expect(content, `${path} still references ${ns}`).not.toContain(ns);
      }
    }
  });

  it("every project-namespace using resolves to a namespace some emitted file declares", async () => {
    // The strongest SDK-less compile proxy: no `using Api.…;` may point at a
    // namespace that no longer exists after the rewrite.
    const files = await emit(" { directoryLayout: byFeature }");
    const declared = declaredNamespaces(files);
    for (const [path, content] of files) {
      if (!path.endsWith(".cs")) continue;
      for (const m of content.matchAll(/^using (Api\.[\w.]+);$/gm)) {
        expect(declared.has(m[1]!), `${path}: using ${m[1]} resolves to nothing`).toBe(true);
      }
    }
  });

  it("never emits a duplicate using directive (CS0105 is fatal under /warnaserror)", async () => {
    const files = await emit(" { directoryLayout: byFeature }");
    for (const [path, content] of files) {
      if (!path.endsWith(".cs")) continue;
      const usings = [...content.matchAll(/^using [\w.]+;$/gm)].map((m) => m[0]);
      expect(new Set(usings).size, `${path} has duplicate usings`).toBe(usings.length);
    }
  });

  it("relocation + namespace rewrite is content-preserving outside namespace/using/qualified lines", async () => {
    const byLayer = await emit(" { directoryLayout: byLayer }");
    const byFeature = await emit(" { directoryLayout: byFeature }");
    // Same number of files; the path sets differ (the slice moved)…
    expect(byFeature.size).toBe(byLayer.size);
    expect([...byFeature.keys()].sort()).not.toEqual([...byLayer.keys()].sort());
    // …and stripping namespace declarations, using directives, and
    // namespace-qualified references leaves the same multiset of contents:
    // the rewrite renames namespaces, it never changes code structure.
    const strip = (m: Map<string, string>) =>
      [...m.values()]
        .map((c) =>
          c
            .split("\n")
            .filter((l) => !l.startsWith("using ") && !l.startsWith("namespace "))
            .join("\n")
            .replace(/\bglobal::[\w.]+\.(\w+)/g, "$1")
            .replace(/\bApi\.[\w.]+\.(\w+)/g, "$1")
            // …including byLayer's namespace-RELATIVE form (AppDbContext's
            // `new Configurations.OrderConfiguration()`).
            .replace(/\bConfigurations\.(\w+)/g, "$1"),
        )
        .sort();
    expect(strip(byFeature)).toEqual(strip(byLayer));
  });

  it("keeps a SPLIT namespace alive only where it still has members (Api.Api keeps the filters)", async () => {
    const files = await emit(" { directoryLayout: byFeature }");
    // The controller left Api.Api but the exception filters stayed…
    expect(files.get("Api/DomainExceptionFilter.cs")).toContain("namespace Api.Api;");
    // …so Program.cs (which references the filters by simple name) keeps the
    // using alongside any feature expansions.
    expect(files.get("Program.cs")).toContain("using Api.Api;");
  });

  it("inheritance: base + concretes land in their own features with resolvable cross-feature references", async () => {
    const files = await emitSrc(INHERITANCE_SRC);
    // The TPH base owns its own feature folder…
    expect(files.get("Features/Parties/Party.cs")).toContain("namespace Api.Features.Parties;");
    // …the concrete references it across features via a using (the plural
    // namespace segment keeps the simple name `Party` bound to the TYPE).
    const customer = files.get("Features/Customers/Customer.cs")!;
    expect(customer).toContain("namespace Api.Features.Customers;");
    expect(customer).toContain("using Api.Features.Parties;");
    expect(customer).toContain("class Customer : Party");
    // The base's TPH discriminator config references the concretes back.
    const baseCfg = files.get("Features/Parties/PartyConfiguration.cs")!;
    expect(baseCfg).toContain("using Api.Features.Customers;");
    expect(baseCfg).toContain('.HasValue<Customer>("Customer")');
    // The disjointness invariant behind all of this: no declared type's
    // simple name may equal a Features namespace segment, or C#'s
    // enclosing-namespace lookup would shadow the type (CS0118).
    const featureSegments = new Set(
      [...files.keys()].filter((p) => p.startsWith("Features/")).map((p) => p.split("/")[1]!),
    );
    for (const [path, content] of files) {
      if (!path.endsWith(".cs")) continue;
      for (const m of content.matchAll(/\b(?:class|record|interface|enum)\s+([A-Za-z_]\w*)/g)) {
        expect(
          featureSegments.has(m[1]!),
          `type ${m[1]} (${path}) collides with a feature namespace segment`,
        ).toBe(false);
      }
    }
  });
});
