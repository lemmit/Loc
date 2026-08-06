// Phoenix HEEx translation runtime (M-T1.11) — the LAST frontend, and the one
// that diverges most.
//
// The other five reach a generated `t(key, default)` shim.  Elixir has a
// STANDARD answer — `gettext` — so the generated app uses it, and the Loom
// catalog key rides as the gettext CONTEXT while the English rides as the
// `msgid`:
//
//     <%= pgettext("page.Home.heading.<hash>", "Welcome") %>
//
// That carries key parity with the other five frontends AND gettext's own
// "empty translation ⇒ render the msgid" fallback, which is the same
// `messages[key] ?? default` semantics the JS shim has.
//
// No Elixir is compiled here; `elixir-vanilla-build.yml` owns "is the Elixir
// real" (`mix compile --warnings-as-errors`).

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
      aggregate Order with crudish { status: string }
      repository Orders for Order { }
    }
  }
  api SalesApi from S
  storage pg { type: postgres }
  resource st { for: Sales, kind: state, use: pg }
  ui Web {
    framework: phoenixLiveView
    api Sales: SalesApi
    ${decls}
    page Home {
      route: "/"
      ${extra}
      body: ${body}
    }
  }
  deployable app {
    platform: elixir
    contexts: [Sales]
    dataSources: [st]
    serves: SalesApi
    ui: Web { Sales: app }
    port: 4000
  }
}
`;

const fileEndingWith = (files: Map<string, string>, suffix: string): string | undefined =>
  [...files].find(([p]) => p.endsWith(suffix))?.[1];

async function homeLive(src: string): Promise<string> {
  const files = await generateSystemFiles(src);
  const live = fileEndingWith(files, "live/home_live.ex");
  expect(live, `no home_live.ex in: ${[...files.keys()].join(", ")}`).toBeDefined();
  return live!;
}

/** The catalog key the EXTRACTION pass produces — the emitted `pgettext`
 *  CONTEXT must equal it, or a translator's `.po` entry never resolves. */
async function keyFor(src: string, message: string): Promise<string> {
  const { model } = await parseString(src, { validate: false });
  const ui = enrichLoomModel(lowerModel(model)).systems[0]!.uis.find((u) => u.name === "Web")!;
  const entry = collectUiMessages(ui).find((m) => m.message === message);
  expect(entry).toBeDefined();
  return entry!.key;
}

describe("Phoenix HEEx i18n runtime", () => {
  it("wraps a literal heading in pgettext keyed to the catalog", async () => {
    const src = SYSTEM(`Heading { "Welcome" }`);
    const live = await homeLive(src);
    const key = await keyFor(src, "Welcome");
    expect(key).toMatch(/^page\.Home\.heading\./);
    // The Loom key is the gettext CONTEXT; the English is the msgid.  A HEEx
    // text position needs the `<%= … %>` wrapper — it is a function call.
    expect(live).toContain(`<%= pgettext("${key}", "Welcome") %>`);
  });

  it("emits the Gettext backend + the source-language .po/.pot from the catalog", async () => {
    const files = await generateSystemFiles(SYSTEM(`Heading { "Storefront" }`));
    const backend = fileEndingWith(files, "_web/gettext.ex");
    expect(backend).toContain("use Gettext.Backend, otp_app: :");
    const po = fileEndingWith(files, "priv/gettext/en/LC_MESSAGES/default.po");
    const pot = fileEndingWith(files, "priv/gettext/default.pot");
    expect(po).toBeDefined();
    expect(pot).toBeDefined();
    // msgctxt = the Loom key, msgid = the English, msgstr EMPTY so gettext
    // falls back to the msgid (the source-language behaviour).
    expect(po).toMatch(/msgctxt "page\.Home\.heading\.\w+"\nmsgid "Storefront"\nmsgstr ""/);
    expect(pot).toContain('msgid "Storefront"');
  });

  it("wires the dep and the html_helpers import so pgettext resolves in ~H", async () => {
    const files = await generateSystemFiles(SYSTEM(`Heading { "Storefront" }`));
    expect(fileEndingWith(files, "mix.exs")).toContain('{:gettext, "~> 0.26"}');
    // `use Gettext, backend: …` in `html_helpers`, so every LiveView + component
    // template has `pgettext/2` in scope unqualified.  Gettext >= 0.26 SPLIT the
    // backend from the macros: an `import` of the backend module brings in
    // nothing, which `mix compile` reports as `undefined function pgettext/2` at
    // every call site — the real compiler caught exactly that.
    expect(fileEndingWith(files, "_web.ex")).toMatch(/use Gettext, backend: \w+Web\.Gettext/);
  });

  it("translates the app-shell chrome (skip link + primary-nav landmark)", async () => {
    const files = await generateSystemFiles(SYSTEM(`Heading { "Welcome" }`));
    const layout = fileEndingWith(files, "layouts/app.html.heex")!;
    expect(layout).toContain('<%= pgettext("chrome.skipToContent", "Skip to content") %>');
    // Attribute position takes the HEEx `{…}` expression form, not `<%= %>`.
    expect(layout).toContain('aria-label={pgettext("chrome.primaryNav", "Primary navigation")}');
    const po = fileEndingWith(files, "priv/gettext/en/LC_MESSAGES/default.po")!;
    expect(po).toContain('msgctxt "chrome.skipToContent"');
    expect(po).toContain('msgctxt "chrome.primaryNav"');
  });

  it("covers the bespoke slots too (anchor / stat / alert / keyValue)", async () => {
    const src = SYSTEM(
      `Stack { Anchor { "Docs", to: "/docs" }, Stat { "Total", "42" }, Alert { "Boom" }, KeyValueRow { "Status", Text { "ok" } } }`,
    );
    const live = await homeLive(src);
    for (const role of ["anchor", "statLabel", "statValue", "alert", "keyValue"]) {
      expect(live, `role ${role}`).toContain(`<%= pgettext("page.Home.${role}.`);
    }
  });

  it("leaves a dynamic text slot untranslated (no stable source string)", async () => {
    const live = await homeLive(
      SYSTEM(`Stack { Heading { "Orders" }, Text { status } }`, "state { status: string }"),
    );
    expect(live).toMatch(/pgettext\("page\.Home\.heading\.\w+", "Orders"\)/);
    // `status` is an assign — interpolated, never a pgettext call.
    expect(live).not.toContain('pgettext("page.Home.text');
    expect(live).toContain("@status");
  });

  it("translates an INTERPOLATED slot too — the scope limit is gone", async () => {
    // This test used to pin the OPPOSITE: an interpolated slot kept the raw
    // path, because gettext interpolates `%{name}` rather than ICU `{name}`.
    // The message now stays ICU and an ICU engine formats gettext's result
    // (D-I18N-HEEX-ICU), so the hole is translatable like every other frontend's.
    const src = SYSTEM("Heading { `Status: {code}` }").replace(
      'page Home {\n      route: "/"',
      'page Home(code: string) {\n      route: "/:code"',
    );
    const live = await homeLive(src);
    expect(live).toContain('loom_icu(pgettext("page.Home.heading');
  });

  it("does not emit the runtime for a string-less app", async () => {
    const files = await generateSystemFiles(SYSTEM(`Text { status }`, "state { status: string }"));
    expect(fileEndingWith(files, "_web/gettext.ex")).toBeUndefined();
    expect(fileEndingWith(files, "priv/gettext/en/LC_MESSAGES/default.po")).toBeUndefined();
    expect(fileEndingWith(files, "mix.exs")).not.toContain(":gettext");
    expect(fileEndingWith(files, "_web.ex")).not.toContain("Gettext");
    // …and the shell chrome stays the raw English (byte-identical).
    const layout = fileEndingWith(files, "layouts/app.html.heex")!;
    expect(layout).toContain(">Skip to content</a>");
    expect(layout).toContain('aria-label="Primary navigation"');
    expect(layout).not.toContain("pgettext");
  });

  it("threads the prefix into a component body (component.<Name> keys)", async () => {
    const src = SYSTEM(
      `Stack { Banner(), Heading { "Home" } }`,
      "",
      `component Banner() { body: Text { "Shop banner" } }`,
    );
    const files = await generateSystemFiles(src);
    const components = fileEndingWith(files, "components/ui_components.ex")!;
    expect(components).toMatch(/pgettext\("component\.Banner\.text\.\w+", "Shop banner"\)/);
    expect(fileEndingWith(files, "priv/gettext/en/LC_MESSAGES/default.po")).toContain(
      'msgid "Shop banner"',
    );
  });
  // --- ATTRIBUTE position — the seam HEEx was missing entirely --------------
  //
  // HEEx translated every TEXT slot and no ATTRIBUTE one: `renderInTemplate`
  // carried a catalog role, `renderAttrValue` had nowhere to put one.  So a
  // control's accessible name shipped in English at every locale while the
  // visible caption beside it translated.  `localizedHeexAttr` is that missing
  // half — HEEx's `{…}` expression syntax rather than `<%= … %>`, which is
  // exactly why `elixirI18nString` escapes `{`/`}` in the message.

  it("translates a command Button's aria-label (buttonAria)", async () => {
    const src = SYSTEM(`Button { "+", label: "Add order", to: "/new" }`);
    const live = await homeLive(src);
    const key = await keyFor(src, "Add order");
    expect(live).toContain(`aria-label={pgettext("${key}", "Add order")}`);
    expect(live).not.toContain(`aria-label="Add order"`);
  });

  it("translates the Icon accessible name (iconLabel) and keeps role=img", async () => {
    const src = SYSTEM(`Icon { svg: "<svg/>", label: "Verified" }`);
    const live = await homeLive(src);
    const key = await keyFor(src, "Verified");
    expect(live).toContain(`role="img" aria-label={pgettext("${key}", "Verified")}`);
  });

  it("keeps a decorative Icon hidden and byte-identical", async () => {
    const live = await homeLive(SYSTEM(`Stack { Heading { "Orders" }, Icon { svg: "<svg/>" } }`));
    expect(live).toContain(`aria-hidden="true"`);
  });

  it("translates the CodeBlock caption (codeBlockTitle) — but never the code", async () => {
    const src = SYSTEM(`CodeBlock { "let total = 1", language: "elixir", title: "Example" }`);
    const live = await homeLive(src);
    const key = await keyFor(src, "Example");
    expect(live).toContain(
      `<div class="loom-code-block-title"><%= pgettext("${key}", "Example") %></div>`,
    );
    expect(live).toContain("let total = 1");
  });

  it("leaves an UNTITLED CodeBlock string-less — the code is not a slot", async () => {
    const files = await generateSystemFiles(SYSTEM(`CodeBlock { "let total = 1" }`));
    expect(fileEndingWith(files, "_web/gettext.ex")).toBeUndefined();
    expect(fileEndingWith(files, "live/home_live.ex")).toContain("let total = 1");
  });
});
// ---------------------------------------------------------------------------
// ICU INTERPOLATION (D-I18N-HEEX-ICU)
// ---------------------------------------------------------------------------
//
// Phoenix was the one frontend that could not translate a sentence with a hole
// in it.  gettext interpolates `%{name}`, not ICU `{name}`, and has no
// plural/select arg type — so an interpolated slot kept the raw path and
// emitted the very shape the `loom.user-visible-concat` validator BANS in
// `.ddd` source: `<%= "Status: " <> @code %>`.
//
// The message now stays ICU VERBATIM (so the Phoenix `.po` carries the same
// msgid as the other five catalogs) and the two jobs split at their natural
// seam: gettext resolves, `ex_cldr_messages` formats the result.  The engine
// ships behind a SECOND-tier gate — a translatable app with no interpolation
// must keep its pre-slice dep list byte-for-byte.

