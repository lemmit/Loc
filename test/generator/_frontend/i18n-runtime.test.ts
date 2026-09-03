// ---------------------------------------------------------------------------
// `_frontend/i18n-runtime.ts` — the shared per-app translation runtime
// (`buildUiCatalog` / `renderLocaleCatalog` / `renderI18nModule`).
//
// WHAT IS ALREADY PINNED ELSEWHERE, so this file does not repeat it:
//   * `test/generator/react/i18n-runtime.test.ts` + the Svelte twin — per-slot
//     `t()` emission for one frontend, and that the two files are emitted at
//     all.
//   * `test/generator/pack-chrome-i18n.test.ts` — per-pack chrome BINDING (the
//     404 / skip link / loader aria / pager) on every frontend, and the
//     i18n-off byte-identical raw spelling of each one.
//   * `test/generator/_walker/i18n-dead-key-cross-target.test.ts` — that three
//     NAMED slots (modal trigger, menu section, menu link) render through the
//     key they own, on every target.
//
// WHAT IS NOT, and is the subject here: the GLOBAL agreement between the two
// halves.  Every test above picks a slot, or a pack, or a frontend, and checks
// that one pairing.  `menu-emitter.ts`'s `messageKey("menu", "section", …)`
// comment names the drift class exactly — the shell's `t()` key and the catalog
// entry are computed at two independent sites, and NOTHING asserts that the two
// sets agree as sets.  A key emitted with a namespace the collector never
// writes is a `t()` call that falls back to English forever, at every locale,
// with a green catalog and a green page.
//
// So: build the shell strings and the catalog from ONE model, and intersect.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  buildUiCatalog,
  renderI18nModule,
  renderLocaleCatalog,
} from "../../../src/generator/_frontend/i18n-runtime.js";
import {
  APP_SHELL_CHROME,
  chromeMergedWhenEnabled,
} from "../../../src/generator/_walker/i18n-chrome.js";
import type { UiIR } from "../../../src/ir/types/loom-ir.js";
import { buildLoomModel, generateSystemFiles } from "../../_helpers/index.js";

// --- the fixture ------------------------------------------------------------

const DOMAIN = `
    subdomain S {
      context C {
        aggregate Doc with crudish { name: string }
        repository Docs for Doc { }
      }
    }
    api DemoApi from S`;

/** A ui with BOTH halves of the drift class in play: authored page strings
 *  (which turn i18n on), an explicit `menu { section … }` block (whose labels
 *  are keyed at the menu-emitter site), and a chrome primitive (`Loader`,
 *  keyed used-only through `CHROME_BY_PRIMITIVE`).  The app-shell chrome then
 *  merges in under the already-enabled gate. */
const UI_ON = `
    ui Web {
      api Ops: DemoApi
      menu {
        section "Sales" {
          link Home { label: "All orders" }
          link "Docs" -> "https://example.com/docs"
        }
      }
      page Home {
        route: "/"
        title: "Welcome"
        body: Stack {
          Heading { "All the documents" },
          Loader { },
          Text { "A second sentence to translate" }
        }
      }
    }`;

/** The same ui with nothing translatable: no authored strings, no chrome
 *  primitive, no menu labels.  i18n stays off and the app is runtime-free. */
const UI_OFF = `
    ui Web {
      api Ops: DemoApi
      page Home { route: "/" state { q: string = "" } body: Stack { Text { q } } }
    }`;

const spa = (ui: string, platform = "react", design = "mantine"): string => `
  system Demo {${DOMAIN}
    ${ui}
    storage loomDb { type: postgres }
    resource cState { for: C, kind: state, use: loomDb }
    deployable api { platform: node, contexts: [C], dataSources: [cState], serves: DemoApi, port: 3000 }
    deployable web { platform: ${platform}, targets: api, ui: Web { Ops: api }, design: ${design}, port: 3001 }
  }
`;

/** Every `t("<key>", …)` key the emitted APP SOURCE calls — the catalogs
 *  themselves excluded, since a key "used" because it appears in `en.json` is
 *  precisely the vacuous pass this file exists to prevent. */
