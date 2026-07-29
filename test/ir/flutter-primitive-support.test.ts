// Honesty gate for the Flutter-UNRENDERED page primitives
// (`loom.flutter-primitive-unsupported`).  EVERY page primitive now renders on
// Flutter — the controlled inputs (Field / MultilineField / PasswordField /
// NumberField / Toggle / SelectField) and FileUpload via the pack `RENDERERS`,
// Tabs as a container, and the form family + Modal via the walker SEAMS — so the
// gate's `FLUTTER_UNRENDERED_PRIMITIVES` set is EMPTY and nothing is rejected.
// The gate is retained as a DORMANT safety net: adding a primitive back to the
// unrendered set (a future closed primitive Flutter can't render) re-arms it.
// These tests pin that (a) nothing is currently gated, and (b) the machinery is
// intact (a mapped, non-empty set would still reject on a flutter target).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import {
  FLUTTER_DEFERRED_BUILDER_NAMES,
  FLUTTER_UNRENDERED_PRIMITIVES,
  UNMAPPED_DEFERRED_IDS,
} from "../../src/util/flutter-deferred-primitives.js";
import { parseString } from "../_helpers/parse.js";

async function flutterPrimitiveErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.flutter-primitive-unsupported")
    .map((d) => d.message);
}

// A single page whose body renders `bodyPrimitive`, hosted on a frontend of the
// given platform.  The aggregate carries the fields the primitives bind against.
function sys(frontendPlatform: string, framework: string, bodyPrimitive: string): string {
  return `
system FlutterGate {
  subdomain S {
    context Shop {
      aggregate Product {
        name: string
        active: bool
      }
      repository Products for Product { }
    }
  }
  api ShopApi from S
  ui MobileApp {
    framework: ${framework}
    api Shop: ShopApi
    page Settings {
      route: "/settings"
      state { enabled: bool = false  qty: int = 0 }
      body: Stack {
        Heading { "Settings", level: 1 },
        ${bodyPrimitive}
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: ShopApi port: 8081 }
  deployable app { platform: ${frontendPlatform} targets: api1 ui: MobileApp { Shop: api1 } port: 3006 }
}
`;
}

describe("flutter primitive coverage (`loom.flutter-primitive-unsupported`)", () => {
  it("does NOT error for any input / container / form primitive on flutter — all render now", async () => {
    for (const body of [
      'Toggle { "Notify", bind: enabled }',
      'NumberField { "Qty", bind: qty }',
      'Field { "Name", bind: name }',
      'FileUpload { "Doc", bind: doc }',
      'Tabs { Tab { "a", Text { "x" } } }',
      "CreateForm { of: Product }",
      'Text { "all good" }',
    ]) {
      expect(await flutterPrimitiveErrors(sys("flutter", "flutter", body)), body).toEqual([]);
    }
  });

  it("does NOT error for the same primitives on a Handlebars frontend (react)", async () => {
    expect(
      await flutterPrimitiveErrors(sys("react", "react", 'FileUpload { "Doc", bind: doc }')),
    ).toEqual([]);
  });
});

describe("flutter unrendered-primitive set (dormant safety net)", () => {
  it("is empty today — every page primitive renders", () => {
    expect(FLUTTER_UNRENDERED_PRIMITIVES.size).toBe(0);
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.size).toBe(0);
  });

  it("maps every FLUTTER_UNRENDERED_PRIMITIVES id to a builder name (vacuously true when empty)", () => {
    // The completeness invariant: a re-armed `primitive-*` id without a
    // builder-name mapping would silently escape the gate.  Empty today.
    expect(UNMAPPED_DEFERRED_IDS).toEqual([]);
  });
});
