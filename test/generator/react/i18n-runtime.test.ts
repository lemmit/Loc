// React translation runtime (M-T1.11, i18n.md Phase 2) — a UI with user-visible
// strings emits `{t("<key>", "<default>")}` for literal text slots (keyed
// IDENTICALLY to the `.loom/messages.en.json` catalog), plus a generated
// `src/i18n.ts` shim and `src/locales/en.json`. A string-less app is unchanged.

import { describe, expect, it } from "vitest";
import { collectUiMessages } from "../../../src/generator/_walker/i18n-extract.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { generateSystemFiles } from "../../_helpers/index.js";
import { parseString } from "../../_helpers/parse.js";

const SYSTEM = (body: string) => `
  system Shop {
    subdomain Sales {
      context Sales {
        aggregate Order with crudish { status: string }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    ui Web {
      api Sales: SalesApi
      page Home { route: "/" body: ${body} }
    }
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable api {
      platform: node
      contexts: [Sales]
      dataSources: [salesState]
      serves: SalesApi
      port: 3000
    }
    deployable web { platform: react targets: api ui: Web port: 3100 }
  }
`;

async function pageOf(files: Map<string, string>): Promise<string> {
  const entry = [...files].find(([p]) => p.endsWith("home.tsx"));
  if (!entry) throw new Error("home.tsx not emitted");
  return entry[1];
}

/** The emitted app catalog (`src/locales/en.json`). */
function catalogOf(files: Map<string, string>): Record<string, string> {
  return JSON.parse([...files].find(([p]) => p.endsWith("src/locales/en.json"))![1]) as Record<
    string,
    string
  >;
}

