// Flutter Track A — Dart wire-model emitter.  Lowers a small `.ddd` through the
// real parse → lower → enrich pipeline (the same path every backend consumes),
// then drives the Dart model collectors/emitters directly (Flutter isn't wired
// into `flutter/index.ts` yet).  String assertions pin the emitted `class`,
// `fromJson`, and `toJson` shapes so a regression surfaces in the fast suite.

import { describe, expect, it } from "vitest";
import {
  dartRecordForAggregate,
  dartRecordForValueObject,
  renderDartModel,
  renderDartModels,
} from "../../../src/generator/flutter/dart-model-emit.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { allContexts } from "../../../src/ir/types/loom-ir.js";
import { parseString } from "../../_helpers/parse.js";

// One aggregate with a couple of typed fields (incl. an optional + a
// value-object property) and one value object.
const SRC = `
  valueobject Money {
    amount: decimal
    currency: string
  }

  context Sales {
    aggregate Product {
      name: string
      price: Money
      stock: int
      note: string?
    }
    repository Products for Product {}
  }
`;

async function salesContext() {
  const { model } = await parseString(SRC, { validate: false });
  const enriched = enrichLoomModel(lowerModel(model));
  return allContexts(enriched).find((c) => c.name === "Sales")!;
}

describe("flutter Dart wire-model emitter", () => {
  it("emits a Dart class for an aggregate off its wire shape", async () => {
    const ctx = await salesContext();
    const agg = ctx.aggregates.find((a) => a.name === "Product")!;
    const dart = renderDartModel(dartRecordForAggregate(agg));

    // Class + const constructor.
    expect(dart).toContain("class Product {");
    expect(dart).toContain("  const Product({");

    // Fields keep the exact wire names and map to Dart types; id is first.
    expect(dart).toContain("  final String id;");
    expect(dart).toContain("  final String name;");
    expect(dart).toContain("  final Money price;"); // nested value-object type
    expect(dart).toContain("  final int stock;");
    expect(dart).toContain("  final String? note;"); // optional → nullable

    // Required vs optional constructor params.
    expect(dart).toContain("    required this.name,");
    expect(dart).toContain("    this.note,");

    // fromJson — per-field decode, nested record delegates, optional null-guards.
    expect(dart).toContain("  factory Product.fromJson(Map<String, dynamic> json) => Product(");
    expect(dart).toContain("        id: json['id'] as String,");
    expect(dart).toContain("        stock: json['stock'] as int,");
    expect(dart).toContain("        price: Money.fromJson(json['price'] as Map<String, dynamic>),");
    expect(dart).toContain("        note: json['note'] == null ? null : json['note'] as String,");

    // toJson — scalars pass through, nested record delegates to .toJson().
    expect(dart).toContain("  Map<String, dynamic> toJson() => {");
    expect(dart).toContain("        'name': name,");
    expect(dart).toContain("        'price': price.toJson(),");
    expect(dart).toContain("        'note': note,");
  });

  it("emits a Dart class for a value object", async () => {
    const ctx = await salesContext();
    const vo = ctx.valueObjects.find((v) => v.name === "Money")!;
    const dart = renderDartModel(dartRecordForValueObject(vo));

    expect(dart).toContain("class Money {");
    expect(dart).toContain("  final double amount;"); // decimal → double
    expect(dart).toContain("  final String currency;");
    expect(dart).toContain("  factory Money.fromJson(Map<String, dynamic> json) => Money(");
    expect(dart).toContain("        amount: (json['amount'] as num).toDouble(),");
    expect(dart).toContain("        'currency': currency,");
  });

  it("emits every context model in one library body (deduped)", async () => {
    const ctx = await salesContext();
    const lib = renderDartModels([ctx]);
    // Both the value object and the aggregate appear, each exactly once.
    expect(lib).toContain("class Money {");
    expect(lib).toContain("class Product {");
    expect(lib.match(/class Money \{/g)?.length).toBe(1);
    expect(lib.match(/class Product \{/g)?.length).toBe(1);
  });
});
