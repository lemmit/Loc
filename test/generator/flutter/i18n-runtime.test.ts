// Flutter translation runtime (M-T1.11) — the shared `t()` runtime ported to the
// Flutter (Dart) frontend, the sixth and last.
//
// A ui with user-visible strings emits `t('<key>', '<default>')` for literal text
// slots — keyed IDENTICALLY to the `.loom/messages.en.json` catalog via the
// SHARED walker seam — plus a generated `lib/i18n.dart` carrying the catalog as a
// `const Map<String, String>` and ICU formatting via `package:intl`'s
// `MessageFormat`.  A string-less app is byte-identical to pre-i18n.
//
// No Dart is compiled here; `generated-flutter-build.yml` owns "is the Dart real".

import { describe, expect, it } from "vitest";
import { collectUiMessages } from "../../../src/generator/_walker/i18n-extract.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SYSTEM = (body: string, extra = "", decls = ""): string => `
system Shop {
  subdomain S {
    context Sales {
      aggregate Order { status: string }
      repository Orders for Order { }
    }
  }
  ui MobileApp {
    framework: flutter
    api Sales: SalesApi
    ${decls}
    page Home {
      route: "/"
      ${extra}
      body: ${body}
    }
  }
  api SalesApi from S
  storage primary { type: postgres }
  resource st { for: Sales, kind: state, use: primary }
  deployable api1 { platform: node contexts: [Sales] dataSources: [st] serves: SalesApi port: 8081 }
  deployable app { platform: flutter targets: api1 ui: MobileApp { Sales: api1 } port: 3006 }
}
`;

const fileEndingWith = (files: Map<string, string>, suffix: string): string | undefined =>
  [...files].find(([p]) => p.endsWith(suffix))?.[1];

async function homeDart(src: string): Promise<string> {
  const files = await generateSystemFiles(src);
  const dart = fileEndingWith(files, "home_page.dart");
  expect(dart, `no home_page.dart in: ${[...files.keys()].join(", ")}`).toBeDefined();
  return dart!;
}

/** The catalog key the EXTRACTION pass produces for a message — the emitted
 *  `t(…)` call must use exactly this, or a translator's entry never lands. */
async function keyFor(src: string, message: string): Promise<string> {
  const { model } = await parseString(src, { validate: false });
  const ui = enrichLoomModel(lowerModel(model)).systems[0]!.uis.find(
    (u) => u.name === "MobileApp",
  )!;
  const entry = collectUiMessages(ui).find((m) => m.message === message);
  expect(entry).toBeDefined();
  return entry!.key;
}

describe("Flutter i18n runtime", () => {
  it("wraps a literal heading in a t() call keyed to the catalog", async () => {
    const src = SYSTEM(`Heading { "Welcome" }`);
    const dart = await homeDart(src);
    const key = await keyFor(src, "Welcome");
    expect(key).toMatch(/^page\.Home\.heading\./);
    // Dart single-quoted args; `t()` returns a String, so the interpolation seam
    // hands it to `Text(…)` directly rather than coercing through `'${…}'`.
    expect(dart).toContain(`Text(t('${key}', 'Welcome'))`);
    // …and the page imports the generated runtime.
    expect(dart).toContain("import '../i18n.dart';");
  });

  it("emits lib/i18n.dart with the catalog compiled in as a const Map", async () => {
    const files = await generateSystemFiles(SYSTEM(`Heading { "Storefront" }`));
    const i18n = fileEndingWith(files, "lib/i18n.dart");
    expect(i18n).toBeDefined();
    expect(i18n).toContain("const Map<String, String> _en = <String, String>{");
    expect(i18n).toContain("'Storefront',");
    expect(i18n).toContain(
      "String t(String key, String defaultMessage, [Map<String, Object>? values]) {",
    );
    // ICU through package:intl's MessageFormat (already a pubspec dependency).
    expect(i18n).toContain("import 'package:intl/message_format.dart';");
    expect(i18n).toContain("MessageFormat(icu.message, locale: locale).format(icu.values)");
    // The `_en` catalog is flat + key-sorted, so a reordered page can't churn
    // the file.  (Scoped to that block — `_catalogs` below it is a sibling map.)
    const enBlock = i18n!.split("const Map<String, String> _en")[1]!.split("};")[0]!;
    const keys = [...enBlock.matchAll(/^ {2}'([^']+)':/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual([...keys].sort());
  });

  it("emits an interpolated template as a 3-arg ICU t() call + catalog entry", async () => {
    const src = SYSTEM("Heading { `Status: {code}` }", "", "").replace(
      'page Home {\n      route: "/"',
      'page Home(code: string) {\n      route: "/:code"',
    );
    const dart = await homeDart(src);
    const key = await keyFor(src, "Status: {code}");
    // Named-display default + a TYPED Dart map literal — the Dart spelling of the
    // JS runtime's `{ code: code }` values object.
    expect(dart).toContain(`t('${key}', 'Status: {code}', <String, Object>{'code': code})`);
  });

  it("carries an ICU format skeleton verbatim into the message", async () => {
    // `{total, number, ::currency/USD}` rides into the catalog + the t() default
    // UNCHANGED — the message a translator sees is the shared ICU one, keyed
    // identically on every frontend.  Formatting happens at runtime, not by
    // rewriting the catalog.
    const src = SYSTEM("Heading { `Total: {total, number, ::currency/USD}` }").replace(
      'page Home {\n      route: "/"',
      'page Home(total: money) {\n      route: "/:total"',
    );
    const files = await generateSystemFiles(src);
    expect(fileEndingWith(files, "lib/i18n.dart")).toContain(
      "'Total: {total, number, ::currency/USD}',",
    );
    expect(fileEndingWith(files, "lib/i18n.dart")).toContain(
      "String _substitute(String message, Map<String, Object> values) {",
    );
  });

  // --- ICU number/date FORMATTING -------------------------------------------
  // `package:intl`'s `MessageFormat` covers {name} + the brace-bodied
  // plural/select/gender forms but NOT the `, number` / `, date` / `, time`
  // arg-types: it reads `{total, number, ::currency/USD}` as a placeholder NAMED
  // "total, number, ::currency/USD", finds no such value, and renders the
  // literal text `Undefined parameter - …` into the widget (it does not throw,
  // so the `_substitute` fallback never fired).  `_resolveFormats` formats those
  // holes through `NumberFormat`/`DateFormat` FIRST and hands MessageFormat the
  // result as a plain value — the four JS frontends' and Feliz's behaviour.

  it("routes t() through the format pre-pass before MessageFormat", async () => {
    const i18n = fileEndingWith(
      await generateSystemFiles(SYSTEM(`Heading { "Storefront" }`)),
      "lib/i18n.dart",
    )!;
    // The pre-pass is not optional: MessageFormat must never see the raw message.
    expect(i18n).toContain("final _Icu icu = _resolveFormats(message, values);");
    expect(i18n).toContain("MessageFormat(icu.message, locale: locale).format(icu.values)");
    expect(i18n).not.toContain("MessageFormat(message, locale: locale).format(values)");
    // …and formatting needs the formatters, so the import comes along.
    expect(i18n).toContain("import 'package:intl/intl.dart';");
    // The fallback stays for a message MessageFormat genuinely rejects —
    // degrading beats crashing a build().
    expect(i18n).toContain("return _substitute(message, values);");
  });

  it("covers every ICU arg-type the validator admits", async () => {
    // `checkTemplateHoles` (src/language/validators/template.ts) accepts exactly
    // number / date / time / plural / selectordinal / select.  plural + select
    // are MessageFormat-native; the other three MUST be in the pre-pass regex,
    // or a hole the validator waved through renders "Undefined parameter - …".
    const i18n = fileEndingWith(
      await generateSystemFiles(SYSTEM(`Heading { "Storefront" }`)),
      "lib/i18n.dart",
    )!;
    const argTypes = /RegExp\(r'\\\{.*?\((number(?:\|[a-z]+)*)\).*?'\);/.exec(i18n)?.[1];
    expect(argTypes?.split("|").sort()).toEqual(["date", "number", "time"]);
  });

  it("maps the number styles and skeleton stems onto intl formatters", async () => {
    const i18n = fileEndingWith(
      await generateSystemFiles(SYSTEM(`Heading { "Storefront" }`)),
      "lib/i18n.dart",
    )!;
    // `::currency/USD` → a currency formatter for THAT currency code.
    expect(i18n).toContain("NumberFormat.simpleCurrency(locale: locale, name: stem.substring(9));");
    expect(i18n).toContain("format = NumberFormat.percentPattern(locale);");
    expect(i18n).toContain("format = NumberFormat.compact(locale: locale);");
    // An unrecognised stem still renders a locale-formatted number rather than
    // failing the message.
    expect(i18n).toContain("format ?? NumberFormat.decimalPattern(locale), minFraction");
  });

  it("maps the four classic date widths and falls back on uninitialized locale data", async () => {
    const i18n = fileEndingWith(
      await generateSystemFiles(SYSTEM(`Heading { "Storefront" }`)),
      "lib/i18n.dart",
    )!;
    for (const width of ["DateFormat.yMd", "DateFormat.yMMMd", "DateFormat.yMMMMd"]) {
      expect(i18n).toContain(`_localizedDate(${width})`);
    }
    // `intl` loads date symbols lazily, so `DateFormat.yMd('en')` THROWS until
    // `initializeDateFormatting` runs — a `, date` hole must fall back to the
    // SDK default rather than taking the whole message down.
    expect(i18n).toContain("DateFormat _localizedDate(DateFormat Function(String?) build) {");
    expect(i18n).toContain("    return build(null);");
  });

  it("degrades one unformattable hole, not the whole message", async () => {
    const i18n = fileEndingWith(
      await generateSystemFiles(SYSTEM(`Heading { "Storefront" }`)),
      "lib/i18n.dart",
    )!;
    // A value of the wrong runtime type rewrites to a BARE `{name}` — the raw
    // value MessageFormat can substitute — never the skeleton arg it cannot.
    expect(i18n).toContain("if (text == null) return '{$name}';");
    expect(i18n).toContain("String? _formatValue(String type, String style, Object value) {");
  });

  it("threads the prefix into a component body (component.<Name> keys)", async () => {
    const src = SYSTEM(
      `Stack { Banner(), Heading { "Home" } }`,
      "",
      `component Banner() { body: Text { "Shop banner" } }`,
    );
    const files = await generateSystemFiles(src);
    const components = fileEndingWith(files, "lib/components.dart");
    expect(components).toMatch(/t\('component\.Banner\.text\.\w+', 'Shop banner'\)/);
    // The components file sits beside the runtime under `lib/`.
    expect(components).toContain("import 'i18n.dart';");
    expect(fileEndingWith(files, "lib/i18n.dart")).toContain("'Shop banner',");
  });

  it("leaves a dynamic text slot untranslated (no stable source string)", async () => {
    const dart = await homeDart(
      SYSTEM(`Stack { Heading { "Orders" }, Text { note } }`, "state { note: string }"),
    );
    expect(dart).toMatch(/t\('page\.Home\.heading\.\w+', 'Orders'\)/);
    // `note` is page state — interpolated from the projected record, never a t().
    expect(dart).not.toContain("'page.Home.text");
    expect(dart).toContain("state.note");
  });

  it("does not emit the runtime for a string-less app", async () => {
    const files = await generateSystemFiles(SYSTEM(`Text { note }`, "state { note: string }"));
    expect(fileEndingWith(files, "lib/i18n.dart")).toBeUndefined();
    const dart = fileEndingWith(files, "home_page.dart")!;
    expect(dart).not.toContain("import '../i18n.dart';");
    // A standalone `t(` — the lookbehind keeps `Text(` from matching.
    expect(dart).not.toMatch(/(?<![A-Za-z0-9_$.])t\(/);
  });

  it("keeps the widget-slot packs correct — no t() call spliced into a Dart literal", async () => {
    const dart = await homeDart(
      SYSTEM(
        `Stack { Badge { "beta" }, Anchor { "Docs", to: "/docs" }, Alert { "Boom", title: "Heads up" }, Stat { "Total", "42" } }`,
      ),
    );
    // The pack must never wrap a rendered `Text(t(…))` widget in quotes.
    expect(dart).not.toContain("Text('Text(");
    expect(dart).not.toContain("'${Text(");
    for (const role of ["badge", "anchor", "alert", "alertTitle", "statLabel", "statValue"]) {
      expect(dart).toContain(`t('page.Home.${role}.`);
    }
    // The Anchor's label is the TextButton's child widget, not a quoted string.
    expect(dart).toMatch(/TextButton\(onPressed: [^,]+, child: Text\(t\('page\.Home\.anchor\./);
  });

  // --- ATTRIBUTE-position slots (D-I18N-ATTR) -------------------------------
  // Flutter's markup is not HTML, so its pack cannot splice the walker's
  // ` aria-label="…"` fragment; it consumes the same accessible name as a
  // target-native VALUE (`localizedNamedValue`), already translated.

  it("translates named aria-label slots (Button + Toolbar) as Semantics labels", async () => {
    const src = SYSTEM(
      `Toolbar { label: "Order actions", Button { "+", label: "Add order", to: "/new" } }`,
    );
    const dart = await homeDart(src);
    const buttonKey = await keyFor(src, "Add order");
    const toolbarKey = await keyFor(src, "Order actions");
    expect(dart).toContain(`Semantics(label: t('${buttonKey}', 'Add order')`);
    expect(dart).toContain(`Semantics(container: true, label: t('${toolbarKey}', 'Order actions')`);
  });

  it("keeps the Toolbar's DEFAULT accessible name a plain Dart literal", async () => {
    // "Actions" is the pack's own fallback — no source literal, so it is not in
    // the catalog and must never become a `t()` call (its key would resolve to
    // nothing).  This is the i18n-ON app exercising the value seam's OFF branch.
    const dart = await homeDart(SYSTEM(`Toolbar { Heading { "Orders" } }`));
    expect(dart).toContain("Semantics(container: true, label: 'Actions'");
  });

  it("renders + translates the Divider label (it was extracted but dropped)", async () => {
    // The label reached `.loom/messages.en.json` while `const Divider()` rendered
    // nothing — a translator translating a string the app never showed.  Now the
    // rule splits around it.
    const src = SYSTEM(`Divider { label: "Section break" }`);
    const dart = await homeDart(src);
    const key = await keyFor(src, "Section break");
    expect(dart).toContain("Row(children: <Widget>[const Expanded(child: Divider())");
    expect(dart).toContain(`child: Text(t('${key}', 'Section break'))`);
  });

  it("keeps an unlabelled Divider byte-identical", async () => {
    const dart = await homeDart(SYSTEM(`Stack { Heading { "Orders" }, Divider { } }`));
    expect(dart).toContain("const Divider()");
    expect(dart).not.toContain("Expanded(child: Divider())");
  });
  it("translates the Icon accessible name (iconLabel) as a semanticLabel", async () => {
    const src = SYSTEM(`Icon { name: "check", label: "Verified" }`);
    const dart = await homeDart(src);
    const key = await keyFor(src, "Verified");
    expect(dart).toContain(`semanticLabel: t('${key}', 'Verified')`);
    // The English must not ALSO be spliced as a raw Dart literal.
    expect(dart).not.toContain("semanticLabel: 'Verified'");
  });

  it("keeps a decorative Icon byte-identical (no semanticLabel at all)", async () => {
    const dart = await homeDart(SYSTEM(`Stack { Heading { "Orders" }, Icon { name: "check" } }`));
    expect(dart).toContain("Icon(Icons.circle, size: 20.0)");
  });

  it("translates the CodeBlock caption (codeBlockTitle) — but never the code", async () => {
    const src = SYSTEM(`CodeBlock { "let total = 1", language: "dart", title: "Example" }`);
    const dart = await homeDart(src);
    const key = await keyFor(src, "Example");
    // The caption arrives as a rendered `Text(t(…))` widget, so the pack styles
    // it through `DefaultTextStyle.merge` rather than re-wrapping it in a
    // `Text('…')` literal (which would print the call).
    expect(dart).toContain(`Text(t('${key}', 'Example'))`);
    expect(dart).not.toContain("Text('Text(");
    expect(dart).toContain("Text('let total = 1'");
  });

  it("leaves an UNTITLED CodeBlock string-less — the code is not a slot", async () => {
    const files = await generateSystemFiles(SYSTEM(`CodeBlock { "let total = 1" }`));
    expect(fileEndingWith(files, "lib/i18n.dart")).toBeUndefined();
    expect(fileEndingWith(files, "home_page.dart")).toContain("Text('let total = 1'");
  });
});
