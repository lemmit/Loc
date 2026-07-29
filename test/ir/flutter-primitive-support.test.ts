// Honesty gate for the Flutter-UNRENDERED page primitives
// (`loom.flutter-primitive-unsupported`).  The Flutter pack renders the display
// / layout primitives AND the controlled inputs (Field / MultilineField /
// PasswordField / Toggle / SelectField) AND — via the walker SEAMS — the form
// family (Create/Operation/Workflow/Destroy) and Modal.  What has NO renderer
// yet: NumberField, FileUpload, and Tabs.  Frontends validate against the
// target-AGNOSTIC walker-stdlib, so a page using one of those unrendered
// primitives on a `platform: flutter` target type-checks, then the Flutter
// walker emits a `// flutter pack: no renderer` comment and the widget silently
// vanishes.  This gate fails fast at compile time instead — WITHOUT rejecting
// the primitives Flutter now renders, and leaving every primitive compiling on a
// Handlebars frontend (react).

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

describe("flutter unrendered-primitive honesty gate (`loom.flutter-primitive-unsupported`)", () => {
  it("errors when a Flutter-targeted page uses FileUpload (the one still-unrendered primitive)", async () => {
    const errs = await flutterPrimitiveErrors(sys("flutter", "flutter", 'FileUpload { "Doc" }'));
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("'FileUpload'");
    expect(errs[0]).toContain("silently vanish");
    expect(errs[0]).toContain("platform 'flutter'");
  });

  it("does NOT error for the now-rendered inputs (Toggle / NumberField) on flutter", async () => {
    expect(
      await flutterPrimitiveErrors(sys("flutter", "flutter", 'Toggle { "Notify", bind: enabled }')),
    ).toEqual([]);
    expect(
      await flutterPrimitiveErrors(sys("flutter", "flutter", 'NumberField { "Qty", bind: qty }')),
    ).toEqual([]);
  });

  it("does NOT error for the now-rendered Tabs container on flutter", async () => {
    expect(
      await flutterPrimitiveErrors(sys("flutter", "flutter", 'Tabs { Tab { "a", Text { "x" } } }')),
    ).toEqual([]);
  });

  it("does NOT error for a seam-rendered CreateForm on flutter", async () => {
    expect(
      await flutterPrimitiveErrors(sys("flutter", "flutter", "CreateForm { of: Product }")),
    ).toEqual([]);
  });

  it("does NOT error for FileUpload on a Handlebars frontend (react)", async () => {
    expect(await flutterPrimitiveErrors(sys("react", "react", 'FileUpload { "Doc" }'))).toEqual([]);
  });

  it("does NOT error for a Flutter page using only supported display/layout primitives", async () => {
    expect(await flutterPrimitiveErrors(sys("flutter", "flutter", 'Text { "all good" }'))).toEqual(
      [],
    );
  });
});

describe("flutter unrendered-primitive set (single source of truth)", () => {
  it("maps every FLUTTER_UNRENDERED_PRIMITIVES id to at least one builder name", () => {
    // A newly-deferred `primitive-*` id without a builder-name mapping would
    // silently escape the validator gate — pin that it can't.
    expect(UNMAPPED_DEFERRED_IDS).toEqual([]);
  });

  it("gates only FileUpload — every other input/container/form now renders", () => {
    // The one still-unrendered primitive → gated.
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.has("FileUpload")).toBe(true);
    // Now rendered by the pack → NOT gated.
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.has("Toggle")).toBe(false);
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.has("Field")).toBe(false);
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.has("SelectField")).toBe(false);
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.has("NumberField")).toBe(false);
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.has("Tabs")).toBe(false);
    // Seam-rendered → NOT gated.
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.has("CreateForm")).toBe(false);
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.has("Modal")).toBe(false);
    // Supported display primitive → NOT gated.
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.has("Text")).toBe(false);
    expect(FLUTTER_UNRENDERED_PRIMITIVES.size).toBe(1);
  });
});
