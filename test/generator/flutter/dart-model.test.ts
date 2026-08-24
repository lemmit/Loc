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

// One aggregate with a couple of typed fields (incl. an optional, a
// value-object property, and BOTH decimal-ish primitives) and one value object.
//
// `listPrice: money` and `taxRate: decimal` sit side by side on purpose: they
// are the two halves of RS-12/RS-24 and they diverge (M-T1.21).  `money` rides
// the wire as a fixed-scale decimal STRING and is a Dart `String` — the wire's
// own digits, held verbatim, because a `double` cannot carry `NUMERIC(19,4)`.
// `decimal` rides it as a JSON NUMBER and stays a Dart `double`.  Pinning both
// in one class is what makes the split a decision rather than an accident.
const SRC = `
  valueobject Money {
    amount: decimal
    currency: string
  }

  context Sales {
    aggregate Product {
      name: string
      price: Money
      listPrice: money
      rebate: money?
      taxRate: decimal
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
    // money → String (the wire's digits); decimal → double.  The contrast.
    expect(dart).toContain("  final String listPrice;");
    expect(dart).toContain("  final String? rebate;");
    expect(dart).toContain("  final double taxRate;");

    // Required vs optional constructor params.
    expect(dart).toContain("    required this.name,");
    expect(dart).toContain("    this.note,");

    // fromJson — per-field decode, nested record delegates, optional null-guards.
    expect(dart).toContain("  factory Product.fromJson(Map<String, dynamic> json) => Product(");
    expect(dart).toContain("        id: json['id'] as String,");
    expect(dart).toContain("        stock: json['stock'] as int,");
    expect(dart).toContain("        price: Money.fromJson(json['price'] as Map<String, dynamic>),");
    expect(dart).toContain("        note: json['note'] == null ? null : json['note'] as String,");
    // money decodes with NO parse and NO cast — the string IS the value.  The
    // `(x as num).toDouble()` this used to emit threw on every money read.
    expect(dart).toContain("        listPrice: '${json['listPrice']}',");
    expect(dart).toContain("        rebate: json['rebate'] == null ? null : '${json['rebate']}',");
    expect(dart).not.toContain("listPrice: (json['listPrice'] as num)");
    expect(dart).not.toContain("double.parse('${json['listPrice']}')");
    // CONTROL: `decimal` is a JSON number and keeps the numeric decode.
    expect(dart).toContain("        taxRate: (json['taxRate'] as num).toDouble(),");

    // toJson — scalars pass through, nested record delegates to .toJson().
    expect(dart).toContain("  Map<String, dynamic> toJson() => {");
    expect(dart).toContain("        'name': name,");
    expect(dart).toContain("        'price': price.toJson(),");
    expect(dart).toContain("        'note': note,");
    // money goes back out unchanged — it already IS the wire spelling, so no
    // `toStringAsFixed` re-quantization stands between the field and the wire.
    expect(dart).toContain("        'listPrice': listPrice,");
    expect(dart).not.toContain("listPrice.toStringAsFixed");
    expect(dart).toContain("        'taxRate': taxRate,");
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
