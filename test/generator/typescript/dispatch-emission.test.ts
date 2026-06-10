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
  it("emits create + on handlers and a dispatcher in http/workflows.ts", async () => {
    const files = await generate("test/fixtures/dispatch-sample.ddd");
    const wf = files.get("http/workflows.ts") ?? "";

    // create(OrderPlaced) starter + on(ShipmentRequested) continuation.
    expect(wf).toContain("export async function orderFulfillmentStartOrderPlaced(");
    expect(wf).toMatch(/p: Events\.OrderPlaced/);
    expect(wf).toContain("export async function orderFulfillmentOnShipmentRequested(");
    expect(wf).toMatch(/s: Events\.ShipmentRequested/);
    expect(wf).toContain("for (const ev of workflowEvents) await events.dispatch(ev);");

    // The dispatcher factory routes by event.type and passes itself (re-entrant).
    expect(wf).toContain("export function createInProcessDispatcher(");
    expect(wf).toMatch(
      /case "OrderPlaced": \{\s*await orderFulfillmentStartOrderPlaced\(db, dispatcher, event\);/,
    );
    expect(wf).toMatch(
      /case "ShipmentRequested": \{\s*await orderFulfillmentOnShipmentRequested\(db, dispatcher, event\);/,
    );
  });

  it("createApp defaults its dispatcher to the in-process factory", async () => {
    const files = await generate("test/fixtures/dispatch-sample.ddd");
    const idx = files.get("http/index.ts") ?? "";
    expect(idx).toContain(
      'import { createInProcessDispatcher, workflowsRoutes } from "./workflows";',
    );
    // The fixture's channel is `delivery: broadcast`, so the default
    // dispatcher rides through the realtime SSE tee.
    expect(idx).toContain(
      "events: DomainEventDispatcher = realtimeTee(createInProcessDispatcher(db)),",
    );
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

  it("emits a persisted state table keyed by the correlation field (db/schema.ts)", async () => {
    const schema = (await generate("test/fixtures/dispatch-sample.ddd")).get("db/schema.ts") ?? "";
    expect(schema).toMatch(/export const orderFulfillments = pgTable\("order_fulfillments", \{/);
    expect(schema).toMatch(/orderId: text\("order_id"\)\.primaryKey\(\)/);
    expect(schema).toMatch(/attempts: integer\("attempts"\)\.notNull\(\)/);
  });

  it("create starter loads-or-allocates (typed defaults), on continuation routes-or-drops+logs", async () => {
    const wf = (await generate("test/fixtures/dispatch-sample.ddd")).get("http/workflows.ts") ?? "";
    // load/save helpers + the row type.
    expect(wf).toContain(
      "type OrderFulfillmentState = typeof schema.orderFulfillments.$inferInsert;",
    );
    expect(wf).toMatch(/eq\(schema\.orderFulfillments\.orderId, key\)/);
    expect(wf).toMatch(/\.onConflictDoUpdate\(\{ target: schema\.orderFulfillments\.orderId/);

    // create: load-or-allocate with a TYPED default for the required saga
    // state (`attempts: int` → 0), no cast; saves the row.
    const start = wf.slice(wf.indexOf("orderFulfillmentStartOrderPlaced"));
    expect(start).toMatch(/const __key = p\.order;/);
    expect(start).toMatch(
      /const state = \(await loadOrderFulfillment\(db, __key\)\) \?\? \{ orderId: __key, attempts: 0 \};/,
    );
    expect(start).toContain("await saveOrderFulfillment(db, state);");

    // on: route-to-existing, else drop + log `event_unrouted`.
    const onH = wf.slice(wf.indexOf("orderFulfillmentOnShipmentRequested"));
    expect(onH).toMatch(/const state = await loadOrderFulfillment\(db, __key\);/);
    expect(onH).toMatch(/if \(!state\) \{/);
    expect(onH).toMatch(
      /requestLog\(\)\.warn\(\{ event: "event_unrouted", workflow: "OrderFulfillment", event_type: "ShipmentRequested", key: __key \}\);/,
    );
    // The `requestLog` import is wired at the file top.
    expect(wf).toContain('import { requestLog } from "../obs/als";');
  });
});
