import { describe, expect, it } from "vitest";
import { directParentOf } from "../../../src/ir/util/containment-parent.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SRC = `
system S {
  subdomain D {
    context C {
      aggregate Order {
        code: string
        contains shipment: Shipment        // root-level single
        contains lines: Line[]             // root-level collection
        entity Shipment {
          carrier: string
          contains label: Label            // nested single
          contains stickers: Sticker[]     // nested collection
        }
        entity Label { zpl: string }
        entity Sticker { text: string }
        entity Line { sku: string }
      }
      repository Orders for Order { }
    }
  }
}`;

describe("directParentOf", () => {
  it("resolves each part's direct parent + single/nested flags", async () => {
    const model = await buildLoomModel(SRC);
    const order = model.systems
      .flatMap((s) => s.subdomains)
      .flatMap((sd) => sd.contexts)
      .flatMap((c) => c.aggregates)
      .find((a) => a.name === "Order")!;

    // Root-level parts resolve to the root, not nested.
    expect(directParentOf(order, "Shipment")).toEqual({
      name: "Order",
      single: true,
      nested: false,
    });
    expect(directParentOf(order, "Line")).toEqual({ name: "Order", single: false, nested: false });

    // Nested parts resolve to their sibling part, flagged nested.
    expect(directParentOf(order, "Label")).toEqual({
      name: "Shipment",
      single: true,
      nested: true,
    });
    expect(directParentOf(order, "Sticker")).toEqual({
      name: "Shipment",
      single: false,
      nested: true,
    });

    // An unknown part is undefined.
    expect(directParentOf(order, "Nope")).toBeUndefined();
  });
});
