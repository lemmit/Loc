// Vue translation runtime (M-T1.11) — the React i18n runtime ported to the Vue
// frontend.  A UI with user-visible strings emits `{{ t("<key>", "<default>") }}`
// for literal text slots (keyed IDENTICALLY to the `.loom/messages.en.json`
// catalog, via the SHARED walker seam), plus a generated `src/i18n.ts` shim and
// `src/locales/en.json`.  A string-less app is byte-identical to pre-i18n.

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
    deployable web { platform: vue targets: api ui: Web { Sales: api } port: 3100 }
  }
`;

async function homeOf(files: Map<string, string>): Promise<string> {
  const entry = [...files].find(([p]) => p.endsWith("home.vue"));
  if (!entry) throw new Error("home.vue not emitted");
  return entry[1];
}

describe("Vue i18n runtime", () => {
  it("wraps a literal heading in a t() call keyed to the catalog", async () => {
    const files = await generateSystemFiles(SYSTEM(`Heading { "Welcome" }`));
    const home = await homeOf(files);
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
    const home = await homeOf(files);
    expect(home).toMatch(/\{\{ t\("[^"]*", "Orders"\) \}\}/); // literal heading translated
    // `status` is a page param ref — interpolated, never a t() call.
    expect(home).not.toContain('t("page.Home.text');
  });

  it("does not emit the runtime for a string-less app", async () => {
    // A page whose only text is a dynamic ref has no extractable strings.
    const files = await generateSystemFiles(SYSTEM(`Text { status }`));
    expect([...files].some(([p]) => p.endsWith("src/i18n.ts"))).toBe(false);
    expect([...files].some(([p]) => p.endsWith("locales/en.json"))).toBe(false);
    const home = await homeOf(files);
    expect(home).not.toContain("import { t }");
  });

  it("emits an interpolated template as a 3-arg ICU t() call + catalog entry", async () => {
    // A page param so the interpolation hole resolves to a real ref.
    const withParam = SYSTEM("Heading { `Status: {code}` }").replace(
      'page Home { route: "/"',
      'page Home(code: string) { route: "/:code"',
    );
    const files = await generateSystemFiles(withParam);
    const home = [...files].find(([p]) => p.endsWith("home.vue"))![1];
    // Named-display default + a values object; keyed to the catalog.  Vue mustache
    // form (`{{ t(...) }}`), produced by `vueTarget.renderInterpolation`.
    expect(home).toMatch(/\{\{ t\("[^"]*", "Status: \{code\}", \{ code: code \}\) \}\}/);
    const locale = [...files].find(([p]) => p.endsWith("src/locales/en.json"))?.[1];
    expect(Object.values(JSON.parse(locale!) as Record<string, string>)).toContain(
      "Status: {code}",
    );
  });

  it("threads the prefix into a component body (component.<Name> keys)", async () => {
    const withComponent = SYSTEM("Banner()").replace(
      "page Home",
      'component Banner() { body: Heading { "Shop Banner" } }\n      page Home',
    );
    const files = await generateSystemFiles(withComponent);
    const banner = [...files].find(([p]) => p.endsWith("components/Banner.vue"))![1];
    expect(banner).toMatch(/\{\{ t\("component\.Banner\.[^"]*", "Shop Banner"\) \}\}/);
    expect(banner).toContain(`import { t } from "../i18n"`);
    const locale = [...files].find(([p]) => p.endsWith("src/locales/en.json"))?.[1];
    expect(Object.values(JSON.parse(locale!) as Record<string, string>)).toContain("Shop Banner");
  });

  it("emits a formatted hole with ICU skeleton, IntlMessageFormat shim, + the dep", async () => {
    // `{total, number, ::currency/USD}` (i18n slice 1) — the skeleton rides into
    // the catalog + the t() default, `values` carries the RAW money value.
    const withParam = SYSTEM("Heading { `Total: {total, number, ::currency/USD}` }").replace(
      'page Home { route: "/"',
      'page Home(total: money) { route: "/:total"',
    );
    const files = await generateSystemFiles(withParam);
    const home = await homeOf(files);
    expect(home).toMatch(
      /\{\{ t\("[^"]*", "Total: \{total, number, ::currency\/USD\}", \{ total: total \}\) \}\}/,
    );
    const locale = [...files].find(([p]) => p.endsWith("src/locales/en.json"))![1];
    expect(Object.values(JSON.parse(locale) as Record<string, string>)).toContain(
      "Total: {total, number, ::currency/USD}",
    );
    const i18n = [...files].find(([p]) => p.endsWith("src/i18n.ts"))![1];
    expect(i18n).toContain('import { IntlMessageFormat } from "intl-messageformat"');
    expect(i18n).toContain("new IntlMessageFormat(message, locale).format(values)");
    const pkg = [...files].find(([p]) => p.endsWith("web/package.json"))![1];
    expect(pkg).toContain("intl-messageformat");
  });

  it("translates named aria-label slots (Button + Toolbar) as Vue attr bindings", async () => {
    const files = await generateSystemFiles(
      SYSTEM(`Toolbar { label: "Order actions", Button { "+", label: "Add order", to: "/new" } }`),
    );
    const home = await homeOf(files);
    // Vue binds an expression attribute as `:name="expr"` (single-quoted here
    // because the `t()` call contains double quotes).
    expect(home).toMatch(/:aria-label='t\("page\.Home\.buttonAria\.\w+", "Add order"\)'/);
    expect(home).toMatch(
      /role="toolbar" :aria-label='t\("page\.Home\.toolbarAria\.\w+", "Order actions"\)'/,
    );
  });

  it("translates the Alert title named slot (alertTitle) as a Vue attr binding", async () => {
    // The Vuetify pack renders the Alert title in ATTRIBUTE position — the
    // `title:` named slot binds through `t()` as ` :title="t(key, def)"` under
    // i18n (single-quoted here because the `t()` call contains double quotes),
    // keyed to the `alertTitle` catalog slot.
    const files = await generateSystemFiles(
      SYSTEM(`Alert { "Disk almost full", title: "Heads up", color: "yellow" }`),
    );
    const home = await homeOf(files);
    expect(home).toMatch(/:title='t\("page\.Home\.alertTitle\.\w+", "Heads up"\)'/);
    const catalog = JSON.parse(
      [...files].find(([p]) => p.endsWith("src/locales/en.json"))![1],
    ) as Record<string, string>;
    expect(Object.values(catalog)).toContain("Heads up");
  });

  it("translates the Divider label named slot (dividerLabel) at the text position", async () => {
    // The Vuetify pack renders the Divider label in TEXT-children position
    // (`<v-divider>…</v-divider>`) — the `label:` named slot emits a
    // `{{ t(key, def) }}` interpolation under i18n (M-T1.11), keyed to the
    // `dividerLabel` catalog slot.
    const files = await generateSystemFiles(SYSTEM(`Divider { label: "Section break" }`));
    const home = await homeOf(files);
    expect(home).toMatch(/\{\{ t\("page\.Home\.dividerLabel\.\w+", "Section break"\) \}\}/);
    const catalog = JSON.parse(
      [...files].find(([p]) => p.endsWith("src/locales/en.json"))![1],
    ) as Record<string, string>;
    expect(Object.values(catalog)).toContain("Section break");
  });

  it("translates the Modal title named slot (modalTitle) as a Vue attr binding", async () => {
    // The Vuetify pack renders the controlled-Modal title in ATTRIBUTE position
    // (`<v-card title=… >`) — the `title:` named slot binds through `t()` as
    // ` :title="t(key, def)"` (single-quoted, the `t()` call contains double
    // quotes) under i18n (M-T1.11), keyed to the `modalTitle` catalog slot.
    const src = SYSTEM(
      `Modal { Text { "Confirm archive?" }, open: archiveOpen, title: "Archive" }`,
    ).replace(
      'page Home { route: "/"',
      'page Home { route: "/" state { archiveOpen: bool = false }',
    );
    const files = await generateSystemFiles(src);
    const home = await homeOf(files);
    expect(home).toMatch(/:title='t\("page\.Home\.modalTitle\.\w+", "Archive"\)'/);
    const catalog = JSON.parse(
      [...files].find(([p]) => p.endsWith("src/locales/en.json"))![1],
    ) as Record<string, string>;
    expect(Object.values(catalog)).toContain("Archive");
  });
});