describe("React i18n runtime", () => {
  it("wraps a literal heading in a t() call keyed to the catalog", async () => {
    const files = await generateSystemFiles(SYSTEM(`Heading { "Welcome" }`));
    const home = await pageOf(files);
    // The key MUST equal what the extraction pass produces for this slot.
    const { model } = await parseString(SYSTEM(`Heading { "Welcome" }`), { validate: false });
    const ui = enrichLoomModel(lowerModel(model)).systems[0]!.uis.find((u) => u.name === "Web")!;
    const entry = collectUiMessages(ui).find((m) => m.message === "Welcome")!;
    expect(entry).toBeDefined();
    expect(home).toContain(`t(${JSON.stringify(entry.key)}, "Welcome")`);
    expect(home).toContain(`import { t } from "../i18n"`);
  });

  it("emits the src/i18n.ts shim and src/locales/en.json catalog", async () => {
    const files = await generateSystemFiles(SYSTEM(`Heading { "Storefront" }`));
    const i18n = [...files].find(([p]) => p.endsWith("src/i18n.ts"))?.[1];
    const locale = [...files].find(([p]) => p.endsWith("src/locales/en.json"))?.[1];
    expect(i18n).toContain("export function t(");
    expect(i18n).toContain('import en from "./locales/en.json"');
    expect(locale).toBeDefined();
    const catalog = JSON.parse(locale!) as Record<string, string>;
    expect(Object.values(catalog)).toContain("Storefront");
    // Flat, key-sorted.
    const keys = Object.keys(catalog);
    expect(keys).toEqual([...keys].sort());
  });

  it("leaves a dynamic text slot untranslated (no stable source string)", async () => {
    const files = await generateSystemFiles(
      SYSTEM(`Stack { Heading { "Orders" }, Text { status } }`),
    );
    const home = await pageOf(files);
    expect(home).toContain('"Orders")'); // the literal heading is translated
    // `status` is a page param ref — interpolated, never a t() call.
    expect(home).not.toContain('t("page.Home.text');
  });

  it("does not emit the runtime for a string-less app", async () => {
    // A page whose only text is a dynamic ref has no extractable strings.
    const files = await generateSystemFiles(SYSTEM(`Text { status }`));
    expect([...files].some(([p]) => p.endsWith("src/i18n.ts"))).toBe(false);
    expect([...files].some(([p]) => p.endsWith("locales/en.json"))).toBe(false);
    const home = await pageOf(files);
    expect(home).not.toContain("import { t }");
  });

  it("emits an interpolated template as a 3-arg ICU t() call + catalog entry", async () => {
    // A page param so the interpolation hole resolves to a real ref.
    const withParam = SYSTEM("Heading { `Status: {code}` }").replace(
      'page Home { route: "/"',
      'page Home(code: string) { route: "/:code"',
    );
    const files = await generateSystemFiles(withParam);
    const home = [...files].find(([p]) => p.endsWith("home.tsx"))![1];
    // Named-display default + a values object; keyed to the catalog.
    expect(home).toMatch(
      /<Title order=\{2\}>\{t\("[^"]*", "Status: \{code\}", \{ code: code \}\)\}<\/Title>/,
    );
    const locale = [...files].find(([p]) => p.endsWith("src/locales/en.json"))?.[1];
    expect(Object.values(JSON.parse(locale!) as Record<string, string>)).toContain(
      "Status: {code}",
    );
  });

  it("formats the shim via intl-messageformat (ICU, not a {name} regex)", async () => {
    // Slice 1 swaps the old `message.replace(/{name}/)` regex shim for the ICU
    // engine so a `, number` / `, date` format suffix locale-formats at runtime.
    const files = await generateSystemFiles(SYSTEM(`Heading { "Hi" }`));
    const i18n = [...files].find(([p]) => p.endsWith("src/i18n.ts"))![1];
    expect(i18n).toContain('import { IntlMessageFormat } from "intl-messageformat"');
    expect(i18n).toContain("new IntlMessageFormat(message, locale).format(values)");
    // `values` widened to admit Date (for `, date`) + boolean alongside string/number.
    expect(i18n).toMatch(/values\?: Record<string, string \| number \| boolean \| Date>/);
    // No leftover regex shim.
    expect(i18n).not.toContain("message.replace(");
    // A plain 2-arg call (no values) still returns the message untouched (no parse cost).
    expect(i18n).toContain("if (values === undefined) return message;");
  });

  it("emits a formatted hole as an ICU message with skeleton + the raw value in values", async () => {
    // `{total, number, ::currency/USD}` — the skeleton rides into the catalog +
    // the t() default, and `values` carries the RAW money value (not stringified).
    const withParam = SYSTEM("Heading { `Total: {total, number, ::currency/USD}` }").replace(
      'page Home { route: "/"',
      'page Home(total: money) { route: "/:total"',
    );
    const files = await generateSystemFiles(withParam);
    const home = [...files].find(([p]) => p.endsWith("home.tsx"))![1];
    expect(home).toMatch(
      /\{t\("[^"]*", "Total: \{total, number, ::currency\/USD\}", \{ total: total \}\)\}/,
    );
    const locale = [...files].find(([p]) => p.endsWith("src/locales/en.json"))![1];
    expect(Object.values(JSON.parse(locale) as Record<string, string>)).toContain(
      "Total: {total, number, ::currency/USD}",
    );
    // The stack carries the ICU engine dependency.
    const pkg = [...files].find(([p]) => p.endsWith("web/package.json"))![1];
    expect(pkg).toContain("intl-messageformat");
  });

  it("emits a plural + select hole as a nested-brace ICU message (slice 2)", async () => {
    // The brace-balanced lexer captures the whole plural/select body; the raw
    // ICU string rides verbatim into the catalog + the t() default, and the
    // intl-messageformat runtime renders the count-/value-selected branch.
    const withParam = SYSTEM(
      "Stack { " +
        "Text { `You have {count, plural, one {# order} other {# orders}}` }, " +
        "Text { `Status: {status, select, shipped {Shipped} other {Pending}}` } }",
    ).replace('page Home { route: "/"', 'page Home(count: int, status: string) { route: "/:count"');
    const files = await generateSystemFiles(withParam);
    const home = [...files].find(([p]) => p.endsWith("home.tsx"))![1];
    expect(home).toContain(
      't("page.Home.text.io7xmj", "You have {count, plural, one {# order} other {# orders}}", { count: count })',
    );
    expect(home).toContain(
      't("page.Home.text.0lqlui", "Status: {status, select, shipped {Shipped} other {Pending}}", { status: status })',
    );
    const catalog = JSON.parse(
      [...files].find(([p]) => p.endsWith("src/locales/en.json"))![1],
    ) as Record<string, string>;
    expect(Object.values(catalog)).toContain(
      "You have {count, plural, one {# order} other {# orders}}",
    );
    expect(Object.values(catalog)).toContain(
      "Status: {status, select, shipped {Shipped} other {Pending}}",
    );
  });

  it("translates named aria-label attribute slots (Button + Toolbar)", async () => {
    // The named slots `Button.label` (buttonAria) and `Toolbar.label`
    // (toolbarAria) bind their accessible name through `t()` at the attribute
    // position (M-T1.11), keyed identically to the catalog.  The Toolbar's
    // `role="toolbar"` stays static; a Toolbar with no `label:` keeps the
    // static default `aria-label="Actions"` (not cataloged).
    const files = await generateSystemFiles(
      SYSTEM(`Toolbar { label: "Order actions", Button { "+", label: "Add order", to: "/new" } }`),
    );
    const home = [...files].find(([p]) => p.endsWith("home.tsx"))![1];
    expect(home).toMatch(/aria-label=\{t\("page\.Home\.buttonAria\.\w+", "Add order"\)\}/);
    expect(home).toMatch(
      /role="toolbar" aria-label=\{t\("page\.Home\.toolbarAria\.\w+", "Order actions"\)\}/,
    );
    const catalog = JSON.parse(
      [...files].find(([p]) => p.endsWith("src/locales/en.json"))![1],
    ) as Record<string, string>;
    expect(Object.values(catalog)).toContain("Add order");
    expect(Object.values(catalog)).toContain("Order actions");
  });

  it("translates the Alert title named slot (alertTitle) at the attribute position", async () => {
    // The Mantine pack renders the Alert title in ATTRIBUTE position — the
    // `title:` named slot binds through `t()` as ` title={t(key, def)}` under
    // i18n (M-T1.11), keyed to the `alertTitle` catalog slot; the message keeps
    // its own text-slot `t()` call.
    const files = await generateSystemFiles(
      SYSTEM(`Alert { "Disk almost full", title: "Heads up", color: "yellow" }`),
    );
    const home = [...files].find(([p]) => p.endsWith("home.tsx"))![1];
    expect(home).toMatch(/title=\{t\("page\.Home\.alertTitle\.\w+", "Heads up"\)\}/);
    const catalog = JSON.parse(
      [...files].find(([p]) => p.endsWith("src/locales/en.json"))![1],
    ) as Record<string, string>;
    expect(Object.values(catalog)).toContain("Heads up");
  });

  it("translates the Divider label named slot (dividerLabel) at the attribute position", async () => {
    // The Mantine pack renders the Divider label in ATTRIBUTE position
    // (`<Divider label=… />`) — the `label:` named slot binds through `t()` as
    // ` label={t(key, def)}` under i18n (M-T1.11), keyed to the `dividerLabel`
    // catalog slot.
    const files = await generateSystemFiles(SYSTEM(`Divider { label: "Section break" }`));
    const home = [...files].find(([p]) => p.endsWith("home.tsx"))![1];
    expect(home).toMatch(/label=\{t\("page\.Home\.dividerLabel\.\w+", "Section break"\)\}/);
    const catalog = JSON.parse(
      [...files].find(([p]) => p.endsWith("src/locales/en.json"))![1],
    ) as Record<string, string>;
    expect(Object.values(catalog)).toContain("Section break");
  });

  it("translates the Modal title named slot (modalTitle) at the attribute position", async () => {
    // The Mantine pack renders the controlled-Modal title in ATTRIBUTE position
    // (`<Modal … title=… >`) — the `title:` named slot binds through `t()` as
    // ` title={t(key, def)}` under i18n (M-T1.11), keyed to the `modalTitle`
    // catalog slot.  Needs a page `state` bool for the `open:` binding.
    const src = SYSTEM(
      `Modal { Text { "Confirm archive?" }, open: archiveOpen, title: "Archive" }`,
    ).replace(
      'page Home { route: "/"',
      'page Home { route: "/" state { archiveOpen: bool = false }',
    );
    const files = await generateSystemFiles(src);
    const home = [...files].find(([p]) => p.endsWith("home.tsx"))![1];
    expect(home).toMatch(/title=\{t\("page\.Home\.modalTitle\.\w+", "Archive"\)\}/);
    const catalog = JSON.parse(
      [...files].find(([p]) => p.endsWith("src/locales/en.json"))![1],
    ) as Record<string, string>;
    expect(Object.values(catalog)).toContain("Archive");
  });

  it("keeps the Toolbar's DEFAULT accessible name a static attribute", async () => {
    // "Actions" is the a11y contract's fallback — no source literal, so it is not
    // in the catalog and must never bind through `t()` (its key would resolve to
    // nothing).  Byte-identical to the pre-i18n emission.
    const files = await generateSystemFiles(SYSTEM(`Toolbar { Heading { "Orders" } }`));
    expect(await pageOf(files)).toContain(`role="toolbar" aria-label="Actions"`);
  });

  it("renders the translated Divider label on the chakra packs too", async () => {
    // chakra v2/v3 had a `hasLabel` branch identical to the unlabelled one, so the
    // label was extracted into the catalog and rendered NOWHERE — a translator
    // translating a string the app never showed.  Both now split the rule.
    for (const design of ["chakra", `"chakra@v2"`]) {
      const files = await generateSystemFiles(
        SYSTEM(`Divider { label: "Section break" }`).replace(
          "ui: Web port: 3100",
          `ui: Web port: 3100 design: ${design}`,
        ),
      );
      const home = await pageOf(files);
      expect(home, design).toMatch(/t\("page\.Home\.dividerLabel\.\w+", "Section break"\)/);
      expect(home, design).toContain("<HStack");
    }
  });
  // --- the two AUTHORED slots that had no catalog entry (M-T1.11) ----------

  it("translates the Icon accessible name (iconLabel) at the attribute position", async () => {
    // `Icon { label: … }` is how a meaning-bearing glyph opts out of
    // decorative-by-default: the icon becomes a NAMED `role="img"`.  That name
    // was extracted by nothing and shipped in English at every locale; it now
    // binds through the same D-I18N-ATTR fragment `Button`/`Toolbar` use.
    const files = await generateSystemFiles(SYSTEM(`Icon { name: "check", label: "Verified" }`));
    const home = await pageOf(files);
    expect(home).toMatch(/role="img" aria-label=\{t\("page\.Home\.iconLabel\.\w+", "Verified"\)\}/);
    expect(Object.values(catalogOf(files))).toContain("Verified");
  });

  it("keeps a decorative Icon hidden — no name, no catalog entry", async () => {
    // The decorative-by-default arm is byte-identical to pre-i18n: a glyph with
    // no `label:` is `aria-hidden`, and there is nothing to translate.
    const home = await pageOf(
      await generateSystemFiles(SYSTEM(`Stack { Heading { "Orders" }, Icon { name: "check" } }`)),
    );
    expect(home).toContain(`aria-hidden="true"`);
    expect(home).not.toContain("iconLabel");
  });

  it("translates the CodeBlock caption (codeBlockTitle) — but never the code", async () => {
    const files = await generateSystemFiles(
      SYSTEM(`CodeBlock { "let total = 1", language: "typescript", title: "Example" }`),
    );
    const home = await pageOf(files);
    expect(home).toMatch(/t\("page\.Home\.codeBlockTitle\.\w+", "Example"\)/);
    // The SOURCE is code, not prose — translating it would break it.
    expect(home).toContain("let total = 1");
    const catalog = catalogOf(files);
    expect(Object.values(catalog)).toContain("Example");
    expect(Object.values(catalog)).not.toContain("let total = 1");
  });
});
