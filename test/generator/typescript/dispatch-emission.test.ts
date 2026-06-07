// In-process event dispatch (channels.md): the Hono backend turns each
// channel-routed `on(e: Event)` reactor / event-triggered `create(e: Event) by`
// starter into a handler function in `http/workflows.ts`, plus a
// `createInProcessDispatcher(db)` factory that routes emitted events to them —
// and `createApp` defaults its dispatcher to that factory instead of the
// no-op.  A channel-less project emits none of this (byte-identical, Noop).

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
  return generateTypeScript(doc.parseResult.value as Model, BACKEND_PINS);
}

describe("in-process event dispatch emission", () => {
  it("emits reactor + event-create handlers and a dispatcher in http/workflows.ts", async () => {
    const files = await generate("test/fixtures/dispatch-sample.ddd");
    const wf = files.get("http/workflows.ts") ?? "";

    // on(OrderPlaced) reactor → a handler that loads/creates + emits + dispatches.
    expect(wf).toContain("export async function fulfillerOnOrderPlaced(");
    expect(wf).toMatch(/p: Events\.OrderPlaced/);
    expect(wf).toContain("for (const ev of workflowEvents) await events.dispatch(ev);");

    // event-triggered create(ShipmentRequested) → a starter handler.
    expect(wf).toContain("export async function shipmentTrackerStartShipmentRequested(");
    expect(wf).toMatch(/s: Events\.ShipmentRequested/);

    // The dispatcher factory routes by event.type and passes itself (re-entrant).
    expect(wf).toContain("export function createInProcessDispatcher(");
    expect(wf).toMatch(
      /case "OrderPlaced": \{\s*await fulfillerOnOrderPlaced\(db, dispatcher, event\);/,
    );
    expect(wf).toMatch(
      /case "ShipmentRequested": \{\s*await shipmentTrackerStartShipmentRequested\(db, dispatcher, event\);/,
    );
  });

  it("createApp defaults its dispatcher to the in-process factory", async () => {
    const files = await generate("test/fixtures/dispatch-sample.ddd");
    const idx = files.get("http/index.ts") ?? "";
    expect(idx).toContain(
      'import { createInProcessDispatcher, workflowsRoutes } from "./workflows";',
    );
    expect(idx).toContain("events: DomainEventDispatcher = createInProcessDispatcher(db),");
    // Noop import is dropped when the in-process dispatcher is wired.
    expect(idx).not.toContain("NoopDomainEventDispatcher");
  });

  it("emits no dispatch wiring for a channel-less project (byte-identical / Noop)", async () => {
    const files = await generate("examples/sales.ddd");
    const wf = files.get("http/workflows.ts") ?? "";
    const idx = files.get("http/index.ts") ?? "";
    expect(wf).not.toContain("createInProcessDispatcher");
    expect(idx).toContain("NoopDomainEventDispatcher");
    expect(idx).not.toContain("createInProcessDispatcher");
  });

  it("emits a persisted state table per correlation-bearing workflow (db/schema.ts)", async () => {
    const schema = (await generate("test/fixtures/dispatch-sample.ddd")).get("db/schema.ts") ?? "";
    // Fulfiller (orderId: Order id) and ShipmentTracker (shipId: Shipment id)
    // each get a state table keyed by their correlation field.
    expect(schema).toMatch(/export const fulfillers = pgTable\("fulfillers", \{/);
    expect(schema).toMatch(/orderId: text\("order_id"\)\.primaryKey\(\)/);
    expect(schema).toMatch(/export const shipmentTrackers = pgTable\("shipment_trackers", \{/);
    expect(schema).toMatch(/shipId: text\("ship_id"\)\.primaryKey\(\)/);
  });
});
