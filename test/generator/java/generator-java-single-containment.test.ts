// ---------------------------------------------------------------------------
// Java backend — single (non-collection) containments.  JPA has no
// unidirectional one-to-one with the FK on the part table, so the part
// carries a hidden owning `_parent` @OneToOne (writing the parent-FK
// column) and the root maps the inverse via mappedBy + orphanRemoval.
// The part's `_create` factory takes the parent *entity* (the relation
// needs the instance); collection parts keep the parent-id form.
// Boot-verified end-to-end against Postgres via
// test/e2e/fixtures/java-build/single-containment.ddd (null read,
// ship op, replacement orphan removal, list mapping).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SRC = readFileSync("test/e2e/fixtures/java-build/single-containment.ddd", "utf8");

const ROOT = "sc_api/src/main/java/com/loom/scapi";

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java generator — single containment (root-declared)", () => {
  it("passes validation (the gate now covers part-declared single containments only)", async () => {
    const loom = await buildLoomModel(SRC);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
  });

  it("part carries the hidden owning _parent @OneToOne writing the FK column", async () => {
    const part = (await files()).get(`${ROOT}/features/orders/Shipment.java`)!;
    expect(part).toContain("    @OneToOne(fetch = FetchType.LAZY)");
    expect(part).toContain('    @JoinColumn(name = "order_id", nullable = false)');
    expect(part).toContain("    Order _parent;");
    // The read-only parentId mirror stays.
    expect(part).toContain(
      '@AttributeOverride(name = "value", column = @Column(name = "order_id", insertable = false, updatable = false))',
    );
  });

  it("part factory takes the parent entity and sets both the relation and the id mirror", async () => {
    const part = (await files()).get(`${ROOT}/features/orders/Shipment.java`)!;
    expect(part).toContain(
      "public static Shipment _create(Order parent, String carrier, String trackingCode) {",
    );
    expect(part).toContain("        p._parent = parent;");
    expect(part).toContain("        p.parentId = parent.id();");
  });

  it("root maps the inverse with mappedBy + cascade + orphanRemoval", async () => {
    const root = (await files()).get(`${ROOT}/features/orders/Order.java`)!;
    expect(root).toContain(
      '    @OneToOne(mappedBy = "_parent", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.EAGER)',
    );
    expect(root).toContain("    Shipment shipment;");
    // The op's `new Shipment` arm passes `this`, not `this.id`.
    expect(root).toContain("this.shipment = Shipment._create(this, carrier, tracking);");
  });

  it("response mapping null-guards the containment (created empty until an op fills it)", async () => {
    const resp = (await files()).get(`${ROOT}/features/orders/OrderResponse.java`)!;
    expect(resp).toContain(
      "value.shipment() == null ? null : ShipmentResponse.from(value.shipment())",
    );
  });

  it("maps a part-declared (nested) single containment to the sibling part's table", async () => {
    const nested = SRC.replace(
      "entity Shipment { carrier: string  trackingCode: string }",
      `entity Shipment {
          carrier: string
          trackingCode: string
          contains label: Label
        }
        entity Label { zpl: string }`,
    );
    const loom = await buildLoomModel(nested);
    // No longer gated — a nested part FKs to its DIRECT parent (the sibling
    // part), so the JPA join column matches the Flyway DDL (DEBT-15).
    expect(
      validateLoomModel(loom).some((d) => d.code === "loom.java-single-containment-unsupported"),
    ).toBe(false);

    const files = await generateSystemFiles(nested);
    const label = [...files.entries()].find(([k]) => k.endsWith("/Label.java"))?.[1];
    expect(label).toBeDefined();
    // Owning side + read-only mirror reference the DIRECT parent (Shipment), not
    // the root (Order) — and the `_create` factory takes the Shipment instance.
    expect(label!).toMatch(/@JoinColumn\(name = "shipment_id", nullable = false\)/);
    expect(label!).toMatch(/Shipment _parent;/);
    expect(label!).toMatch(/ShipmentId parentId;/);
    expect(label!).toMatch(/public ShipmentId parentId\(\)/);
    expect(label!).toMatch(/public static Label _create\(Shipment parent,/);
    expect(label!).not.toMatch(/OrderId parentId/);

    // The migration FKs the labels table to shipments, not orders.
    const ddl = [...files.entries()]
      .filter(([k]) => k.endsWith(".sql"))
      .map(([, v]) => v)
      .join("\n");
    expect(ddl).toMatch(
      /CREATE TABLE "shop"\."labels"[\s\S]*?"shipment_id" UUID NOT NULL[\s\S]*?REFERENCES "shop"\."shipments"/,
    );
  });
});
