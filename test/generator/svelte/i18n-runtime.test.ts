// Svelte translation runtime (M-T1.11) — the React i18n runtime ported to the
// Svelte/SvelteKit frontend.  A UI with user-visible strings emits
// `{t("<key>", "<default>")}` for literal text slots (keyed IDENTICALLY to the
// `.loom/messages.en.json` catalog, via the SHARED walker seam), plus a
// generated `src/lib/i18n.ts` shim and `src/lib/locales/en.json`.  The seam's
// `../i18n` import is rewritten to the depth-agnostic `$lib/i18n` specifier.  A
// string-less app is byte-identical to pre-i18n.

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
      page Home { route: "/" state { status: string = "" } body: ${body} }
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
    deployable web { platform: svelte targets: api ui: Web { Sales: api } port: 3100 }
  }
`;

/** The single routed page's `+page.svelte` (there is exactly one). */
async function homeOf(files: Map<string, string>): Promise<string> {
  const entry = [...files].find(([p]) => p.endsWith("+page.svelte"));
  if (!entry) throw new Error("+page.svelte not emitted");
  return entry[1];
}

/** The app-shell component — the chrome group's SvelteKit layout. */
function shellOf(files: Map<string, string>): string {
  const entry = [...files].find(([p]) => p.endsWith("(app)/+layout.svelte"));
  if (!entry) throw new Error("app-shell +layout.svelte not emitted");
  return entry[1];
}

describe("Svelte i18n runtime", () => {
  it("wraps a literal heading in a t() call keyed to the catalog", async () => {
    const files = await generateSystemFiles(SYSTEM(`Heading { "Welcome" }`));
    const home = await homeOf(files);
    // The key MUST equal what the extraction pass produces for this slot.
    const { model } = await parseString(SYSTEM(`Heading { "Welcome" }`), { validate: false });
    const ui = enrichLoomModel(lowerModel(model)).systems[0]!.uis.find((u) => u.name === "Web")!;
    const entry = collectUiMessages(ui).find((m) => m.message === "Welcome")!;
    expect(entry).toBeDefined();
    expect(home).toContain(`{t(${JSON.stringify(entry.key)}, "Welcome")}`);
    // The seam's `../i18n` is rewritten to `$lib/i18n` — resolves at any depth.
    expect(home).toContain(`import { t } from "$lib/i18n"`);
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
    const home = await homeOf(files);
    expect(home).toMatch(/\{t\("[^"]*", "Orders"\)\}/); // literal heading translated
    // `status` is a page-scope ref — interpolated, never a t() call.
    expect(home).not.toContain('t("page.Home.text');
  });

  it("does not emit the runtime for a string-less app", async () => {
    // A page whose only text is a dynamic ref has no extractable strings.
    const files = await generateSystemFiles(SYSTEM(`Text { status }`));
    expect([...files].some(([p]) => p.endsWith("src/lib/i18n.ts"))).toBe(false);
    expect([...files].some(([p]) => p.endsWith("locales/en.json"))).toBe(false);
    const home = await homeOf(files);
    expect(home).not.toContain("import { t }");
  });

  it("translates the app-shell 'Skip to content' chrome under i18n", async () => {
    // The shell is ALWAYS rendered, so its baked-in chrome translates only when
    // the app is already i18n-enabled by an authored string (M-T1.11, pack-chrome).
    const files = await generateSystemFiles(SYSTEM(`Heading { "Welcome" }`));
    const shell = shellOf(files);
    expect(shell).toContain(`{t("chrome.skipToContent", "Skip to content")}`);
    // The primary-navigation landmark aria binds through t() (JSX-shaped attr).
    expect(shell).toContain(`aria-label={t("chrome.primaryNav", "Primary navigation")}`);
    expect(shell).toContain(`import { t } from "$lib/i18n"`);
    // The merged catalog carries the shell chrome key.
    const catalog = JSON.parse(
      [...files].find(([p]) => p.endsWith("src/lib/locales/en.json"))![1],
    ) as Record<string, string>;
    expect(catalog["chrome.skipToContent"]).toBe("Skip to content");
    expect(catalog["chrome.primaryNav"]).toBe("Primary navigation");
    // The mobile nav toggle's aria — "Toggle navigation" on both Svelte packs.
    expect(shell).toContain(`aria-label={t("chrome.toggleNavigation", "Toggle navigation")}`);
    expect(catalog["chrome.toggleNavigation"]).toBe("Toggle navigation");
  });

  it("keeps the app-shell skip link byte-identical (raw, no t import) for a string-less app", async () => {
    // Only a dynamic ref → no extractable strings → i18n off → the shell chrome
    // stays the raw source string and emits NO `t` import (pre-i18n shape).
    const files = await generateSystemFiles(SYSTEM(`Text { status }`));
    const shell = shellOf(files);
    expect(shell).toContain(`>Skip to content</a>`);
    expect(shell).toContain(`aria-label="Toggle navigation"`);
    expect(shell).not.toContain("import { t }");
    expect(shell).not.toContain("chrome.skipToContent");
    // No locale catalog for a string-less app.
    expect([...files].some(([p]) => p.endsWith("locales/en.json"))).toBe(false);
  });

  it("emits an interpolated template as a 3-arg ICU t() call + catalog entry", async () => {
    // A page param so the interpolation hole resolves to a real ref.
    const withParam = SYSTEM("Heading { `Status: {code}` }").replace(
      'page Home { route: "/"',
      'page Home(code: string) { route: "/:code"',
    );
    const files = await generateSystemFiles(withParam);
    const home = await homeOf(files);
    // Named-display default + a values object; keyed to the catalog.  Svelte
    // `{expr}` form, produced by `svelteTarget.renderInterpolation`.
    expect(home).toMatch(/\{t\("[^"]*", "Status: \{code\}", \{ code: code \}\)\}/);
    const locale = [...files].find(([p]) => p.endsWith("src/lib/locales/en.json"))?.[1];
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
    const banner = [...files].find(([p]) => p.endsWith("components/Banner.svelte"))![1];
    expect(banner).toMatch(/\{t\("component\.Banner\.[^"]*", "Shop Banner"\)\}/);
    expect(banner).toContain(`import { t } from "$lib/i18n"`);
    const locale = [...files].find(([p]) => p.endsWith("src/lib/locales/en.json"))?.[1];
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
      /\{t\("[^"]*", "Total: \{total, number, ::currency\/USD\}", \{ total: total \}\)\}/,
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

  it("translates named aria-label slots (Button + Toolbar) as Svelte attr bindings", async () => {
    const files = await generateSystemFiles(
      SYSTEM(`Toolbar { label: "Order actions", Button { "+", label: "Add order", to: "/new" } }`),
    );
    const home = await homeOf(files);
    // Svelte binds an expression attribute as `name={expr}` (same as JSX).
    expect(home).toMatch(/aria-label=\{t\("page\.Home\.buttonAria\.\w+", "Add order"\)\}/);
    expect(home).toMatch(
      /role="toolbar" aria-label=\{t\("page\.Home\.toolbarAria\.\w+", "Order actions"\)\}/,
    );
  });

  it("translates the Alert title named slot (alertTitle) at the text position", async () => {
    // The shadcn-svelte pack renders the Alert title in TEXT-children position —
    // the `title:` named slot emits a `{t(key, def)}` interpolation under i18n
    // (M-T1.11), keyed to the `alertTitle` catalog slot.
    const files = await generateSystemFiles(
      SYSTEM(`Alert { "Disk almost full", title: "Heads up", color: "yellow" }`),
    );
    const home = await homeOf(files);
    expect(home).toMatch(/\{t\("page\.Home\.alertTitle\.\w+", "Heads up"\)\}/);
    const catalog = JSON.parse(
      [...files].find(([p]) => p.endsWith("src/lib/locales/en.json"))![1],
    ) as Record<string, string>;
    expect(Object.values(catalog)).toContain("Heads up");
  });

  it("translates the Divider label named slot (dividerLabel) at the text position", async () => {
    // The shadcn-svelte pack renders the Divider label in TEXT-children position
    // (a `<span>…</span>`) — the `label:` named slot emits a `{t(key, def)}`
    // interpolation under i18n (M-T1.11), keyed to the `dividerLabel` slot.
    const files = await generateSystemFiles(SYSTEM(`Divider { label: "Section break" }`));
    const home = await homeOf(files);
    expect(home).toMatch(/\{t\("page\.Home\.dividerLabel\.\w+", "Section break"\)\}/);
    const catalog = JSON.parse(
      [...files].find(([p]) => p.endsWith("src/lib/locales/en.json"))![1],
    ) as Record<string, string>;
    expect(Object.values(catalog)).toContain("Section break");
  });

  it("translates the Modal title named slot (modalTitle) at the text position", async () => {
    // The shadcn-svelte pack renders the controlled-Modal title in TEXT-children
    // position (an `<h3>…</h3>`) — the `title:` named slot emits a `{t(key, def)}`
    // interpolation under i18n (M-T1.11), keyed to the `modalTitle` slot.  Needs a
    // page `state` bool for the `open:` binding.
    const src = SYSTEM(
      `Modal { Text { "Confirm archive?" }, open: archiveOpen, title: "Archive" }`,
    ).replace(
      'page Home { route: "/"',
      'page Home { route: "/" state { archiveOpen: bool = false }',
    );
    const files = await generateSystemFiles(src);
    const home = await homeOf(files);
    expect(home).toMatch(/\{t\("page\.Home\.modalTitle\.\w+", "Archive"\)\}/);
    const catalog = JSON.parse(
      [...files].find(([p]) => p.endsWith("src/lib/locales/en.json"))![1],
    ) as Record<string, string>;
    expect(Object.values(catalog)).toContain("Archive");
  });

  it("keeps the Toolbar's DEFAULT accessible name a static attribute", async () => {
    // "Actions" is the a11y contract's fallback — no source literal, so it is not
    // in the catalog and must never bind through `t()` (its key would resolve to
    // nothing).  Byte-identical to the pre-i18n emission.
    const files = await generateSystemFiles(SYSTEM(`Toolbar { Heading { "Orders" } }`));
    expect(await homeOf(files)).toContain(`role="toolbar" aria-label="Actions"`);
  });
  it("translates the Icon accessible name (iconLabel) as a bound attribute", async () => {
    const home = await homeOf(
      await generateSystemFiles(SYSTEM(`Icon { name: "check", label: "Verified" }`)),
    );
    expect(home).toMatch(/role="img" aria-label=\{t\("page\.Home\.iconLabel\.\w+", "Verified"\)\}/);
  });

  it("translates the CodeBlock caption (codeBlockTitle) — but never the code", async () => {
    const home = await homeOf(
      await generateSystemFiles(
        SYSTEM(`CodeBlock { "let total = 1", language: "typescript", title: "Example" }`),
      ),
    );
    expect(home).toMatch(/t\("page\.Home\.codeBlockTitle\.\w+", "Example"\)/);
    expect(home).toContain("let total = 1");
  });
});
