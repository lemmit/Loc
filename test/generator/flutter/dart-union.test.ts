// Flutter Track A — discriminated-union Dart models.  Lowers a small `.ddd`
// with a named union payload (`payload Foo = A | B`) through the real
// parse → lower → enrich pipeline, then drives the sealed-class emitter
// directly.  String assertions pin the emitted `sealed class` base, its
// tag-switching `fromJson`, and the per-variant `final class … extends`
// hierarchy (record + scalar variants), so a regression surfaces in the fast
// suite.  The `generated-flutter-build.yml` CI gate + the local Flutter SDK
// own "does the Dart compile"; these pin the shape.

import { describe, expect, it } from "vitest";
import {
  renderDartModels,
  renderDartUnion,
} from "../../../src/generator/flutter/dart-model-emit.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { allContexts } from "../../../src/ir/types/loom-ir.js";
import { parseString } from "../../_helpers/parse.js";

// A named union over two events (record variants) plus a union over a scalar
// (`int`) and a value object (record) variant.
const SRC = `
  context Shop {
    event OrderPlaced { sku: string  qty: int }
    event OrderCancelled { reason: string }
    valueobject Money { amount: decimal  currency: string }

    payload OrderEvent = OrderPlaced | OrderCancelled
    payload Scored = int | Money

    aggregate Product { name: string }
    repository Products for Product {}
  }
`;

async function shopContext() {
  const { model } = await parseString(SRC, { validate: false });
  const enriched = enrichLoomModel(lowerModel(model));
  return allContexts(enriched).find((c) => c.name === "Shop")!;
}

function unionPayload(ctx: Awaited<ReturnType<typeof shopContext>>, name: string) {
  const p = ctx.payloads.find((pl) => pl.name === name && pl.variants)!;
  return renderDartUnion(name, p.variants!, ctx);
}

describe("flutter Dart discriminated-union emitter", () => {
  it("emits a sealed base + tag-switching fromJson for a record-variant union", async () => {
    const ctx = await shopContext();
    const dart = unionPayload(ctx, "OrderEvent");

    // Sealed base with a const ctor and an abstract toJson.
    expect(dart).toContain("sealed class OrderEvent {");
    expect(dart).toContain("  const OrderEvent();");
    expect(dart).toContain("  Map<String, dynamic> toJson();");

    // fromJson switches on the `type` discriminator into each variant.
    expect(dart).toContain("factory OrderEvent.fromJson(Map<String, dynamic> json) {");
    expect(dart).toContain("    switch (json['type'] as String) {");
    expect(dart).toContain("      case 'OrderPlaced':");
    expect(dart).toContain("        return OrderEventOrderPlaced.fromJson(json);");
    expect(dart).toContain("      case 'OrderCancelled':");
    expect(dart).toContain("        return OrderEventOrderCancelled.fromJson(json);");
    // Unknown-tag fallback throws (substring stops short of the interpolation
    // so the Dart string's `${...}` doesn't read as a JS template here).
    expect(dart).toContain("        throw ArgumentError('Unknown OrderEvent variant: ");
  });

  it("emits one final variant class per record variant, re-stamping the tag", async () => {
    const ctx = await shopContext();
    const dart = unionPayload(ctx, "OrderEvent");

    expect(dart).toContain("final class OrderEventOrderPlaced extends OrderEvent {");
    expect(dart).toContain("  final String sku;");
    expect(dart).toContain("  final int qty;");
    expect(dart).toContain("  const OrderEventOrderPlaced({");
    expect(dart).toContain(
      "  factory OrderEventOrderPlaced.fromJson(Map<String, dynamic> json) => OrderEventOrderPlaced(",
    );
    expect(dart).toContain("        sku: json['sku'] as String,");
    // toJson re-stamps the discriminator and flattens the fields.
    expect(dart).toContain("  @override");
    expect(dart).toContain("        'type': 'OrderPlaced',");
    expect(dart).toContain("        'sku': sku,");

    expect(dart).toContain("final class OrderEventOrderCancelled extends OrderEvent {");
    expect(dart).toContain("        'type': 'OrderCancelled',");
  });

  it("wraps a scalar variant in a `value` field", async () => {
    const ctx = await shopContext();
    const dart = unionPayload(ctx, "Scored");

    expect(dart).toContain("sealed class Scored {");
    // `int` scalar variant → a single `value` field.
    expect(dart).toContain("final class ScoredInt extends Scored {");
    expect(dart).toContain("  final int value;");
    expect(dart).toContain("        value: json['value'] as int,");
    expect(dart).toContain("        'type': 'int',");
    expect(dart).toContain("        'value': value,");
    // `Money` value-object variant → a record (its wire fields flattened).
    expect(dart).toContain("final class ScoredMoney extends Scored {");
    expect(dart).toContain("  final double amount;");
    expect(dart).toContain("  final String currency;");
    expect(dart).toContain("        'type': 'Money',");
  });

  it("routes union payloads into the combined models library exactly once", async () => {
    const ctx = await shopContext();
    const lib = renderDartModels([ctx]);

    // Both the sealed union and its variant classes appear.
    expect(lib).toContain("sealed class OrderEvent {");
    expect(lib).toContain("final class OrderEventOrderPlaced extends OrderEvent {");
    // The record-payload event classes still emit alongside (unchanged path).
    expect(lib).toContain("class OrderPlaced {");
    // No duplicate sealed base.
    expect(lib.match(/sealed class OrderEvent \{/g)?.length).toBe(1);
  });
});
