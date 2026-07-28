// Honesty gate for the Flutter-DEFERRED page-primitive family
// (`loom.flutter-primitive-unsupported`).  The Flutter walking-skeleton pack
// renders the display / layout primitives but DEFERS the whole interactive
// input / form family (Tabs / Field* / Toggle / FileUpload / Modal / the
// CreateForm·OperationForm·WorkflowForm·DestroyForm shells).  Frontends validate
// against the target-AGNOSTIC walker-stdlib, so a page using one of these while
// targeting a `platform: flutter` deployable type-checks and validates clean,
// then the Flutter walker emits a `// flutter pack: no renderer` comment and the
// widget silently vanishes.  This gate fails fast at compile time instead — and
// leaves the same page on a Handlebars frontend (react) compiling.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import {
  FLUTTER_DEFERRED_BUILDER_NAMES,
  FLUTTER_INLINE_OR_DEFERRED,
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
// given platform.  The aggregate carries the fields the interactive primitives
// bind against (`active` for Toggle, `name` for a form field).
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
      state { enabled: bool = false }
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

describe("flutter deferred-primitive honesty gate (`loom.flutter-primitive-unsupported`)", () => {
  it("errors when a Flutter-targeted page uses Toggle (a deferred primitive)", async () => {
    const errs = await flutterPrimitiveErrors(
      sys("flutter", "flutter", 'Toggle { label: "Notifications", bind: enabled }'),
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("'Toggle'");
    expect(errs[0]).toContain("silently vanish");
    expect(errs[0]).toContain("platform 'flutter'");
  });

  it("errors when a Flutter-targeted page uses a CreateForm (form-family deferred)", async () => {
    const errs = await flutterPrimitiveErrors(
      sys("flutter", "flutter", "CreateForm { of: Product }"),
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("'CreateForm'");
  });

  it("does NOT error for the same page on a Handlebars frontend (react)", async () => {
    expect(
      await flutterPrimitiveErrors(
        sys("react", "react", 'Toggle { label: "Notifications", bind: enabled }'),
      ),
    ).toEqual([]);
  });

  it("does NOT error for a Flutter page using only supported display/layout primitives", async () => {
    expect(await flutterPrimitiveErrors(sys("flutter", "flutter", 'Text { "all good" }'))).toEqual(
      [],
    );
  });

  it("gates every deferred primitive that appears in one Flutter page", async () => {
    // Tabs + Field + Toggle in one body → three distinct diagnostics (deduped
    // per name).
    const body = [
      'Tabs { Tab { title: "a", Text { "x" } } }',
      'Field { "Name", bind: name }',
      'Toggle { label: "On", bind: enabled }',
    ].join(",\n        ");
    const errs = await flutterPrimitiveErrors(sys("flutter", "flutter", body));
    expect(errs.length).toBe(3);
    expect(errs.some((m) => m.includes("'Tabs'"))).toBe(true);
    expect(errs.some((m) => m.includes("'Field'"))).toBe(true);
    expect(errs.some((m) => m.includes("'Toggle'"))).toBe(true);
  });
});

describe("flutter deferred-primitive set (single source of truth)", () => {
  it("maps every FLUTTER_INLINE_OR_DEFERRED id to at least one builder name", () => {
    // A newly-deferred `primitive-*` id without a builder-name mapping would
    // silently escape the validator gate — pin that it can't.
    expect(UNMAPPED_DEFERRED_IDS).toEqual([]);
  });

  it("derives the gated builder names from the pack set (auto-closes on removal)", () => {
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.has("Toggle")).toBe(true);
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.has("CreateForm")).toBe(true);
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.has("Modal")).toBe(true);
    // A supported display primitive is NOT gated.
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.has("Text")).toBe(false);
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.has("Stack")).toBe(false);
    // The set is non-empty exactly while the pack still defers primitives.
    expect(FLUTTER_DEFERRED_BUILDER_NAMES.size).toBeGreaterThan(0);
    expect(FLUTTER_INLINE_OR_DEFERRED.size).toBeGreaterThan(0);
  });
});
