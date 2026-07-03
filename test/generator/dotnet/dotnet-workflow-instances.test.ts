// Read-only workflow-instance endpoints (workflow-instance-visibility.md) on
// .NET: a correlation-bearing workflow gets a <Wf>InstanceResponse DTO and a
// <Ctx>WorkflowInstancesController exposing GET workflows/<snake>/instances +
// .../instances/{id} over the EF-mapped saga-state DbSet — the read-side
// analogue of an aggregate's GET list / GET-by-id.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");

async function generate(file: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(root, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  expect(
    errors.map((d) => d.message),
    "fixture validation errors",
  ).toEqual([]);
  return generateDotnet(doc.parseResult.value as Model);
}

describe(".NET workflow instance read endpoints", () => {
  it("emits the instance Response DTO from the saga wire shape", async () => {
    const files = await generate("test/fixtures/dispatch-sample.ddd");
    const dto = files.get("Application/Workflows/OrderFulfillmentInstanceResponse.cs") ?? "";
    expect(dto).toContain("public sealed record OrderFulfillmentInstanceResponse(");
    // Correlation id crosses as Guid (the .NET wire-id divergence); attempts int.
    // Non-nullable components carry `[property: Required]` so the OpenAPI
    // required-set matches Hono/Python (which require every non-optional
    // instance field) — see dto-mapping.ts.
    expect(dto).toMatch(/\[property: Required\] Guid OrderId/);
    expect(dto).toMatch(/\[property: Required\] int Attempts/);
    expect(dto).toContain("using System.ComponentModel.DataAnnotations;");
  });

  it("registers the named <Wf>InstanceListResponse wrapper pair", async () => {
    // Swashbuckle inlines `IEnumerable<T>`; the document filter promotes the
    // list response to the named carrier the other backends emit
    // (`<Wf>InstanceListResponse` — Hono z.array().openapi(), Python RootModel).
    const files = await generate("test/fixtures/dispatch-sample.ddd");
    const filter = files.get("Api/ListResponseWrapperFilter.cs") ?? "";
    expect(filter).toContain(
      '("OrderFulfillmentInstanceResponse", "OrderFulfillmentInstanceListResponse"),',
    );
  });

  it("emits a controller with GET list + GET by-id over the saga DbSet", async () => {
    const files = await generate("test/fixtures/dispatch-sample.ddd");
    const ctrl = files.get("Api/FulfillmentWorkflowInstancesController.cs") ?? "";
    expect(ctrl).toContain('[Route("workflows")]');
    expect(ctrl).toContain("private readonly AppDbContext _db;");
    expect(ctrl).toContain('[HttpGet("order_fulfillment/instances")]');
    expect(ctrl).toContain("await _db.OrderFulfillments.AsNoTracking().ToListAsync();");
    expect(ctrl).toContain('[HttpGet("order_fulfillment/instances/{id}")]');
    expect(ctrl).toMatch(/var __key = new OrderId\(id\);/);
    expect(ctrl).toMatch(/FirstOrDefaultAsync\(r => r\.OrderId == __key\)/);
    expect(ctrl).toContain("if (x is null) return NotFound();");
  });

  it("emits no instance controller for a workflow without a correlation field", async () => {
    const files = await generate("examples/sales.ddd");
    const hasInstanceCtrl = [...files.keys()].some((k) =>
      k.endsWith("WorkflowInstancesController.cs"),
    );
    expect(hasInstanceCtrl).toBe(false);
  });
});
