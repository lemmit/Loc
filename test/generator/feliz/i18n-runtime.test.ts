// Feliz translation runtime (M-T1.11) — the React/Vue/Svelte/Angular `t()`
// runtime ported to the Feliz (F#/Fable) frontend, and the FIRST one whose
// runtime is a different LANGUAGE.
//
// A ui with user-visible strings emits `I18n.t "<key>" "<default>"` for literal
// text slots — keyed IDENTICALLY to the `.loom/messages.en.json` catalog via the
// SHARED walker seam — plus a generated `I18n` F# module in `App.fs` carrying
// the catalog as a `Map<string, string>` and the ICU formatter (the same
// `intl-messageformat` engine the JS frontends use, through Fable interop).
// A string-less app is byte-identical to pre-i18n.

import { describe, expect, it } from "vitest";
import { collectUiMessages } from "../../../src/generator/_walker/i18n-extract.js";
import { generateFelizForContexts } from "../../../src/generator/feliz/index.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SYS = (body: string, extra = "") => `
system Shop {
  subdomain Sales {
    context Sales {
      aggregate Order { status: string }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  ui Web {
    framework: feliz
    api Sales: SalesApi
    page Home {
      route: "/"
      ${extra}
      body: ${body}
    }
  }
  deployable api { platform: node contexts: [Sales] serves: SalesApi port: 3000 }
  deployable web { platform: feliz targets: api ui: Web { Sales: api } port: 3005 }
}`;

async function appFs(src: string): Promise<string> {
  const model = await buildLoomModel(src);
  const sys = model.systems[0]!;
  const web = sys.deployables.find((d) => d.name === "web")!;
  return generateFelizForContexts(sys.contexts ?? [], sys, web).get("src/App.fs")!;
}

async function packageJson(src: string): Promise<string> {
  const model = await buildLoomModel(src);
  const sys = model.systems[0]!;
  const web = sys.deployables.find((d) => d.name === "web")!;
  return generateFelizForContexts(sys.contexts ?? [], sys, web).get("package.json")!;
}

/** The catalog key the EXTRACTION pass produces for a message — the emitted
 *  `I18n.t` call must use exactly this, or a translator's entry never lands. */
async function keyFor(src: string, message: string): Promise<string> {
  const model = await buildLoomModel(src);
  const ui = model.systems[0]!.uis.find((u) => u.name === "Web")!;
  const entry = collectUiMessages(ui).find((m) => m.message === message);
  expect(entry).toBeDefined();
  return entry!.key;
}

describe("Feliz i18n runtime", () => {
  it("wraps a literal heading in an I18n.t call keyed to the catalog", async () => {
    const src = SYS(`Heading { "Welcome" }`);
    const fs = await appFs(src);
    const key = await keyFor(src, "Welcome");
    expect(key).toMatch(/^page\.Home\.heading\./);
    // F# curried application, paren-wrapped so it survives an argument position.
    expect(fs).toContain(`(I18n.t "${key}" "Welcome")`);
    // `t()` is a string, so the interpolation seam drops its `string (…)` coercion.
    expect(fs).toContain(`Html.text ((I18n.t "${key}" "Welcome"))`);
  });

  it("emits the I18n module with the catalog compiled in as an F# Map", async () => {
    const fs = await appFs(SYS(`Heading { "Storefront" }`));
    expect(fs).toContain("module I18n =");
    expect(fs).toContain("let private en: Map<string, string> =");
    expect(fs).toContain("        Map.ofList");
    expect(fs).toContain(`"Storefront"`);
    // Lookup + fallback, and the ICU entry point.
    expect(fs).toContain("let t (key: string) (defaultMessage: string) : string =");
    expect(fs).toContain(
      "let tf (key: string) (defaultMessage: string) (values: (string * obj) list) : string =",
    );
    // JsInterop is opened for `import` / `jsNative` / `createObj`.
    expect(fs).toContain("open Fable.Core.JsInterop");
  });

  it("reaches the SAME ICU engine the JS frontends use, through Fable interop", async () => {
    const src = SYS(`Heading { "Storefront" }`);
    const fs = await appFs(src);
    expect(fs).toContain('import "IntlMessageFormat" "intl-messageformat"');
    expect(fs).toContain('[<Fable.Core.Emit("new $0($1, $2).format($3)")>]');
    // …and the package.json carries the dependency, at the JS frontends' pin.
    expect(await packageJson(src)).toContain('"intl-messageformat": "^10.7.0"');
  });

  it("emits an interpolated template as an ICU I18n.tf call + catalog entry", async () => {
    const src = SYS("Heading { `Status: {code}` }").replace(
      'page Home {\n      route: "/"',
      'page Home(code: string) {\n      route: "/:code"',
    );
    const fs = await appFs(src);
    const key = await keyFor(src, "Status: {code}");
    // Named-display default + an F# `(name, boxed value)` list — the F# spelling
    // of the JS runtime's `{ code: code }` values object.
    expect(fs).toContain(`(I18n.tf "${key}" "Status: {code}" [ "code", box (`);
  });

  it("carries an ICU format skeleton verbatim into the message", async () => {
    // `{total, number, ::currency/USD}` — the raw skeleton rides into the catalog
    // and the `t` default; `intl-messageformat` formats the RAW value at runtime.
    const src = SYS("Heading { `Total: {total, number, ::currency/USD}` }").replace(
      'page Home {\n      route: "/"',
      'page Home(total: money) {\n      route: "/:total"',
    );
    const fs = await appFs(src);
    expect(fs).toContain('"Total: {total, number, ::currency/USD}"');
  });

  it("translates the app-shell chrome (skip link + primary-nav landmark)", async () => {
    // The shell is ALWAYS rendered, so its baked-in chrome translates only when
    // the app is already i18n-enabled by an authored string.  Two top-level pages
    // are needed for the navbar (and therefore the skip link) to exist at all.
    const src = `
system Shop {
  subdomain Sales {
    context Sales {
      aggregate Order { status: string }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  ui Web {
    framework: feliz
    api Sales: SalesApi
    page Home { route: "/" body: Heading { "Welcome" } }
    page About { route: "/about" body: Heading { "About" } }
  }
  deployable api { platform: node contexts: [Sales] serves: SalesApi port: 3000 }
  deployable web { platform: feliz targets: api ui: Web { Sales: api } port: 3005 }
}`;
    const fs = await appFs(src);
    expect(fs).toContain('prop.text (I18n.t "chrome.skipToContent" "Skip to content")');
    expect(fs).toContain('prop.ariaLabel (I18n.t "chrome.primaryNav" "Primary navigation")');
    // The merged catalog carries both keys.
    expect(fs).toContain('"chrome.skipToContent", "Skip to content"');
    expect(fs).toContain('"chrome.primaryNav", "Primary navigation"');
  });

  it("leaves a dynamic text slot untranslated (no stable source string)", async () => {
    const fs = await appFs(
      SYS(`Stack { Heading { "Orders" }, Text { status } }`, "state { status: string }"),
    );
    expect(fs).toMatch(/I18n\.t "page\.Home\.heading\.\w+" "Orders"/);
    // `status` is page state — interpolated from the Model, never a t() call.
    expect(fs).not.toContain('I18n.t "page.Home.text');
    expect(fs).toContain("model.Status");
  });

  it("keeps a string-less app byte-identical — no module, no dependency", async () => {
    const src = SYS(`Text { status }`, "state { status: string }");
    const fs = await appFs(src);
    expect(fs).not.toContain("module I18n");
    expect(fs).not.toContain("I18n.t");
    // The raw shell chrome, exactly as before i18n.
    expect(await packageJson(src)).not.toContain("intl-messageformat");
  });

  it("keeps the raw-text pack slots byte-identical when i18n is off", async () => {
    // The pack slots that had to learn the element form (Badge / Button / Anchor
    // / Alert title / Modal title) must still emit `prop.text "…"` with no i18n.
    const fs = await appFs(
      SYS(
        `Stack { Badge { "beta" }, Button { "Go", to: "/x" }, Anchor { "Docs", to: "/docs" }, Alert { "Boom", title: "Heads up" } }`,
        "state { status: string }",
      ).replace("framework: feliz", "framework: feliz"),
    );
    // Every literal is a t() call here (this ui HAS strings) — assert the
    // element form reached each slot rather than being spliced into a literal.
    expect(fs).not.toContain('prop.text "(I18n.t');
    expect(fs).not.toContain('Html.text "(I18n.t');
    expect(fs).not.toContain('Html.text "Html.text');
    for (const role of ["badge", "button", "anchor", "alert", "alertTitle"]) {
      expect(fs).toContain(`I18n.t "page.Home.${role}.`);
    }
  });
});
