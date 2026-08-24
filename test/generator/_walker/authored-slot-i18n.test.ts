// The three AUTHORED-PROSE slots that shipped in English at every locale:
// an input LABEL, a `Tab` CAPTION, a `Column` HEADER.
//
// Each lived in a module the i18n slot inventory (`i18n-slot-inventory.test.ts`)
// counted as "localizes" because SOMETHING else in the file called an
// `i18n-emit` helper — `inputs.ts` localizes the `Select…` placeholder chrome,
// `layout.ts` the Toolbar's accessible name, `data-grid.ts` the whole grid
// chrome band.  The inventory's regex is per-FILE, so the authored text beside
// that chrome was waved through: a generated page emitted
// `{t("page.Home.text.…","hi")}` two lines above a raw `label="Email address"`.
//
// The fix routes all three through the same `messageKey()` machinery every other
// slot uses, so this file pins the per-SLOT behaviour the file-level regex
// cannot see:
//
//   * every render path resolves the slot through its translation runtime —
//     the four JSX/markup frontends, Feliz's F#, Flutter's Dart, and HEEx's
//     `pgettext` (a separate engine, so a separate assertion);
//   * the key the page emits is the key `messageKey()` derives, so the catalog
//     entry is REACHED (D-I18N-KEY: `<prefix>.<role>.<content-hash>`);
//   * the ANCHORS derived from the same literal — a tab's `value` slug, a
//     column's id / sort field — stay in the SOURCE language, because a
//     per-locale selector would break every page object and deep link.
//
// `user-visible-slot-coverage.test.ts` gates the same three slots across all
// fifteen packs; this file is the per-slot mechanism test behind that matrix.

import { describe, expect, it } from "vitest";
import { messageKey } from "../../../src/generator/_walker/i18n-extract.js";
import { generateSystemFiles } from "../../_helpers/index.js";

/** A page body carrying all three slots at once, so one generation per target
 *  covers all three (the assertions are per-slot regardless). */
const BODY = `Stack {
  Field { "Email address", bind: email },
  Tabs { Tab { "Overview Label", Text { "panel" } } },
  Table { rows: rows, Column { "Job Name Header", o => Text { o } } }
}`;

const STATE = `state { email: string = "" rows: string[] = [] }`;

const jsSystem = (platform: string, pack: string): string => `
  system Shop {
    api ShopApi from Catalog
    subdomain Catalog {
      context Cat {
        aggregate Product { name: string }
        repository Products for Product { }
      }
    }
    storage db { type: postgres }
    resource s { for: Cat, kind: state, use: db }
    ui WebApp {
      ${platform === "feliz" || platform === "flutter" ? `framework: ${platform}` : ""}
      api Shop: ShopApi
      page Home { route: "/" ${STATE} body: ${BODY} }
    }
    deployable api { platform: node contexts: [Cat] dataSources: [s] serves: ShopApi port: 3000 }
    deployable web {
      platform: ${platform} ${pack ? `design: "${pack}"` : ""} targets: api
      ui: WebApp { Shop: api } port: 3005
    }
  }
`;

const heexSystem = (): string => `
  system Shop {
    api ShopApi from Catalog
    subdomain Catalog {
      context Cat {
        aggregate Product { name: string }
        repository Products for Product { }
      }
    }
    storage db { type: postgres }
    resource s { for: Cat, kind: state, use: db }
    ui WebApp {
      api Shop: ShopApi
      page Home { route: "/" ${STATE} body: ${BODY} }
    }
    deployable phoenixApp {
      platform: elixir contexts: [Cat] dataSources: [s] serves: ShopApi
      design: "coreComponents" ui: WebApp { Shop: phoenixApp } port: 4000
    }
  }
`;

/** The emitted page source for a target, with any co-located catalog stripped
 *  (Feliz's `I18n` F# module shares `App.fs` with the views, so leaving it in
 *  would make every key assertion below vacuously true). */
function pageOf(files: Map<string, string>, suffix: string): string {
  const entry = [...files].find(([p]) => p.endsWith(suffix));
  if (!entry) throw new Error(`no page ${suffix} among ${[...files.keys()].join(", ")}`);
  const src = entry[1];
  if (!suffix.endsWith("App.fs")) return src;
  const start = src.indexOf("module I18n =");
  if (start < 0) return src;
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(?:module|let|type|open) /);
  return src.slice(0, start) + (next < 0 ? "" : rest.slice(next));
}

/** The catalog key for one authored string in one slot ROLE — derived through
 *  the SHARED helper, so this asserts "the page emits the key the catalog
 *  carries" rather than re-spelling the key format here. */
const keyFor = (role: string, message: string): string => messageKey("page.Home", role, message);

const SLOTS: ReadonlyArray<[role: string, message: string]> = [
  ["inputLabel", "Email address"],
  ["tabLabel", "Overview Label"],
  ["columnHeader", "Job Name Header"],
];

