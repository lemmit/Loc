// Read-only workflow-instance endpoints (workflow-instance-visibility.md) on
// Phoenix: a correlation-bearing workflow gets a saga-state Ecto schema (even
// without subscriptions), a WorkflowInstancesController with GET
// /workflows/<snake>/instances + .../instances/:id reading that schema via the
// app Repo, and the matching router routes — the read-side analogue of an
// aggregate's index/show, mirroring the Hono / .NET instance endpoints.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

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
  return generateSystems(doc.parseResult.value as Model).files;
}

const DISPATCH = "test/e2e/fixtures/elixir-ash-build/dispatch.ddd";

describe("Phoenix workflow instance read endpoints", () => {
  it("emits the saga-state schema for the correlation-bearing workflow", async () => {
    const files = await generate(DISPATCH);
    const schema = files.get(
      "phoenix_app/lib/phoenix_app/fulfillment/workflows/order_fulfillment_state.ex",
    );
    expect(schema).toBeDefined();
    expect(schema!).toContain(
      "defmodule PhoenixApp.Fulfillment.Workflows.OrderFulfillmentState do",
    );
  });

  it("emits a WorkflowInstancesController with index + show reading the saga schema", async () => {
    const files = await generate(DISPATCH);
    const ctrl = files.get(
      "phoenix_app/lib/phoenix_app_web/controllers/workflow_instances_controller.ex",
    );
    expect(ctrl).toBeDefined();
    expect(ctrl!).toContain("defmodule PhoenixAppWeb.WorkflowInstancesController do");
    // List + by-id actions over the saga schema via the app Repo.
    expect(ctrl!).toContain("def order_fulfillment_instances(conn, _params) do");
    expect(ctrl!).toContain(
      "PhoenixApp.Repo.all(PhoenixApp.Fulfillment.Workflows.OrderFulfillmentState)",
    );
    expect(ctrl!).toContain('def order_fulfillment_instance(conn, %{"id" => id}) do');
    expect(ctrl!).toContain(
      "PhoenixApp.Repo.get(PhoenixApp.Fulfillment.Workflows.OrderFulfillmentState, id)",
    );
    // camelCase wire keys ← snake struct fields.
    expect(ctrl!).toContain("orderId: row.order_id");
    expect(ctrl!).toContain("attempts: row.attempts");
    expect(ctrl!).toContain("send_resp(404, body)");
  });

  it("splices the instance routes into the router", async () => {
    const files = await generate(DISPATCH);
    const router = files.get("phoenix_app/lib/phoenix_app_web/router.ex") ?? "";
    expect(router).toMatch(
      /get "\/workflows\/order_fulfillment\/instances", WorkflowInstancesController, :order_fulfillment_instances/,
    );
    expect(router).toMatch(
      /get "\/workflows\/order_fulfillment\/instances\/:id", WorkflowInstancesController, :order_fulfillment_instance/,
    );
  });
});
