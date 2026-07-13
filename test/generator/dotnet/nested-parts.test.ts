// Part-in-part containment (nested-parts-alignment.md Phase 4 — .NET):
// Order → Shipment[] → Label[].  A nested part's EF owned-type config nests
// inside its DIRECT parent's OwnsMany, its shadow FK column is named for the
// direct parent, and the domain ParentId brands to the direct-parent id type.
// EF materialises/persists the owned graph, so there are no repository changes.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Logistics {
    aggregate Order {
      code: string
      contains shipments: Shipment[]
      operation addShipment(carrier: string) {
        shipments += Shipment { carrier: carrier }
      }
      entity Shipment {
        carrier: string
        contains labels: Label[]
      }
      entity Label { zpl: string }
    }
    repository Orders for Order {
      find byCode(code: string): Order[] where this.code == code
    }
  }
`;

describe("dotnet generator — part-in-part containment", () => {
  it("nests the owned-type config with the direct-parent FK column", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const cfg = generateDotnet(model).get(
      "Infrastructure/Persistence/Configurations/OrderConfiguration.cs",
    )!;

    // Root-level Shipment owns → order_id.
    expect(cfg).toContain('builder.OwnsMany<Shipment>("_shipments", o => {');
    expect(cfg).toContain('o.Property("ParentId").HasColumnName("order_id");');
    // Nested Label owns INSIDE the shipment builder → shipment_id (distinct
    // lambda param o1 so it doesn't shadow the enclosing o).
    expect(cfg).toContain('o.OwnsMany<Label>("_labels", o1 => {');
    expect(cfg).toContain('o1.Property("ParentId").HasColumnName("shipment_id");');
    expect(cfg).toContain('o1.ToTable("labels");');
    expect(cfg).toContain('o1.WithOwner().HasForeignKey("ParentId");');
  });

  it("brands the nested part ParentId to the direct-parent id type", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateDotnet(model);
    // Label's parent is Shipment, so its ParentId is ShipmentId (not OrderId).
    const label = files.get("Domain/Orders/Label.cs")!;
    expect(label).toContain("public ShipmentId ParentId { get; private set; }");
    expect(label).toContain("public ShipmentId ParentId { get; init; } = default!;");
    // Shipment's parent is the root Order → OrderId (unchanged).
    const shipment = files.get("Domain/Orders/Shipment.cs")!;
    expect(shipment).toContain("public OrderId ParentId { get; private set; }");
  });
});