describe("authored-prose slots reach the translation runtime on every target", () => {
  const TARGETS: ReadonlyArray<[id: string, platform: string, pack: string, page: string]> = [
    ["react", "static", "mantine", "pages/home.tsx"],
    ["vue", "vue", "vuetify", "pages/home.vue"],
    ["svelte", "svelte", "flowbite", "+page.svelte"],
    ["angular", "angular", "angularMaterial", "pages/home.component.ts"],
    ["feliz", "feliz", "", "src/App.fs"],
    ["flutter", "flutter", "", "pages/home_page.dart"],
  ];

  for (const [id, platform, pack, suffix] of TARGETS) {
    it(`${id}: all three slots resolve their catalog key`, async () => {
      const files = await generateSystemFiles(jsSystem(platform, pack));
      const page = pageOf(files, suffix);
      const catalog = JSON.parse(files.get(".loom/messages.en.json") ?? "{}") as Record<
        string,
        string
      >;
      for (const [role, message] of SLOTS) {
        const key = keyFor(role, message);
        expect(catalog[key], `${id}: "${message}" missing from the catalog under ${key}`).toBe(
          message,
        );
        expect(page, `${id}: the ${role} slot never resolves ${key}`).toContain(key);
      }
    });
  }

  it("heex: all three slots resolve their catalog key through pgettext", async () => {
    // A separate engine (`heex-walker-core.ts`), so a separate assertion: HEEx
    // does not consume `walkBody` and localizes through gettext, keyed by the
    // SAME content hash so one catalog serves all seven render paths.
    const files = await generateSystemFiles(heexSystem());
    const page = pageOf(files, "home_live.ex");
    for (const [role, message] of SLOTS) {
      const key = keyFor(role, message);
      expect(page, `heex: the ${role} slot never resolves ${key}`).toContain(`pgettext("${key}"`);
    }
  });
});

describe("the anchors derived from the same literal stay in the source language", () => {
  it("a tab's value slug and a column's id are NOT translated", async () => {
    const files = await generateSystemFiles(jsSystem("static", "mantine"));
    const page = pageOf(files, "pages/home.tsx");
    // The switcher keys on the slug of the SOURCE caption; a translated anchor
    // would break every selector and deep link the moment a locale landed.
    expect(page).toContain('value="overview-label"');
    // …and the caption beside it is the runtime call, not the English text.
    expect(page).toContain(keyFor("tabLabel", "Overview Label"));
  });

  it("heex: the tab slug stays in the source language", async () => {
    const files = await generateSystemFiles(heexSystem());
    const page = pageOf(files, "home_live.ex");
    // The `JS.show(to: "#…-panel-<slug>")` selector is built from the SOURCE
    // caption, so it survives a translation.  Asserted as a PREFIX because the
    // HEEx slug is `snake()`d rather than slugified and keeps the caption's
    // space — a separate (pre-existing) defect this change must not depend on.
    expect(page).toContain('id="tabs-1-panel-overview');
    expect(page).toContain(`pgettext("${keyFor("tabLabel", "Overview Label")}"`);
  });
});

describe("the emitted key is content-derived (D-I18N-KEY)", () => {
  it("a rephrase re-keys; the role is part of the key", async () => {
    const a = keyFor("inputLabel", "Email address");
    const b = keyFor("inputLabel", "E-mail address");
    expect(a).not.toBe(b);
    // Same text in a DIFFERENT slot is a different key — two roles, two
    // messages a translator may need to render differently.
    expect(keyFor("tabLabel", "Email address")).not.toBe(a);
  });

  it("the same label in two inputs on one page is ONE catalog entry", async () => {
    // The seven controlled inputs share the `inputLabel` role deliberately: the
    // same caption in a `Field` and a `Toggle` is the same message, so it is
    // translated once.
    const files = await generateSystemFiles(
      jsSystem("static", "mantine")
        .replace(BODY, `Stack { Field { "Name", bind: email }, Toggle { "Name", bind: flag } }`)
        .replace(STATE, `state { email: string = "" flag: bool = false }`),
    );
    const catalog = JSON.parse(files.get(".loom/messages.en.json") ?? "{}") as Record<
      string,
      string
    >;
    const keys = Object.keys(catalog).filter((k) => k.includes("inputLabel"));
    expect(keys).toEqual([keyFor("inputLabel", "Name")]);
  });
});

describe("a DataGrid column header translates too", () => {
  it("the grid's column definition carries the t() call, not the English", async () => {
    // `Column` is read by BOTH `Table` and `DataGrid`; the grid resolves it in
    // `data-grid.ts`, whose own chrome was already localized — which is exactly
    // why the header gap there was invisible to a per-file check.
    const files = await generateSystemFiles(
      jsSystem("static", "mantine")
        .replace(BODY, `DataGrid { rows: rows, Column { "Job Name Header", o => o.name } }`)
        .replace(STATE, `state { rows: Product[] = [] }`),
    );
    const grid =
      [...files].find(([p]) => /Grid\.tsx$/.test(p))?.[1] ?? pageOf(files, "pages/home.tsx");
    expect(grid).toContain(`header: t("${keyFor("columnHeader", "Job Name Header")}"`);
  });
});

describe("i18n OFF keeps the pre-i18n spelling", () => {
  it("a page with no authored prose emits no runtime and no t() call", async () => {
    // Every slot here is DYNAMIC — no source string, so nothing is extractable,
    // so the app has no i18n runtime at all and each slot keeps the raw path.
    const files = await generateSystemFiles(
      jsSystem("static", "mantine")
        .replace(BODY, `Stack { Field { caption, bind: email } }`)
        .replace(STATE, `state { email: string = "" caption: string = "x" }`),
    );
    const page = pageOf(files, "pages/home.tsx");
    expect(page).not.toContain("t(");
    expect(page).toContain("label={caption}");
  });
});
