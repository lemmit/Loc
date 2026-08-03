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

  it("leaves an INTERPOLATED slot on the raw path (documented scope limit)", async () => {
    // gettext interpolates `%{name}`, not ICU `{name}`, and has no
    // plural/select arg-type — so an interpolated template keeps the pre-i18n
    // raw path rather than emitting a message the runtime would mis-render.
    const src = SYSTEM("Heading { `Status: {code}` }").replace(
      'page Home {\n      route: "/"',
      'page Home(code: string) {\n      route: "/:code"',
    );
    const live = await homeLive(src);
    expect(live).not.toContain('pgettext("page.Home.heading');
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
});
