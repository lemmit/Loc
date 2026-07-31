// Angular translation runtime (M-T1.11) — the React i18n runtime ported to the
// Angular frontend.  A UI with user-visible strings emits `{{ t("<key>",
// "<default>") }}` interpolations for literal text slots (keyed IDENTICALLY to
// the `.loom/messages.en.json` catalog, via the SHARED walker seam), plus a
// generated `src/lib/i18n.ts` shim and `src/lib/locales/en.json`.  The seam's
// `../i18n` import is rewritten to `../../lib/i18n` (pages sit two hops under
// `src/`), and `t` is re-exposed as a component member — Angular resolves
// template interpolations against the instance.  A string-less app is
// byte-identical to pre-i18n.

import { describe, expect, it } from "vitest";
import { collectUiMessages } from "../../../src/generator/_walker/i18n-extract.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
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
    deployable web { platform: angular targets: api ui: Web { Sales: api } port: 3100 }
  }
`;

/** The single routed page's component (there is exactly one). */
function homeOf(files: Map<string, string>): string {
  const entry = [...files].find(([p]) => p.endsWith("src/app/pages/home.component.ts"));
  if (!entry) throw new Error("home.component.ts not emitted");
  return entry[1];
}

describe("Angular i18n runtime", () => {
  it("wraps a literal heading in a t() interpolation keyed to the catalog", async () => {
    const files = await generateSystemFiles(SYSTEM(`Heading { "Welcome" }`));
    const home = homeOf(files);
    // The key MUST equal what the extraction pass produces for this slot.
    const { model } = await parseString(SYSTEM(`Heading { "Welcome" }`), { validate: false });
    const ui = enrichLoomModel(lowerModel(model)).systems[0]!.uis.find((u) => u.name === "Web")!;
    const entry = collectUiMessages(ui).find((m) => m.message === "Welcome")!;
    expect(entry).toBeDefined();
    expect(home).toContain(`{{ t(${JSON.stringify(entry.key)}, "Welcome") }}`);
    // The seam's `../i18n` is rewritten to `../../lib/i18n` (pages are two hops
    // under `src/`), and `t` is lifted to a component member.
    expect(home).toContain(`import { t } from "../../lib/i18n";`);
    expect(home).toContain("protected readonly t = t;");
  });

  it("emits the src/lib/i18n.ts shim and src/lib/locales/en.json catalog", async () => {
    const files = await generateSystemFiles(SYSTEM(`Heading { "Storefront" }`));
    const i18n = [...files].find(([p]) => p.endsWith("src/lib/i18n.ts"))?.[1];
    const locale = [...files].find(([p]) => p.endsWith("src/lib/locales/en.json"))?.[1];
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
    const home = homeOf(files);
    expect(home).toMatch(/\{\{ t\("[^"]*", "Orders"\) \}\}/); // literal heading translated
    // `status` is a page-scope ref — interpolated, never a t() call.
    expect(home).not.toContain('t("page.Home.text');
  });

  it("does not emit the runtime for a string-less app", async () => {
    // A page whose only text is a dynamic ref has no extractable strings.
    const files = await generateSystemFiles(SYSTEM(`Text { status }`));
    expect([...files].some(([p]) => p.endsWith("src/lib/i18n.ts"))).toBe(false);
    expect([...files].some(([p]) => p.endsWith("src/lib/locales/en.json"))).toBe(false);
    const home = homeOf(files);
    expect(home).not.toContain("import { t }");
    expect(home).not.toContain("protected readonly t = t;");
  });

  it("emits an interpolated template as a 3-arg ICU t() call + catalog entry", async () => {
    // A page param so the interpolation hole resolves to a real ref.
    const withParam = SYSTEM("Heading { `Status: {code}` }").replace(
      'page Home { route: "/"',
      'page Home(code: string) { route: "/:code"',
    );
    const files = await generateSystemFiles(withParam);
    const home = homeOf(files);
    // Named-display default + a values object; keyed to the catalog.  Angular
    // `{{ expr }}` form, produced by `angularTarget.renderInterpolation`.
    expect(home).toMatch(/\{\{ t\("[^"]*", "Status: \{code\}", \{ code: code \}\) \}\}/);
    const locale = [...files].find(([p]) => p.endsWith("src/lib/locales/en.json"))?.[1];
    expect(Object.values(JSON.parse(locale!) as Record<string, string>)).toContain(
      "Status: {code}",
    );
  });

  it("emits a formatted hole with ICU skeleton, IntlMessageFormat shim, + the dep", async () => {
    // `{total, number, ::currency/USD}` (i18n slice 1) — the skeleton rides into
    // the catalog + the t() default, `values` carries the RAW money value.
    const withParam = SYSTEM("Heading { `Total: {total, number, ::currency/USD}` }").replace(
      'page Home { route: "/"',
      'page Home(total: money) { route: "/:total"',
    );
    const files = await generateSystemFiles(withParam);
    const home = homeOf(files);
    expect(home).toMatch(
      /\{\{ t\("[^"]*", "Total: \{total, number, ::currency\/USD\}", \{ total: total \}\) \}\}/,
    );
    const locale = [...files].find(([p]) => p.endsWith("src/lib/locales/en.json"))![1];
    expect(Object.values(JSON.parse(locale) as Record<string, string>)).toContain(
      "Total: {total, number, ::currency/USD}",
    );
    const i18n = [...files].find(([p]) => p.endsWith("src/lib/i18n.ts"))![1];
    expect(i18n).toContain('import { IntlMessageFormat } from "intl-messageformat"');
    expect(i18n).toContain("new IntlMessageFormat(message, locale).format(values)");
    const pkg = [...files].find(([p]) => p.endsWith("web/package.json"))![1];
    expect(pkg).toContain("intl-messageformat");
  });

  it("translates named aria-label slots (Button + Toolbar) as Angular attr bindings", async () => {
    const files = await generateSystemFiles(
      SYSTEM(`Toolbar { label: "Order actions", Button { "+", label: "Add order", to: "/new" } }`),
    );
    const home = homeOf(files);
    // Angular binds a plain HTML attribute as `[attr.aria-label]="expr"` (single
    // quotes here because the `t()` call contains double quotes) — NOT
    // `[aria-label]`, which would target a non-existent property (ng build error).
    expect(home).toMatch(/\[attr\.aria-label\]='t\("page\.Home\.buttonAria\.\w+", "Add order"\)'/);
    expect(home).toMatch(
      /role="toolbar" \[attr\.aria-label\]='t\("page\.Home\.toolbarAria\.\w+", "Order actions"\)'/,
    );
  });

  it("translates the Alert title named slot (alertTitle) at the text position", async () => {
    // The Angular-Material pack renders the Alert title in TEXT position — the
    // `title:` named slot emits a `{{ t(key, def) }}` interpolation under i18n
    // (M-T1.11), keyed to the `alertTitle` catalog slot.
    const files = await generateSystemFiles(
      SYSTEM(`Alert { "Disk almost full", title: "Heads up", color: "yellow" }`),
    );
    const home = homeOf(files);
    expect(home).toMatch(/\{\{ t\("page\.Home\.alertTitle\.\w+", "Heads up"\) \}\}/);
    const locale = [...files].find(([p]) => p.endsWith("src/lib/locales/en.json"))![1];
    expect(Object.values(JSON.parse(locale) as Record<string, string>)).toContain("Heads up");
  });
});
