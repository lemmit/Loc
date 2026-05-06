import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createDddServices } from "../src/language/ddd-module.js";
import { generateDotnet } from "../src/generator/dotnet/index.js";
import type { Model } from "../src/language/generated/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

async function buildModel(file: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc.parseResult.value as Model;
}

describe(".NET generator", () => {
  it("emits the expected file set for sales.ddd", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const keys = [...files.keys()];
    expect(keys).toContain("Domain/Ids/OrderId.cs");
    expect(keys).toContain("Domain/Orders/Order.cs");
    expect(keys).toContain("Domain/Orders/OrderLine.cs");
    expect(keys).toContain("Domain/Orders/IOrderRepository.cs");
    expect(keys).toContain("Domain/ValueObjects/Money.cs");
    expect(keys).toContain("Domain/Enums/OrderStatus.cs");
    expect(keys).toContain("Domain/Events/OrderConfirmed.cs");
    expect(keys).toContain("Infrastructure/Persistence/AppDbContext.cs");
    expect(keys).toContain("Infrastructure/Persistence/Configurations/OrderConfiguration.cs");
    expect(keys).toContain("Infrastructure/Repositories/OrderRepository.cs");
    expect(keys).toContain("Application/Orders/Commands/ConfirmCommand.cs");
    expect(keys).toContain("Application/Orders/Commands/ConfirmHandler.cs");
    expect(keys).toContain("Application/Orders/Queries/GetOrderByIdQuery.cs");
    expect(keys).toContain("Api/OrdersController.cs");
    expect(keys).toContain("Program.cs");
    expect(keys).toContain("Sales.csproj");
  });

  it("renders Order with idiomatic C#", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const order = files.get("Domain/Orders/Order.cs")!;
    expect(order).toMatch(/public sealed class Order/);
    expect(order).toMatch(/public OrderId Id { get; private set; }/);
    expect(order).toMatch(/public void Confirm\(\)/);
    expect(order).toMatch(/this\.Lines\.Count > 0/);
    expect(order).toMatch(/OrderStatus\.Confirmed/);
    expect(order).toMatch(/_domainEvents\.Add\(new OrderConfirmed/);
  });

  it("emits xUnit test class + test project when `test` blocks are declared", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const tests = files.get("Tests/Sales.Tests/Orders/OrderTests.cs")!;
    expect(tests).toMatch(/using Xunit;/);
    expect(tests).toMatch(/\[Fact\(DisplayName = "money literal builds"\)\]/);
    expect(tests).toMatch(/Assert\.Throws<DomainException>/);
    const testCsproj = files.get("Tests/Sales.Tests/Sales.Tests.csproj")!;
    expect(testCsproj).toMatch(/Microsoft\.NET\.Test\.Sdk/);
    expect(testCsproj).toMatch(/<PackageReference Include="xunit"/);
    expect(testCsproj).toMatch(/<ProjectReference Include="\.\.\/\.\.\/Sales\.csproj" \/>/);
  });

  it("emits Dockerfile + .dockerignore", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const dockerfile = files.get("Dockerfile")!;
    expect(dockerfile).toMatch(/FROM mcr\.microsoft\.com\/dotnet\/sdk:8\.0 AS build/);
    expect(dockerfile).toMatch(/FROM mcr\.microsoft\.com\/dotnet\/aspnet:8\.0 AS runtime/);
    expect(dockerfile).toMatch(/ENTRYPOINT \["dotnet", "Sales\.dll"\]/);
    const dockerignore = files.get(".dockerignore")!;
    expect(dockerignore).toMatch(/\*\*\/bin/);
  });

  it("wires Swashbuckle so /swagger/v1/swagger.json is exposed", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const csproj = files.get("Sales.csproj")!;
    expect(csproj).toMatch(/<PackageReference Include="Swashbuckle\.AspNetCore"/);
    const program = files.get("Program.cs")!;
    expect(program).toMatch(/AddSwaggerGen/);
    expect(program).toMatch(/UseSwagger/);
  });

  it("enables CORS + camelCase JSON in Program.cs", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const program = files.get("Program.cs")!;
    expect(program).toMatch(/AddCors/);
    expect(program).toMatch(/UseCors\(\)/);
    expect(program).toMatch(/JsonNamingPolicy\.CamelCase/);
  });

  it("auto-includes a GET /<plural> find via the `all` repository method", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const controller = files.get("Api/OrdersController.cs")!;
    // [HttpGet] (root) — followed by an All(...) action.
    expect(controller).toMatch(/\[HttpGet\][\s\S]*?All\(/);
    const repoIface = files.get("Domain/Orders/IOrderRepository.cs")!;
    expect(repoIface).toMatch(/List<Order>[\s\S]*?All\(/);
  });

  it("translates `where` filter to a LINQ predicate", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const repo = files.get("Infrastructure/Repositories/OrderRepository.cs")!;
    expect(repo).toMatch(/ActiveForCustomer/);
    expect(repo).toMatch(/x\.CustomerId == forCustomer && x\.Status == OrderStatus\.Draft/);
  });

  it("emits CQRS command for each public operation", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const cmd = files.get("Application/Orders/Commands/AddLineCommand.cs")!;
    expect(cmd).toMatch(/public sealed record AddLineCommand/);
    expect(cmd).toMatch(/ICommand/);
    const handler = files.get("Application/Orders/Commands/AddLineHandler.cs")!;
    expect(handler).toMatch(/ICommandHandler<AddLineCommand,\s*Unit>/);
    expect(handler).toMatch(/_repo\.GetByIdAsync/);
    expect(handler).toMatch(/aggregate\.AddLine\(/);
    expect(handler).toMatch(/_repo\.SaveAsync/);
  });

  it("EF configuration emits HasIndex for find-referenced columns", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const cfg = files.get("Infrastructure/Persistence/Configurations/OrderConfiguration.cs")!;
    expect(cfg).toMatch(/b\.HasIndex\(x => x\.CustomerId\)/);
    expect(cfg).toMatch(/b\.HasIndex\(x => x\.Status\)/);
  });

  it("emits an IXAggHandler interface + Scrutor scan for extern operations", async () => {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(`
      context Sales {
        enum OrderStatus { Draft, Confirmed }
        aggregate Order {
          customerId: string
          status: OrderStatus
          function isMutable(): bool = status == Draft
          operation confirm() extern {
            precondition isMutable()
          }
        }
        repository Orders for Order { }
      }
    `, { validation: true });
    const files = generateDotnet(doc.parseResult.value as Model);

    // 1. The user-implementable handler interface lives under
    //    Application/<Aggregate>/Handlers/.
    const iface = files.get("Application/Orders/Handlers/IConfirmOrderHandler.cs")!;
    expect(iface).toMatch(
      /Task HandleAsync\(Order aggregate, ConfirmRequest request, CancellationToken ct\)/,
    );

    // 2. The auto Mediator handler injects the user interface and
    //    delegates: load → CheckX → user.HandleAsync → invariants → save.
    const handler = files.get("Application/Orders/Commands/ConfirmHandler.cs")!;
    expect(handler).toMatch(/private readonly IConfirmOrderHandler _user;/);
    expect(handler).toMatch(/aggregate\.CheckConfirm\(\);/);
    expect(handler).toMatch(/await _user\.HandleAsync\(aggregate, request, ct\);/);
    expect(handler).toMatch(/aggregate\.AssertInvariants\(\);/);
    // No direct call to a non-existent `aggregate.Confirm()` method.
    expect(handler).not.toMatch(/aggregate\.Confirm\(/);

    // 3. The aggregate exposes RaiseEvent + AssertInvariants as internal
    //    and widens setters to `internal set` so [ExternHandler] classes
    //    in the same assembly can mutate state.
    const order = files.get("Domain/Orders/Order.cs")!;
    expect(order).toMatch(/internal void RaiseEvent\(IDomainEvent ev\) =>/);
    expect(order).toMatch(/internal void AssertInvariants\(\)/);
    expect(order).toMatch(/public OrderStatus Status \{ get; internal set; \}/);
    expect(order).toMatch(/public void CheckConfirm\(\)/);
    expect(order).not.toMatch(/public void Confirm\(\)/);

    // 4. Common code declares the [ExternHandler] attribute (no Loom
    //    name leaks into the user-facing surface).
    const common = files.get("Domain/Common/DomainException.cs")!;
    expect(common).toMatch(/public sealed class ExternHandlerAttribute : Attribute/);
    expect(common).not.toMatch(/Loom/);

    // 5. Program.cs registers Scrutor + verifies the handler is wired.
    const program = files.get("Program.cs")!;
    expect(program).toMatch(/builder\.Services\.Scan\(s => s/);
    expect(program).toMatch(/WithAttribute<ExternHandlerAttribute>/);
    expect(program).toMatch(/IConfirmOrderHandler.*is null/s);
    expect(program).toMatch(/Missing \[ExternHandler\] for/);

    // 6. csproj brings in Scrutor.
    const csproj = files.get("Sales.csproj")!;
    expect(csproj).toMatch(/<PackageReference Include="Scrutor"/);
  });

  it("DomainExceptionFilter catches unhandled exceptions as sanitized 500", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const filter = files.get("Api/DomainExceptionFilter.cs")!;
    expect(filter).toMatch(/ILogger<DomainExceptionFilter>/);
    expect(filter).toMatch(/StatusCode = 500/);
    expect(filter).toMatch(/error = "internal"/);
    // Domain-specific paths still mapped.
    expect(filter).toMatch(/BadRequestObjectResult/);
    expect(filter).toMatch(/NotFoundObjectResult/);
  });
});
