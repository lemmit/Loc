import { describe, expect, it } from "vitest";
import {
  directParentName,
  directParentOf,
  partsChildrenFirst,
} from "../../../src/ir/util/containment-parent.js";
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

describe("directParentName", () => {
  it("returns the direct parent for nested parts, the default owner for root-level", async () => {
    const model = await buildLoomModel(SRC);
    const order = model.systems
      .flatMap((s) => s.subdomains)
      .flatMap((sd) => sd.contexts)
      .flatMap((c) => c.aggregates)
      .find((a) => a.name === "Order")!;

    // Root-level parts resolve to the default owner (the FK owner the caller
    // passes — the root table, or a TPH base).
    expect(directParentName(order, "Shipment", "Order")).toBe("Order");
    expect(directParentName(order, "Line", "OrderBase")).toBe("OrderBase");
    // Nested parts resolve to their sibling — the FK column source of truth
    // shared with the migration builder (`shipment_id`, not `order_id`).
    expect(directParentName(order, "Label", "Order")).toBe("Shipment");
    expect(directParentName(order, "Sticker", "Order")).toBe("Shipment");
  });
});

describe("partsChildrenFirst", () => {
  it("orders a contained part before its container (stable otherwise)", async () => {
    const model = await buildLoomModel(SRC);
    const order = model.systems
      .flatMap((s) => s.subdomains)
      .flatMap((sd) => sd.contexts)
      .flatMap((c) => c.aggregates)
      .find((a) => a.name === "Order")!;

    const ordered = partsChildrenFirst(order.parts).map((p) => p.name);
    // Declaration order is [Shipment, Label, Sticker, Line]; Shipment contains
    // Label + Sticker, so both must precede Shipment.  Line (independent) keeps
    // its relative position.
    expect(ordered.indexOf("Label")).toBeLessThan(ordered.indexOf("Shipment"));
    expect(ordered.indexOf("Sticker")).toBeLessThan(ordered.indexOf("Shipment"));
    // Every declared part appears exactly once.
    expect([...ordered].sort()).toEqual(["Label", "Line", "Shipment", "Sticker"]);
  });

  it("is byte-stable (identity order) when no part contains a sibling", () => {
    const flat = [
      { name: "A", contains: [] },
      { name: "B", contains: [] },
      { name: "C", contains: [] },
    ] as unknown as Parameters<typeof partsChildrenFirst>[0];
    expect(partsChildrenFirst(flat).map((p) => p.name)).toEqual(["A", "B", "C"]);
  });
});
