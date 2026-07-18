import { describe, expect, it } from "vitest";
import {
  flattenRequired,
  REQUIRED_PRIMITIVES,
} from "../../src/generator/_packs/required-primitives.js";
import { flutterPack } from "../../src/generator/flutter/pack.js";

// ---------------------------------------------------------------------------
// Flutter pack-format groundwork (flutter-mobile-implementation.md Track C —
// WALKING SKELETON): the `flutter` required-primitive surface (display
// primitives only; forms inline/deferred; `pubspec` shell) and the procedural
// `flutterMaterial` pack that renders it as Dart/Material widget trees.
// Pure TS — no Flutter/Dart SDK.
// ---------------------------------------------------------------------------

// The interactive / form family the walking skeleton renders inline or defers —
// mirrors `FLUTTER_INLINE_OR_DEFERRED` in required-primitives.ts.
const INLINE_OR_DEFERRED = new Set([
  "primitive-form-of",
  "primitive-modal",
  "primitive-field",
  "primitive-multiline-field",
  "primitive-number-field",
  "primitive-password-field",
  "primitive-select-field",
  "primitive-toggle",
  "primitive-tabs",
]);

const MISSING = /^\/\/ flutter pack: no renderer/;

describe("flutter pack format groundwork", () => {
  it("flutter required set is the display surface only — forms/inputs/modal render inline or are deferred", () => {
    const flutter = new Set(flattenRequired(REQUIRED_PRIMITIVES.flutter));
    const tsx = new Set(flattenRequired(REQUIRED_PRIMITIVES.tsx));

    // Every shared DISPLAY / layout primitive the TSX set requires is required
    // for flutter too — except the form/input/modal family, which Flutter
    // renders inline (Track B/D) or defers to full parity.
    for (const name of tsx) {
      // Flutter builds with `flutter build`, so it ships a Dart `pubspec`
      // instead of the Vite/npm world's package-json / vite-config / tsconfig
      // and the TSX shell templates.
      if (
        name === "package-json" ||
        name === "vite-config" ||
        name === "tsconfig" ||
        name === "app-shell" ||
        name === "format-helpers" ||
        name === "main" ||
        name === "theme"
      ) {
        continue;
      }
      if (
        INLINE_OR_DEFERRED.has(name) ||
        name.startsWith("field-input-") ||
        name.startsWith("form-") ||
        name === "op-dialog" ||
        name === "realtime-toast"
      ) {
        expect(flutter.has(name), `flutter should NOT require inline/deferred "${name}"`).toBe(
          false,
        );
        continue;
      }
      expect(flutter.has(name), `flutter set missing tsx-required display "${name}"`).toBe(true);
    }

    // No form / field-input surface at all.
    expect(REQUIRED_PRIMITIVES.flutter.fieldInput).toBeUndefined();
    expect(REQUIRED_PRIMITIVES.flutter.form).toBeUndefined();

    // Shell delta: a single Dart `pubspec`, none of the Vite/npm shell files.
    expect(flutter.has("pubspec")).toBe(true);
    expect(flutter.has("package-json")).toBe(false);
    expect(flutter.has("vite-config")).toBe(false);
    expect(flutter.has("tsconfig")).toBe(false);
  });

  it("the flutterMaterial pack loads and renders every required core primitive", () => {
    const pack = flutterPack();
    expect(pack.manifest.name).toBe("flutterMaterial");
    expect(pack.rootDir).toContain("flutter");

    // Consistency: every primitive the `flutter` required-set names must have a
    // real renderer in the procedural pack (no missing-renderer sentinel).  This
    // is the load-time gate the angular groundwork test asserts structurally.
    for (const name of REQUIRED_PRIMITIVES.flutter.core) {
      const out = pack.render(name, {});
      expect(out, `pack has no renderer for required core primitive "${name}"`).not.toMatch(
        MISSING,
      );
      expect(out.length, `renderer for "${name}" produced empty output`).toBeGreaterThan(0);
    }
  });

  it("renders representative display primitives as Material widget trees", () => {
    const pack = flutterPack();

    expect(pack.render("primitive-heading", { level: 1, text: "Orders" })).toContain(
      "Theme.of(context).textTheme.headlineMedium",
    );
    expect(pack.render("primitive-card", { hasTitle: true, titleText: "Total" })).toContain(
      "Card(",
    );
    expect(
      pack.render("primitive-stack", {
        hasChildren: true,
        childrenBlock: "Text('a')",
        indent: "  ",
      }),
    ).toContain("Column(");
    expect(pack.render("primitive-loader", {})).toContain("CircularProgressIndicator");
    expect(pack.render("primitive-button", { label: "Save", hasOnClick: false })).toContain(
      "ElevatedButton(",
    );
    expect(
      pack.render("primitive-table", {
        columns: [{ header: "Id", cellJsx: "Text('1')" }],
        rowsExpr: "rows",
        rowVar: "row",
      }),
    ).toContain("DataTable(");
    // A static testid folds to a widget Key (WidgetTester finder).
    expect(
      pack.render("primitive-stack", {
        hasChildren: true,
        childrenBlock: "Text('a')",
        indent: "  ",
        testidAttr: ' data-testid="orders-list"',
      }),
    ).toContain("key: const Key('orders-list')");
  });

  it("returns the missing-renderer sentinel for an unknown primitive", () => {
    expect(flutterPack().render("primitive-does-not-exist", {})).toMatch(MISSING);
  });
});
