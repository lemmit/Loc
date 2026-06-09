// Read-only workflow-instance routes (workflow-instance-visibility.md): a
// correlation-bearing workflow gets `GET /<snake>/instances` +
// `GET /<snake>/instances/{id}` over its saga-state table, plus the
// `<Wf>InstanceResponse` / `<Wf>InstanceListResponse` Zod DTOs — the read-side
// analogue of an aggregate's GET list / GET-by-id.  Emitted even for an
// event-triggered-only saga (no command route), driven off `instanceWireShape`.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateTypeScript } from "../../../src/platform/hono/v4/emit.js";
import { BACKEND_PINS } from "../../../src/platform/hono/v4/pins.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");

async function workflowsFile(file: string): Promise<string> {
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
  const files = generateTypeScript(doc.parseResult.value as Model, BACKEND_PINS);
  return files.get("http/workflows.ts") ?? "";
}

describe("Hono workflow instance routes", () => {
  it("emits the instance response + list DTOs from the saga wire shape", async () => {
    const wf = await workflowsFile("test/fixtures/dispatch-sample.ddd");
    // Correlation field is the id-shaped (z.string) row; `attempts` an int.
    expect(wf).toMatch(/const OrderFulfillmentInstanceResponse = z\.object\(\{/);
    expect(wf).toMatch(/orderId: z\.string\(\)/);
    expect(wf).toMatch(/attempts: z\.number\(\)\.int\(\)/);
    expect(wf).toContain(
      "const OrderFulfillmentInstanceListResponse = z.array(OrderFulfillmentInstanceResponse)",
    );
  });

  it("emits GET list + GET by-id routes over the saga-state table", async () => {
    const wf = await workflowsFile("test/fixtures/dispatch-sample.ddd");
    // List.
    expect(wf).toContain('path: "/order_fulfillment/instances",');
    expect(wf).toContain("const rows = await db.select().from(schema.orderFulfillments);");
    // By correlation id — 404 when absent, filtered on the correlation column.
    expect(wf).toContain('path: "/order_fulfillment/instances/{id}",');
    expect(wf).toMatch(/eq\(schema\.orderFulfillments\.orderId, id\)/);
    expect(wf).toContain('if (!row) throw new AggregateNotFoundError("not_found");');
    // Both are GETs tagged under workflows.
    expect(wf).toContain('operationId: "allOrderFulfillmentInstances",');
    expect(wf).toContain('operationId: "getOrderFulfillmentInstanceById",');
  });

  it("does not emit instance routes for a workflow without a correlation field", async () => {
    // examples/sales.ddd has command workflows but no correlation-bearing saga.
    const wf = await workflowsFile("examples/sales.ddd");
    expect(wf).not.toContain("/instances");
    expect(wf).not.toMatch(/InstanceListResponse/);
  });
});
