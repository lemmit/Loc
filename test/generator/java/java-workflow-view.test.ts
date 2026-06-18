// Workflow-sourced views (workflow-instance-views.md) on Java — saga slice 4.
// A shorthand `view X = <Workflow> where <pred>` reads the persisted saga-state
// row through its Spring Data repository, filters in-memory (the predicate
// renders to Java over the state accessors), and projects `instanceWireShape`
// into a `<View>Row` record — parity with python / elixir-vanilla.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const SRC = `system S { subdomain O { context O {
  aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id } } }
  repository Orders for Order { }
  event OrderPlaced { order: Order id }
  channel L { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
  enum FulfillmentStatus { Pending, Shipped }
  workflow OrderFulfillment { orderId: Order id  attempts: int  status: FulfillmentStatus
    create(p: OrderPlaced) by p.order { } }
  view ShippedOnes = OrderFulfillment where status == Shipped
  view ActiveOrders = Order where status == "P"
} } api A from O storage pg { type: postgres } deployable api { platform: java contexts: [O] serves: A port: 8080 } }`;

async function gen(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

const find = (files: Map<string, string>, suffix: string): string | undefined =>
  [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1];

describe("java workflow-sourced views", () => {
  it("emits a <View>Row record over the saga instance wire shape", async () => {
    const row = find(await gen(SRC), "ShippedOnesRow.java");
    expect(row, "view row not emitted").toBeDefined();
    expect(row).toContain(
      "public record ShippedOnesRow(UUID orderId, int attempts, FulfillmentStatus status) {",
    );
  });

  it("reads + filters the saga state in the views service", async () => {
    const svc = find(await gen(SRC), "OViews.java");
    expect(svc, "views service not emitted").toBeDefined();
    // Saga-state repo injected alongside the aggregate repo.
    expect(svc).toContain(
      "private final OrderFulfillmentStateRepository orderFulfillmentStateRepository;",
    );
    expect(svc).toContain("public List<ShippedOnesRow> shippedOnes() {");
    expect(svc).toContain("return orderFulfillmentStateRepository.findAll().stream()");
    // The filter renders to an in-memory Java predicate over the state accessors.
    expect(svc).toContain(".filter(x -> x.status() == FulfillmentStatus.Shipped)");
    expect(svc).toContain(
      ".map(x -> new ShippedOnesRow(x.orderId().value(), x.attempts(), x.status()))",
    );
    // The aggregate view still rides the same service (one views service per context).
    expect(svc).toContain("public List<OrderResponse> activeOrders() {");
  });

  it("routes the workflow view under /api/views alongside aggregate views", async () => {
    const ctrl = find(await gen(SRC), "OViewsController.java");
    expect(ctrl, "views controller not emitted").toBeDefined();
    expect(ctrl).toContain('@RequestMapping("/api/views")');
    expect(ctrl).toContain('@GetMapping("/shipped_ones")');
    expect(ctrl).toContain("public List<ShippedOnesRow> shippedOnes() {");
    expect(ctrl).toContain('@GetMapping("/active_orders")');
  });

  it("renders a string filter with Objects.equals (in-memory predicate)", async () => {
    const STR = `system S { subdomain O { context O {
      aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id } } }
      repository Orders for Order { }
      event OrderPlaced { order: Order id }
      channel L { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
      workflow OrderFulfillment { orderId: Order id  label: string
        create(p: OrderPlaced) by p.order { } }
      view DoneOnes = OrderFulfillment where label == "done"
    } } api A from O storage pg { type: postgres } deployable api { platform: java contexts: [O] serves: A port: 8080 } }`;
    const svc = find(await gen(STR), "OViews.java");
    expect(svc).toContain('.filter(x -> Objects.equals(x.label(), "done"))');
    expect(svc).toContain("import java.util.Objects;");
  });
});
