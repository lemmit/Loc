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
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

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

/** Generate the Hono `http/workflows.ts` from an inline `.ddd` source. */
async function workflowsFromSrc(src: string): Promise<string> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  const files = generateSystems(model).files;
  return files.get("api/http/workflows.ts") ?? "";
}

// An event-sourced workflow (workflow-and-applier.md A2-S5b) — correlation
// field + state field + applier, ALSO subscribed (the `on` reactor) so the fold
// helpers would be a duplicate-declaration risk between the instance-route
// prelude and the subscription handlers.
const ES_SRC = `system S { subdomain O { context O {
  aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id } } }
  repository Orders for Order { }
  event OrderPlaced { order: Order id }
  event PaymentRegistered { order: Order id, amount: int }
  channel L { carries: OrderPlaced, PaymentRegistered  delivery: broadcast  retention: ephemeral }
  workflow Tally eventSourced {
    orderId: Order id
    total: int
    create(p: OrderPlaced) by p.order { emit PaymentRegistered { order: p.order, amount: 0 } }
    on(pr: PaymentRegistered) by pr.order { precondition total >= 0  emit PaymentRegistered { order: pr.order, amount: total } }
    apply(pr: PaymentRegistered) { total := total + pr.amount }
  }
} } api A from O storage pg { type: postgres }
  resource oState { for: O, kind: state, use: pg }
  deployable api { platform: node contexts: [O] serves: A dataSources: [oState] port: 8080 } }`;

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
    // The param carries the uuid format every backend declares on `/{id}`
    // (paramTypeDiffs parity — .NET `Guid id`, Java `UUID id`, Python Path()).
    expect(wf).toContain('path: "/order_fulfillment/instances/{id}",');
    expect(wf).toContain("request: { params: z.object({ id: z.string().uuid() }) },");
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

  it("declares the byId param as a uuid (aggregate ids are always guid)", async () => {
    const wf = await workflowsFile("test/fixtures/dispatch-sample.ddd");
    expect(wf).toContain("request: { params: z.object({ id: z.string().uuid() }) },");
  });
});

// Event-sourced instance reads (workflow-and-applier.md A2-S5b): the route
// paths + operationIds + DTOs are identical to the state path (cross-backend
// OpenAPI parity by construction); only the READ BODY diverges — LIST folds via
// the `loadAll<T>` group-fold, byId single-stream load + fold + 404.
describe("Hono event-sourced workflow instance routes", () => {
  it("LIST reads via the loadAll<T> group-fold (not a state-table select)", async () => {
    const wf = await workflowsFromSrc(ES_SRC);
    expect(wf).toContain('path: "/tally/instances",');
    expect(wf).toContain('operationId: "allTallyInstances",');
    // ES read body: fold every stream, not `db.select().from(schema.tallys)`.
    expect(wf).toContain("const rows = await loadAllTally(db);");
    expect(wf).not.toContain("await db.select().from(schema.tallys);");
  });

  it("byId folds a single stream + 404s on an empty one", async () => {
    const wf = await workflowsFromSrc(ES_SRC);
    expect(wf).toContain('path: "/tally/instances/{id}",');
    expect(wf).toContain('operationId: "getTallyInstanceById",');
    expect(wf).toContain("const __stream = await loadTallyEvents(db, id);");
    expect(wf).toContain(
      'if (__stream.length === 0) throw new AggregateNotFoundError("not_found");',
    );
    expect(wf).toContain("const row = foldTally(id, __stream);");
  });

  it("emits the fold helpers + stream serializers exactly once (no dup with subscription handlers)", async () => {
    const wf = await workflowsFromSrc(ES_SRC);
    // `Tally` is subscribed (the `on` reactor) AND observable; the prelude emits
    // the fold helpers / serializers and the subscription block must skip them.
    const count = (needle: string): number => wf.split(needle).length - 1;
    expect(count("async function loadAllTally(")).toBe(1);
    expect(count("function foldTally(")).toBe(1);
    expect(count("async function loadTallyEvents(")).toBe(1);
    // The shared stream (de)serialisers emitted once too.
    expect(count("function rowToEvent(")).toBe(1);
    expect(count("function eventToData(")).toBe(1);
  });

  it("still emits the instance response DTOs from the folded state's wire shape", async () => {
    const wf = await workflowsFromSrc(ES_SRC);
    expect(wf).toContain("const TallyInstanceResponse = z.object({");
    expect(wf).toContain("orderId: z.string(),");
    expect(wf).toContain("total: z.number().int(),");
    expect(wf).toContain("const TallyInstanceListResponse = z.array(TallyInstanceResponse)");
  });
});