function emittedKeys(files: Map<string, string>): Set<string> {
  const keys = new Set<string>();
  for (const [path, content] of files) {
    if (path.startsWith(".loom/") || path.includes("/locales/")) continue;
    if (path.endsWith("/i18n.ts") || path.endsWith("/i18n.tsx")) continue;
    for (const m of content.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(m[1]!);
  }
  return keys;
}

function catalogOf(files: Map<string, string>): Record<string, string> {
  const entry = [...files].find(([p]) => p.endsWith("locales/en.json"));
  if (!entry) throw new Error("no locale catalog emitted");
  return JSON.parse(entry[1]) as Record<string, string>;
}

async function uiOf(source: string): Promise<UiIR> {
  const model = await buildLoomModel(source);
  const ui = model.systems[0]?.uis[0];
  if (!ui) throw new Error("fixture emitted no ui");
  return ui;
}

// --- the pin: the two halves agree as SETS ---------------------------------

describe("i18n key agreement — every emitted t() key exists in the app's own catalog", () => {
  it("react/mantine: shell + page + menu keys are all catalog entries", async () => {
    const files = await generateSystemFiles(spa(UI_ON));
    const catalog = catalogOf(files);
    const used = emittedKeys(files);

    // THE PIN, asserted first so a namespace change at either site fails HERE
    // (a renamed key is still "some key", so the vacuity guards below would
    // also trip — but the agreement is the property, and it should be the
    // assertion that names the failure).
    const missing = [...used].filter((k) => !(k in catalog)).sort();
    expect(
      missing,
      `these t() keys resolve to nothing in locales/en.json — they fall back to ` +
        `English at every locale:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);

    // Guard against a vacuous pass: the fixture must actually exercise all
    // four keying SITES, or the intersection above proves nothing.
    expect([...used].some((k) => k.startsWith("page.Home."))).toBe(true);
    expect([...used].some((k) => k.startsWith("menu.section."))).toBe(true);
    expect([...used].some((k) => k.startsWith("menu.link."))).toBe(true);
    expect([...used].some((k) => k.startsWith("chrome."))).toBe(true);
  });

  it.each([
    "vue",
    "svelte",
    "angular",
  ])("%s: the same set agreement holds (the key is framework-neutral, only the wrapper is not)", async (platform) => {
    const design = { vue: "vuetify", svelte: "flowbite", angular: "angularMaterial" }[platform]!;
    const files = await generateSystemFiles(spa(UI_ON, platform, design));
    const catalog = catalogOf(files);
    const used = emittedKeys(files);
    const missing = [...used].filter((k) => !(k in catalog)).sort();
    expect(missing, `unresolvable t() keys on ${platform}`).toEqual([]);
    expect([...used].some((k) => k.startsWith("menu.section."))).toBe(true);
  });

  it("the app-shell chrome the shell RENDERS is in the catalog with the same English", async () => {
    // The narrower half of the same property, stated in the direction the
    // shell-chrome helpers control: whatever `APP_SHELL_CHROME` English the
    // shell spells, its key AND its default must both match the catalog.
    const files = await generateSystemFiles(spa(UI_ON));
    const catalog = catalogOf(files);
    const app = [...files].find(([p]) => p.endsWith("src/App.tsx"))![1];
    let asserted = 0;
    for (const [key, english] of Object.entries(APP_SHELL_CHROME)) {
      if (!app.includes(`t(${JSON.stringify(key)}`)) continue;
      asserted++;
      expect(catalog[key], `chrome key ${key} is bound by the shell but absent`).toBe(english);
    }
    expect(asserted, "the shell bound no app-shell chrome at all").toBeGreaterThan(0);
  });
});

// --- i18n OFF: the literal text, and no runtime at all ----------------------

describe("i18n off — the raw string, and not one t() call", () => {
  it("emits no catalog, no shim, and no t( call anywhere in the app", async () => {
    const files = await generateSystemFiles(spa(UI_OFF));
    expect([...files].some(([p]) => p.endsWith("locales/en.json"))).toBe(false);
    expect([...files].some(([p]) => p.endsWith("src/i18n.ts"))).toBe(false);
    expect([...emittedKeys(files)]).toEqual([]);
  });

  it("the app-shell chrome renders as its literal English instead", async () => {
    const files = await generateSystemFiles(spa(UI_OFF));
    const app = [...files].find(([p]) => p.endsWith("src/App.tsx"))![1];
    expect(app).toContain(APP_SHELL_CHROME["chrome.skipToContent"]);
    expect(app).not.toContain('t("chrome.');
  });
});

// --- buildUiCatalog / renderLocaleCatalog unit contract ---------------------

describe("buildUiCatalog", () => {
  it("is empty for a UI with nothing authored — chrome never flips i18n on", async () => {
    expect(buildUiCatalog(await uiOf(spa(UI_OFF)))).toEqual({});
  });

  it("merges every already-enabled chrome table once a UI has authored strings", async () => {
    const catalog = buildUiCatalog(await uiOf(spa(UI_ON)));
    for (const [key, english] of Object.entries(chromeMergedWhenEnabled())) {
      expect(catalog[key], `merged chrome key ${key}`).toBe(english);
    }
  });

  it("merges the pack's DECLARED chrome under the same gate, never against it", async () => {
    const packChrome = { "pack.demo.thing.abcd": "Pack thing" };
    expect(buildUiCatalog(await uiOf(spa(UI_OFF)), packChrome)).toEqual({});
    expect(buildUiCatalog(await uiOf(spa(UI_ON)), packChrome)["pack.demo.thing.abcd"]).toBe(
      "Pack thing",
    );
  });

  it("is key-sorted, so the emitted catalog has a stable diff", async () => {
    const keys = Object.keys(buildUiCatalog(await uiOf(spa(UI_ON))));
    expect(keys).toEqual([...keys].sort());
    expect(keys.length).toBeGreaterThan(1);
  });

  it("renderLocaleCatalog is that object as 2-space JSON with a trailing newline", async () => {
    const ui = await uiOf(spa(UI_ON));
    const rendered = renderLocaleCatalog(ui);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(JSON.parse(rendered)).toEqual(buildUiCatalog(ui));
    expect(rendered).toBe(`${JSON.stringify(buildUiCatalog(ui), null, 2)}\n`);
  });
});

// --- renderI18nModule -------------------------------------------------------

describe("renderI18nModule", () => {
  const shim = renderI18nModule();

  it("reads the catalog it is emitted beside", () => {
    expect(shim).toContain('import en from "./locales/en.json"');
    expect(shim).toContain('import { IntlMessageFormat } from "intl-messageformat"');
  });

  it("falls back to the per-call default, so an unresolvable key still renders", () => {
    expect(shim).toContain("messages[key] ?? defaultMessage");
  });

  it("skips the ICU parse entirely for a value-less message", () => {
    expect(shim).toContain("if (values === undefined) return message;");
  });
});
