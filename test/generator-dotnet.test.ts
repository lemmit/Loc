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
    expect(keys).toContain("Domain/Order/Order.cs");
    expect(keys).toContain("Domain/Order/OrderLine.cs");
    expect(keys).toContain("Domain/Order/IOrderRepository.cs");
    expect(keys).toContain("Domain/ValueObjects/Money.cs");
    expect(keys).toContain("Domain/Enums/OrderStatus.cs");
    expect(keys).toContain("Domain/Events/OrderConfirmed.cs");
    expect(keys).toContain("Infrastructure/Persistence/AppDbContext.cs");
    expect(keys).toContain("Infrastructure/Persistence/Configurations/OrderConfiguration.cs");
    expect(keys).toContain("Infrastructure/Repositories/OrderRepository.cs");
    expect(keys).toContain("Application/Order/Commands/ConfirmCommand.cs");
    expect(keys).toContain("Application/Order/Commands/ConfirmHandler.cs");
    expect(keys).toContain("Application/Order/Queries/GetOrderByIdQuery.cs");
    expect(keys).toContain("Api/OrdersController.cs");
    expect(keys).toContain("Program.cs");
    expect(keys).toContain("Sales.csproj");
  });

  it("renders Order with idiomatic C#", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const order = files.get("Domain/Order/Order.cs")!;
    expect(order).toMatch(/public sealed class Order/);
    expect(order).toMatch(/public OrderId Id { get; private set; }/);
    expect(order).toMatch(/public void Confirm\(\)/);
    expect(order).toMatch(/this\.Lines\.Count > 0/);
    expect(order).toMatch(/OrderStatus\.Confirmed/);
    expect(order).toMatch(/_domainEvents\.Add\(new OrderConfirmed/);
  });

  it("emits CQRS command for each public operation", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const cmd = files.get("Application/Order/Commands/AddLineCommand.cs")!;
    expect(cmd).toMatch(/public sealed record AddLineCommand/);
    expect(cmd).toMatch(/IRequest/);
    const handler = files.get("Application/Order/Commands/AddLineHandler.cs")!;
    expect(handler).toMatch(/IRequestHandler<AddLineCommand>/);
    expect(handler).toMatch(/_repo\.GetByIdAsync/);
    expect(handler).toMatch(/aggregate\.AddLine\(/);
    expect(handler).toMatch(/_repo\.SaveAsync/);
  });
});
