// Part-in-part containment (nested-parts-alignment.md Phase 2 — node):
// Order → Shipment[] → Label[].  A nested part's Drizzle FK + domain
// `parentId` brand target its DIRECT parent (not the aggregate root), and the
// repository recursively saves + hydrates the nested level.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
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

describe("typescript generator — part-in-part containment", () => {
  it("FKs a nested part to its direct parent (schema + domain branding)", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateHono(model);

    const schema = files.get("db/schema.ts")!;
    // Shipment (root-level) → order_id → orders; Label (nested) → shipment_id → shipments.
    expect(schema).toContain('parentId: uuid("order_id").notNull().references(() => orders.id');
    expect(schema).toContain(
      'parentId: uuid("shipment_id").notNull().references(() => shipments.id',
    );

    const domain = files.get("domain/order.ts")!;
    // Label's parentId brands to ShipmentId (its direct parent), not OrderId.
    expect(domain).toContain("private _parentId: Ids.ShipmentId;");
    // A freshly-built Shipment defaults its own labels (no required arg).
    expect(domain).toContain("labels: state.labels ?? []");
  });

  it("recursively saves + hydrates the nested level keyed by the direct parent", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateHono(model);
    const repo = files.get("db/repositories/order-repository.ts")!;

    // Save: labels diff-synced under each shipment, keyed by child.id (the
    // shipment), inserted into schema.labels (mapped to shipment_id).
    expect(repo).toContain("eq(schema.labels.parentId, child.id)");
    expect(repo).toContain("for (const child1 of child.labels)");

    // Hydrate: labels loaded by inArray on the shipment row ids, grouped, and
    // referenced from the Shipment rehydrate.
    expect(repo).toContain("inArray(schema.labels.parentId, shipmentsRows.map((r) => r.id))");
    expect(repo).toContain("const labelsByParent = new Map<string, Label[]>();");
    expect(repo).toContain("labels: labelsByParent.get(r.id) ?? []");
    // Nested label brands to ShipmentId on hydrate.
    expect(repo).toContain("parentId: Ids.ShipmentId(r.parentId)");
  });

  it("supports INLINE nested construction (parentId omitted, stamped on save)", async () => {
    const { model, errors } = await parseString(`
      context Logistics {
        aggregate Order {
          code: string
          contains shipments: Shipment[]
          operation addFull(carrier: string, zpl: string) {
            shipments += Shipment { carrier: carrier, labels: [Label { zpl: zpl }] }
          }
          entity Shipment { carrier: string  contains labels: Label[] }
          entity Label { zpl: string }
        }
        repository Orders for Order { }
      }
    `);
    expect(errors).toEqual([]);
    const files = generateHono(model);
    const domain = files.get("domain/order.ts")!;
    // The nested Label is constructed WITHOUT parentId (no shipment id yet); the
    // outer Shipment keeps the ambient (order) parent.
    expect(domain).toContain("Label._create({ id: Ids.newLabelId(), zpl: zpl })");
    expect(domain).toMatch(/Shipment\._create\(\{ id: Ids\.newShipmentId\(\), parentId: this\._id/);
    // A nested part defaults its parentId in the ctor (never observed pre-save).
    expect(domain).toContain("this._parentId = state.parentId ?? Ids.newShipmentId();");
    // Save stamps the nested label FK from tree position (the shipment loop var).
    const repo = files.get("db/repositories/order-repository.ts")!;
    expect(repo).toContain("parentId: child.id");
  });
});