describe("Phoenix HEEx i18n — ICU interpolation", () => {
  it("emits pgettext INSIDE loom_icu, with the holes as a keyword list", async () => {
    const src = SYSTEM("Text { `Status: {code}` }").replace(
      'page Home {\n      route: "/"',
      'page Home(code: string) {\n      route: "/:code"',
    );
    const live = await homeLive(src);
    const key = await keyFor(src, "Status: {code}");
    // gettext resolves the message; ICU formats what it returned — so the
    // pgettext call is the ARGUMENT, never the other way round.  A locale whose
    // translation reorders the holes still formats correctly.
    expect(live).toContain(`loom_icu(pgettext("${key}", "Status: \\x7Bcode\\x7D"), [code: @code])`);
    // …and the concat the validator bans is gone from the emitted template.
    expect(live).not.toContain('"Status: " <> @code');
  });

  it("keys the ICU message IDENTICALLY to the shared catalog", async () => {
    // The whole reason the message stays ICU: one msgid across six frontends.
    const src = SYSTEM("Text { `Status: {code}` }").replace(
      'page Home {\n      route: "/"',
      'page Home(code: string) {\n      route: "/:code"',
    );
    const files = await generateSystemFiles(src);
    const key = await keyFor(src, "Status: {code}");
    const po = fileEndingWith(files, "priv/gettext/en/LC_MESSAGES/default.po")!;
    expect(po).toContain(`msgctxt "${key}"`);
    expect(po).toContain('msgid "Status: {code}"');
  });

  it("carries an ICU format skeleton verbatim into the msgid", async () => {
    // `::currency/USD` is the spelling Loom's own grammar documents, and the one
    // `ex_cldr_messages` cannot parse — the runtime's documented fallback covers
    // it (see `renderIcuRuntime`).  What matters here is that the CATALOG is
    // unharmed: the skeleton reaches the translator intact.
    const src = SYSTEM("Text { `Total: {total, number, ::currency/USD}` }").replace(
      'page Home {\n      route: "/"',
      'page Home(total: money) {\n      route: "/:total"',
    );
    const files = await generateSystemFiles(src);
    expect(fileEndingWith(files, "priv/gettext/en/LC_MESSAGES/default.po")).toContain(
      'msgid "Total: {total, number, ::currency/USD}"',
    );
  });

  it("ships the ICU engine, backend and template import for an interpolating ui", async () => {
    const src = SYSTEM("Text { `Status: {code}` }").replace(
      'page Home {\n      route: "/"',
      'page Home(code: string) {\n      route: "/:code"',
    );
    const files = await generateSystemFiles(src);
    expect(fileEndingWith(files, "mix.exs")).toContain('{:ex_cldr_messages, "~> 1.0"}');
    const cldr = fileEndingWith(files, "lib/app/cldr.ex");
    expect(cldr).toContain("use Cldr,");
    expect(cldr).toContain("providers: [Cldr.Number, Cldr.Message]");
    // Adding a locale takes TWO steps — the `.po` tree AND this list, because
    // that is what compiles the locale's plural rules in.  Stated in the file,
    // since a `.po` with unusable plural forms is the failure mode.
    expect(cldr).toContain("add `<locale>` to `locales:` below");
    const runtime = fileEndingWith(files, "lib/app_web/i18n.ex");
    expect(runtime).toContain("def loom_icu(message, bindings) when is_binary(message) do");
    // Both failure shapes are absorbed: the library reports a parse/bind error
    // as a tuple but a missing date provider as a raise.
    expect(runtime).toContain("rescue");
    expect(runtime).toContain("defp substitute(message, bindings) do");
    // The helper is imported into every template — hence the distinct name.
    expect(fileEndingWith(files, "lib/app_web.ex")).toContain("import AppWeb.I18n");
  });

  it("does NOT ship the ICU engine for a translatable ui with no interpolation", async () => {
    // The second-tier gate.  A literal-only app is translatable but never
    // formats anything, so it must not pay the CLDR compile — its dep list,
    // its file set and its bytes are exactly what they were before this slice.
    const files = await generateSystemFiles(SYSTEM(`Heading { "Orders" }`));
    expect(fileEndingWith(files, "priv/gettext/en/LC_MESSAGES/default.po")).toBeDefined();
    expect(fileEndingWith(files, "mix.exs")).toContain('{:gettext, "~> 0.26"}');
    expect(fileEndingWith(files, "mix.exs")).not.toContain("ex_cldr");
    expect(fileEndingWith(files, "lib/app/cldr.ex")).toBeUndefined();
    expect(fileEndingWith(files, "lib/app_web/i18n.ex")).toBeUndefined();
    expect(fileEndingWith(files, "lib/app_web.ex")).not.toContain("import AppWeb.I18n");
  });

  it("does not let a hole-carrying CHROME message flip the ICU gate on", async () => {
    // `chrome.pageOf` ("Page {page} of {pages}") and friends are merged into
    // every enabled catalog, and HEEx renders none of them through this path.
    // Gating on a `{`-sniff over the catalog would therefore put the CLDR
    // compile into every translatable app — so the gate reads the extraction
    // pass's own per-entry `icu` marker instead.
    const files = await generateSystemFiles(SYSTEM(`Heading { "Orders" }`));
    const catalog = fileEndingWith(files, "priv/gettext/en/LC_MESSAGES/default.po")!;
    expect(catalog).toMatch(/msgid "[^"]*\{[^"]*"/); // a holed chrome msgid IS present…
    expect(fileEndingWith(files, "mix.exs")).not.toContain("ex_cldr"); // …and gates nothing.
  });
});
