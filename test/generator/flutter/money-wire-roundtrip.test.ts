// ---------------------------------------------------------------------------
// Flutter's `money` codec — the wire STRING, held verbatim (M-T1.21 / A6).
//
// `money` rides the wire as a decimal STRING at `MONEY_WIRE_SCALE` fractional
// digits — `repository-wire-builder.ts` formats it with `.toFixed(4)`, the
// emitted `wire-spec.json` declares `{"type":"string","format":"decimal"}`, and
// every backend's request schema validates it as `z.string()` over
// `^-?\d+(\.\d+)?$` (`money-scale.ts`, RS-12).  Feliz agrees
// (`Decode.decimal`/`Encode.decimal`, an F# `decimal`), and the four JS
// frontends agree (`moneySchema` + decimal.js).
//
// Flutter's history here is two bugs, not one:
//
//   1. It decoded `(json['price'] as num).toDouble()` and encoded a bare
//      `double` — `String is not a subtype of num` on EVERY money read, and a
//      JSON number the backend's `z.string()` rejects on every write.
//   2. The first fix parsed the string into a `double` and re-formatted it with
//      `toStringAsFixed(4)`.  That stopped the crash, but a Dart `double` is a
//      binary float with ~15-17 significant digits against a `NUMERIC(19,4)`
//      column, so it silently re-quantized every amount it carried.
//
// Now `money` IS a Dart `String`: decode takes the wire value as-is, encode
// hands it straight back.  `decimal` is the control — it rides the wire as a
// JSON NUMBER and must stay `as num` / a Dart `double`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  dartFromJson,
  dartToJson,
  dartType,
  isIdentityJson,
} from "../../../src/generator/flutter/dart-types.js";
import type { TypeIR } from "../../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

const money: TypeIR = { kind: "primitive", name: "money" } as TypeIR;
const decimal: TypeIR = { kind: "primitive", name: "decimal" } as TypeIR;

describe("flutter money wire codec", () => {
  it("spells money as a Dart String — never a double", () => {
    expect(dartType(money)).toBe("String");
    // CONTROL: `decimal` really is a binary float on the wire and in Dart.
    expect(dartType(decimal)).toBe("double");
  });

  it("decodes money from the wire STRING with no parse and no cast", () => {
    expect(dartFromJson(money, "json['price']")).toBe("'${json['price']}'");
    // The exact cast that threw on every read must be gone…
    expect(dartFromJson(money, "json['price']")).not.toContain("as num");
    // …and so must the double hop that replaced it.
    expect(dartFromJson(money, "json['price']")).not.toContain("double.parse");
  });

  it("encodes money back as the same string, unquantized", () => {
    expect(dartToJson(money, "price")).toBe("price");
    expect(dartToJson(money, "price")).not.toContain("toStringAsFixed");
  });

  it("money IS identity-JSON — a String is what the wire carries", () => {
    expect(isIdentityJson(money)).toBe(true);
  });

  it("CONTROL: `decimal` rides the wire as a NUMBER and is unchanged", () => {
    expect(dartFromJson(decimal, "json['rate']")).toBe("(json['rate'] as num).toDouble()");
    expect(isIdentityJson(decimal)).toBe(true);
    expect(dartToJson(decimal, "rate")).toBe("rate");
  });

  it("a money ARRAY decodes elementwise from strings", () => {
    const arr: TypeIR = { kind: "array", element: money } as TypeIR;
    expect(dartType(arr)).toBe("List<String>");
    expect(dartFromJson(arr, "json['amounts']")).toContain("'${e}'");
    expect(dartFromJson(arr, "json['amounts']")).not.toContain("as num");
    // Element-wise identity → the whole list is identity, so no `.map` on the
    // way out either.
    expect(isIdentityJson(arr)).toBe(true);
    expect(dartToJson(arr, "amounts")).toBe("amounts");
  });
});

const SYSTEM = `
system MoneyApp {
  subdomain S {
    context Ops {
      aggregate Product {
        name: string
        price: money
        rate: decimal
        create(name: string, price: money, rate: decimal) { }
      }
      repository Products for Product { }
    }
  }
  api OpsApi from S
  storage primary { type: postgres }
  resource st { for: Ops, kind: state, use: primary }
  ui App {
    framework: flutter
    api Ops: OpsApi
    page Home {
      route: "/"
      body: Stack { CreateForm { of: Product } }
    }
  }
  deployable api { platform: node contexts: [Ops] dataSources: [st] serves: OpsApi port: 4400 }
  deployable app { platform: flutter targets: api ui: App { Ops: api } port: 3007 }
}`;

describe("flutter money — emitted Dart", () => {
  it("the wire model holds the money string and hands it back unchanged", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const models = [...files.entries()].find(([p]) => p.endsWith("lib/models.dart"))?.[1];
    expect(models, "no models.dart emitted").toBeDefined();
    expect(models!).toContain("final String price;");
    expect(models!).toContain("price: '${json['price']}'");
    expect(models!).toContain("'price': price,");
    expect(models!).not.toContain("price.toStringAsFixed");
    // The decimal control keeps the numeric type, decode and identity encode.
    expect(models!).toContain("final double rate;");
    expect(models!).toContain("rate: (json['rate'] as num).toDouble()");
    expect(models!).toContain("'rate': rate,");
  });

  it("the create form SUBMITS the typed money text, decimal as a number", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const forms = [...files.entries()]
      .filter(([p]) => /lib\/.*forms?\.dart$/.test(p) || p.endsWith("lib/forms.dart"))
      .map(([, c]) => c)
      .join("\n");
    expect(forms, "no forms.dart emitted").not.toBe("");
    expect(forms).toContain("'price': _priceController.text.trim(),");
    // `decimal` is the control — it stays a bare JSON number.
    expect(forms).toContain("'rate': double.tryParse(_rateController.text),");
    // Neither wrong spelling survives: the bare double (rejected at the wire
    // boundary) nor the double hop (which re-quantized what the user typed).
    expect(forms).not.toContain("'price': double.tryParse(_priceController.text),");
    expect(forms).not.toContain("_priceController.text)?.toStringAsFixed");
  });
});
