// ---------------------------------------------------------------------------
// Flutter could not round-trip a `money` field (A6).
//
// `money` rides the wire as a decimal STRING at `MONEY_WIRE_SCALE` fractional
// digits — `repository-wire-builder.ts` formats it with `.toFixed(4)`, the
// emitted `wire-spec.json` declares `{"type":"string","format":"decimal"}`, and
// every backend's request schema validates it as `z.string()` over
// `^-?\d+(\.\d+)?$` (`money-scale.ts`, RS-12).  Feliz agrees
// (`Decode.decimal`/`Encode.decimal`), and the four JS frontends agree
// (`moneySchema`).
//
// Flutter did not.  It decoded `(json['price'] as num).toDouble()` and encoded
// a bare `double`, so:
//
//   READ   `String is not a subtype of num` — thrown on EVERY money read
//   WRITE  a JSON number the backend's `z.string()` rejects
//
// Nothing caught it: `flutter analyze` / `flutter build` cannot see a runtime
// cast, and `frontend-fullstack-e2e.yml` does not drive Flutter.  `decimal` is
// the control — it rides the wire as a JSON NUMBER and must stay `as num`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  dartFromJson,
  dartToJson,
  isIdentityJson,
} from "../../../src/generator/flutter/dart-types.js";
import type { TypeIR } from "../../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

const money: TypeIR = { kind: "primitive", name: "money" } as TypeIR;
const decimal: TypeIR = { kind: "primitive", name: "decimal" } as TypeIR;

describe("flutter money wire codec", () => {
  it("decodes money from the wire STRING, not `as num`", () => {
    expect(dartFromJson(money, "json['price']")).toBe("double.parse('${json['price']}')");
    // The exact cast that threw on every read must be gone.
    expect(dartFromJson(money, "json['price']")).not.toContain("as num");
  });

  it("encodes money back as the fixed-scale decimal string the backend accepts", () => {
    expect(dartToJson(money, "price")).toBe("price.toStringAsFixed(4)");
  });

  it("money is NOT identity-JSON — `toJson` must transform it", () => {
    expect(isIdentityJson(money)).toBe(false);
  });

  it("CONTROL: `decimal` rides the wire as a NUMBER and is unchanged", () => {
    expect(dartFromJson(decimal, "json['rate']")).toBe("(json['rate'] as num).toDouble()");
    expect(isIdentityJson(decimal)).toBe(true);
    expect(dartToJson(decimal, "rate")).toBe("rate");
  });

  it("a money ARRAY decodes elementwise from strings", () => {
    const arr: TypeIR = { kind: "array", element: money } as TypeIR;
    expect(dartFromJson(arr, "json['amounts']")).toContain("double.parse('${e}')");
    expect(isIdentityJson(arr)).toBe(false);
    expect(dartToJson(arr, "amounts")).toContain("e.toStringAsFixed(4)");
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
  it("the wire model parses the money string and re-encodes it at wire scale", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const models = [...files.entries()].find(([p]) => p.endsWith("lib/models.dart"))?.[1];
    expect(models, "no models.dart emitted").toBeDefined();
    expect(models!).toContain("price: double.parse('${json['price']}')");
    expect(models!).toContain("'price': price.toStringAsFixed(4)");
    // The decimal control keeps the numeric decode/identity encode.
    expect(models!).toContain("rate: (json['rate'] as num).toDouble()");
    expect(models!).toContain("'rate': rate,");
  });

  it("the create form SUBMITS money as the wire string, decimal as a number", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const forms = [...files.entries()]
      .filter(([p]) => /lib\/.*forms?\.dart$/.test(p) || p.endsWith("lib/forms.dart"))
      .map(([, c]) => c)
      .join("\n");
    expect(forms, "no forms.dart emitted").not.toBe("");
    expect(forms).toContain("'price': double.tryParse(_priceController.text)?.toStringAsFixed(4)");
    // `decimal` is the control — it stays a bare JSON number.
    expect(forms).toContain("'rate': double.tryParse(_rateController.text),");
    // The pre-fix spelling (a bare double for money) must be gone.
    expect(forms).not.toContain("'price': double.tryParse(_priceController.text),");
  });
});
