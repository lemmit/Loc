// byLayer — real LayoutAdapter for dotnet (F5c).  Verifies the path
// adapter routes every dotnet artifact category to the same location
// the existing emitter writes it to today.  Today the orchestrator
// hard-codes these paths at each emit-fn call site; this test pins
// the conventions so the orchestrator rewire (later F5 slice) can
// drop the inline strings and dispatch through the adapter without
// path drift.

import { describe, expect, it } from "vitest";
import type { EmitCtx } from "../../src/generator/_adapters/index.js";
import {
  byLayerLayoutAdapter,
  type DotnetArtifact,
} from "../../src/generator/dotnet/adapters/by-layer-layout.js";
import { resolveLayout } from "../../src/platform/resolve-adapters.js";

const ctx = {} as EmitCtx; // path routing ignores ctx today

function p(
  a: Partial<DotnetArtifact> & { name: string; category: DotnetArtifact["category"] },
): string {
  return byLayerLayoutAdapter.pathFor({ content: "", ...a } as DotnetArtifact, ctx);
}

describe("byLayer LayoutAdapter (real)", () => {
  it("is registered as the dotnet byLayer layout adapter", () => {
    const resolved = resolveLayout("dotnet", "byLayer");
    expect(resolved).toBe(byLayerLayoutAdapter);
    expect(resolved.name).toBe("byLayer");
  });

  it("routes Domain/ categories under their conventional folders", () => {
    expect(p({ name: "OrderId.cs", category: "id" })).toBe("Domain/Ids/OrderId.cs");
    expect(p({ name: "Status.cs", category: "enum" })).toBe("Domain/Enums/Status.cs");
    expect(p({ name: "Money.cs", category: "valueobject" })).toBe("Domain/ValueObjects/Money.cs");
    expect(p({ name: "OrderPlaced.cs", category: "event" })).toBe("Domain/Events/OrderPlaced.cs");
    expect(p({ name: "DomainException.cs", category: "domain-common" })).toBe(
      "Domain/Common/DomainException.cs",
    );
    expect(p({ name: "IDomainEvent.cs", category: "domain-common" })).toBe(
      "Domain/Common/IDomainEvent.cs",
    );
  });

  it("places entities + repository interface under Domain/<Plural>/", () => {
    expect(p({ name: "Order.cs", category: "entity", aggregateName: "Order" })).toBe(
      "Domain/Orders/Order.cs",
    );
    expect(p({ name: "OrderLine.cs", category: "entity", aggregateName: "Order" })).toBe(
      "Domain/Orders/OrderLine.cs",
    );
    expect(
      p({ name: "IOrderRepository.cs", category: "repository-interface", aggregateName: "Order" }),
    ).toBe("Domain/Orders/IOrderRepository.cs");
  });

  it("plural-folder rule applies upperFirst + plural (conservative naming rules)", () => {
    // `plural()` rules per docs/util/naming.ts: `y → ies`, `s/x/z/ch/sh → +es`,
    // else `+s`.  No special-case dictionaries — "person" pluralises as "Persons".
    expect(p({ name: "x.cs", category: "entity", aggregateName: "category" })).toBe(
      "Domain/Categories/x.cs",
    );
    expect(p({ name: "x.cs", category: "entity", aggregateName: "Box" })).toBe("Domain/Boxes/x.cs");
    expect(p({ name: "x.cs", category: "entity", aggregateName: "Tag" })).toBe("Domain/Tags/x.cs");
  });

  it("routes Application/ DTOs and CQRS folders correctly", () => {
    expect(
      p({ name: "CreateOrderRequest.cs", category: "request-dto", aggregateName: "Order" }),
    ).toBe("Application/Orders/Requests/CreateOrderRequest.cs");
    expect(p({ name: "OrderResponse.cs", category: "response-dto", aggregateName: "Order" })).toBe(
      "Application/Orders/Responses/OrderResponse.cs",
    );
    expect(p({ name: "CreateOrder.cs", category: "command", aggregateName: "Order" })).toBe(
      "Application/Orders/Commands/CreateOrder.cs",
    );
    expect(
      p({ name: "CreateOrderHandler.cs", category: "command-handler", aggregateName: "Order" }),
    ).toBe("Application/Orders/Commands/CreateOrderHandler.cs");
    expect(p({ name: "GetOrderById.cs", category: "query", aggregateName: "Order" })).toBe(
      "Application/Orders/Queries/GetOrderById.cs",
    );
    expect(
      p({ name: "GetOrderByIdHandler.cs", category: "query-handler", aggregateName: "Order" }),
    ).toBe("Application/Orders/Queries/GetOrderByIdHandler.cs");
  });

  it("colocates command validators with their command", () => {
    expect(
      p({
        name: "CreateOrderCommandValidator.cs",
        category: "command-validator",
        aggregateName: "Order",
      }),
    ).toBe("Application/Orders/Commands/CreateOrderCommandValidator.cs");
  });

  it("routes workflow artifacts (per-context) under Application/Workflows/", () => {
    expect(p({ name: "PlaceOrderRequest.cs", category: "workflow-request" })).toBe(
      "Application/Workflows/PlaceOrderRequest.cs",
    );
    expect(p({ name: "PlaceOrderCommand.cs", category: "workflow-command" })).toBe(
      "Application/Workflows/PlaceOrderCommand.cs",
    );
    expect(p({ name: "PlaceOrderHandler.cs", category: "workflow-handler" })).toBe(
      "Application/Workflows/PlaceOrderHandler.cs",
    );
  });

  it("places cross-cutting Application/ behaviors under Application/Common/", () => {
    expect(p({ name: "ValidationBehavior.cs", category: "validation-behavior" })).toBe(
      "Application/Common/ValidationBehavior.cs",
    );
    expect(p({ name: "ExecutionContextBehavior.cs", category: "execution-context-behavior" })).toBe(
      "Application/Common/ExecutionContextBehavior.cs",
    );
  });

  it("places extern handler artifacts under Application/<Plural>/Handlers/", () => {
    expect(
      p({
        name: "IExternFooHandler.cs",
        category: "extern-handler-interface",
        aggregateName: "Order",
      }),
    ).toBe("Application/Orders/Handlers/IExternFooHandler.cs");
    expect(
      p({
        name: "ExternFooHandlerStub.cs",
        category: "extern-handler-stub",
        aggregateName: "Order",
      }),
    ).toBe("Application/Orders/Handlers/ExternFooHandlerStub.cs");
  });

  it("routes Infrastructure/ artifacts to their conventional folders", () => {
    expect(p({ name: "AppDbContext.cs", category: "dbcontext" })).toBe(
      "Infrastructure/Persistence/AppDbContext.cs",
    );
    expect(p({ name: "OrderConfiguration.cs", category: "ef-configuration" })).toBe(
      "Infrastructure/Persistence/Configurations/OrderConfiguration.cs",
    );
    expect(p({ name: "OrderTags.cs", category: "join-entity" })).toBe(
      "Infrastructure/Persistence/JoinTables/OrderTags.cs",
    );
    expect(p({ name: "OrderTagsConfiguration.cs", category: "join-entity-configuration" })).toBe(
      "Infrastructure/Persistence/Configurations/OrderTagsConfiguration.cs",
    );
    expect(p({ name: "OrderRepository.cs", category: "repository-impl" })).toBe(
      "Infrastructure/Repositories/OrderRepository.cs",
    );
    expect(p({ name: "NoopDomainEventDispatcher.cs", category: "event-dispatcher" })).toBe(
      "Infrastructure/Events/NoopDomainEventDispatcher.cs",
    );
    expect(p({ name: "AuditableInterceptor.cs", category: "auditable-interceptor" })).toBe(
      "Infrastructure/Persistence/AuditableInterceptor.cs",
    );
    expect(p({ name: "DomainLog.cs", category: "domain-log" })).toBe("Domain/Common/DomainLog.cs");
  });

  it("routes Api/ artifacts to Api/", () => {
    expect(p({ name: "OrdersController.cs", category: "controller" })).toBe(
      "Api/OrdersController.cs",
    );
    expect(p({ name: "DomainExceptionFilter.cs", category: "exception-filter" })).toBe(
      "Api/DomainExceptionFilter.cs",
    );
  });

  it("routes Tests/ artifacts under Tests/<Ns>.Tests/<Plural>/", () => {
    expect(p({ name: "api.Tests.csproj", category: "test-csproj", ns: "api" })).toBe(
      "Tests/api.Tests/api.Tests.csproj",
    );
    expect(
      p({ name: "OrderTests.cs", category: "test-class", ns: "api", aggregateName: "Order" }),
    ).toBe("Tests/api.Tests/Orders/OrderTests.cs");
  });

  it("routes top-level project files to the root", () => {
    expect(p({ name: "Program.cs", category: "program" })).toBe("Program.cs");
    expect(p({ name: "api.csproj", category: "csproj" })).toBe("api.csproj");
    expect(p({ name: "Dockerfile", category: "dockerfile" })).toBe("Dockerfile");
    expect(p({ name: ".dockerignore", category: "dockerignore" })).toBe(".dockerignore");
  });

  it("routes Middleware/ + certs/ markers correctly", () => {
    expect(p({ name: "RequestLoggingMiddleware.cs", category: "request-logging-middleware" })).toBe(
      "Middleware/RequestLoggingMiddleware.cs",
    );
    expect(p({ name: ".gitkeep", category: "certs-marker" })).toBe("certs/.gitkeep");
  });

  it("preserves the full path for namespace marker files", () => {
    // The caller passes the verbatim path because markers can live in
    // many places (`Domain/Enums/_namespace.cs`, etc.).
    expect(p({ name: "Domain/Enums/_namespace.cs", category: "namespace-marker" })).toBe(
      "Domain/Enums/_namespace.cs",
    );
    expect(p({ name: "Domain/ValueObjects/_namespace.cs", category: "namespace-marker" })).toBe(
      "Domain/ValueObjects/_namespace.cs",
    );
  });

  it("routes migration artifacts under Infrastructure/Migrations/", () => {
    expect(p({ name: "20260101000000_init.cs", category: "migration" })).toBe(
      "Infrastructure/Migrations/20260101000000_init.cs",
    );
    expect(p({ name: "AppDbContextModelSnapshot.cs", category: "migrations-config" })).toBe(
      "Infrastructure/Migrations/AppDbContextModelSnapshot.cs",
    );
  });

  it("throws a clear error when a per-aggregate category lacks aggregateName", () => {
    expect(() => p({ name: "Order.cs", category: "entity" })).toThrow(/missing aggregateName/);
    expect(() =>
      p({ name: "x.cs", category: "repository-impl", aggregateName: undefined }),
    ).not.toThrow();
    // repository-impl path is namespace-agnostic, so missing aggregateName is fine.
  });

  it("throws when an artifact arrives without a category tag", () => {
    expect(() => byLayerLayoutAdapter.pathFor({ name: "X.cs", content: "" }, ctx)).toThrow(
      /missing a category/,
    );
  });
});
