import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// .NET in-process event dispatch (channels.md) — the .NET mirror of the Hono
// slice (#970).  Each channel-routed `on(e: Event)` reactor / event-triggered
// `create(e: Event) by` starter becomes a Mediator `INotificationHandler<T>`;
// the `InProcessDomainEventDispatcher` publishes each emitted domain event as
// a notification (`IDomainEvent : INotification`), so the reactor / starter
// runs in-process.  Program.cs registers the in-process dispatcher (Scoped)
// instead of the no-op.  A channel-less project emits none of this
// (byte-identical, Noop).  The `dotnet build /warnaserror` gate lives in
// test/e2e/generated-dotnet-build.test.ts.
// ---------------------------------------------------------------------------

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

describe(".NET in-process event dispatch emission", () => {
  it("emits one INotificationHandler per reactor / event-create", async () => {
    const files = await generate("test/fixtures/dispatch-sample.ddd");

    // create(OrderPlaced) starter → INotificationHandler<OrderPlaced>.
    const start = files.get("Application/Workflows/OrderFulfillmentStartOrderPlacedHandler.cs");
    expect(start).toBeDefined();
    expect(start!).toContain(
      "public sealed class OrderFulfillmentStartOrderPlacedHandler : INotificationHandler<OrderPlaced>",
    );
    expect(start!).toContain(
      "public async ValueTask Handle(OrderPlaced notification, CancellationToken cancellationToken)",
    );
    // Event param binds to `notification`; the body emits + dispatches.
    expect(start!).toContain('Shipment.Create(orderRef: notification.Order, status: "Pending")');
    expect(start!).toMatch(/new ShipmentRequested\(Shipment: ship\.Id, Order: notification\.Order/);
    expect(start!).toContain("foreach (var ev in _workflowEvents)");
    expect(start!).toContain("await _events.DispatchAsync(ev, cancellationToken);");

    // on(ShipmentRequested) continuation → INotificationHandler<ShipmentRequested>.
    const onH = files.get("Application/Workflows/OrderFulfillmentOnShipmentRequestedHandler.cs");
    expect(onH).toBeDefined();
    expect(onH!).toContain(
      "public sealed class OrderFulfillmentOnShipmentRequestedHandler : INotificationHandler<ShipmentRequested>",
    );
    // getById is load-or-throw in a reactor (the loaded aggregate is
    // dereferenced), guarding the nullable under NRT.
    expect(onH!).toMatch(
      /await _shipments\.GetByIdAsync\(notification\.Shipment, cancellationToken\)\s*\?\? throw new AggregateNotFoundException/,
    );
    expect(onH!).toContain("ship.MarkTracked();");
    expect(onH!).toContain("await _shipments.SaveAsync(ship, cancellationToken);");
  });

  it("makes IDomainEvent a Mediator notification + wires the in-process dispatcher", async () => {
    const files = await generate("test/fixtures/dispatch-sample.ddd");

    // IDomainEvent : INotification so the dispatcher can Publish events.
    const iface = files.get("Domain/Events/IDomainEvent.cs") ?? "";
    expect(iface).toContain("using Mediator;");
    expect(iface).toContain("public interface IDomainEvent : INotification { }");

    // The in-process dispatcher publishes by runtime type (non-generic Publish).
    const disp = files.get("Infrastructure/Events/InProcessDomainEventDispatcher.cs") ?? "";
    expect(disp).toContain(
      "public sealed class InProcessDomainEventDispatcher : IDomainEventDispatcher",
    );
    expect(disp).toContain("_mediator.Publish((object)ev, cancellationToken).AsTask()");

    // Program.cs registers the in-process dispatcher (Scoped), not the no-op.
    const prog = files.get("Program.cs") ?? "";
    expect(prog).toContain(
      "builder.Services.AddScoped<IDomainEventDispatcher, InProcessDomainEventDispatcher>();",
    );
    expect(prog).not.toContain("NoopDomainEventDispatcher");
  });

  it("emits no HTTP command surface for an event-triggered-only workflow", async () => {
    const files = await generate("test/fixtures/dispatch-sample.ddd");
    const keys = [...files.keys()];
    // The event-triggered-only saga has no command POST: no Request/Command/
    // Handler facade, no workflows controller (an event has no `<Event>Response`
    // wire DTO, so the bogus route wouldn't even compile).
    expect(keys).not.toContain("Application/Workflows/OrderFulfillmentRequest.cs");
    expect(keys).not.toContain("Application/Workflows/OrderFulfillmentCommand.cs");
    expect(keys).not.toContain("Application/Workflows/OrderFulfillmentHandler.cs");
    expect(keys).not.toContain("Api/FulfillmentWorkflowsController.cs");
  });

  it("emits no dispatch wiring for a channel-less project (byte-identical / Noop)", async () => {
    const files = await generate("examples/sales.ddd");
    const keys = [...files.keys()];
    // No in-process dispatcher, no reactor handlers.
    expect(keys).not.toContain("Infrastructure/Events/InProcessDomainEventDispatcher.cs");
    expect(keys.some((k) => /Handler\.cs$/.test(k) && /Start|On/.test(k))).toBe(false);

    // IDomainEvent stays a plain marker; Program.cs keeps the no-op.
    const iface = files.get("Domain/Events/IDomainEvent.cs") ?? "";
    expect(iface).toContain("public interface IDomainEvent { }");
    expect(iface).not.toContain("INotification");
    const prog = files.get("Program.cs") ?? "";
    expect(prog).toContain(
      "builder.Services.AddSingleton<IDomainEventDispatcher, NoopDomainEventDispatcher>();",
    );

    // The command-triggered `placeOrder` workflow still emits its HTTP handler,
    // and its unguarded getById load stays byte-identical (no `?? throw`).
    const handler = files.get("Application/Workflows/PlaceOrderHandler.cs") ?? "";
    expect(handler).toContain(
      "var customer = await _customers.GetByIdAsync(command.CustomerId, cancellationToken);",
    );
  });
});
