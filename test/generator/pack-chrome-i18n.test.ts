// Pack-chrome i18n (M-T1.11, "pack-chrome catalogs") — the design packs bake
// user-visible strings into their `.hbs` templates (a spinner's
// `aria-label="Loading"`), which the content-hash extraction pass never sees.
// The `localizedChromeAria` seam + the shared `chrome.<name>` catalog
// (`i18n-chrome.ts`) make them translatable: under i18n a pack-chrome string
// binds through `t("chrome.loading", "Loading")` keyed to the merged catalog,
// and stays byte-identical raw text when the app opts out.
//
// The loader `aria-label="Loading"` is the first chrome string wired.  It lives
// in the shadcn-family packs (shadcn / shadcnVue / shadcnSvelte / spartanNg), so
// these tests pin one pack per frontend to exercise every attribute-binding
// form (React `{…}`, Vue `:x="…"`, Svelte `{…}`, Angular `[attr.x]="…"`).
//
// The `DataGrid` pager block at the bottom is the harder case: its markup is
// rendered into a HOISTED CHILD component, which on three of the four frontends
// is a different FILE from the page — so the `t` those bindings resolve against
// has to be wired into that file, not the page's import block.

import { describe, expect, it } from "vitest";
import { loadPack, resolvePackDir } from "../../src/generator/_packs/loader-fs.js";
import {
  APP_SHELL_CHROME,
  CHROME_MESSAGES,
  chromeKey,
} from "../../src/generator/_walker/i18n-chrome.js";
import {
  localizedChromeIcuExpr,
  localizedChromeIcuText,
  localizedChromeIcuValue,
} from "../../src/generator/_walker/i18n-emit.js";
import type { WalkContext } from "../../src/generator/_walker/walker-core.js";
import { angularTarget } from "../../src/generator/angular/walker/angular-target.js";
import { felizTarget } from "../../src/generator/feliz/feliz-target.js";
import { flutterTarget } from "../../src/generator/flutter/flutter-target.js";
import { tsxTarget } from "../../src/generator/react/walker/tsx-target.js";
import { svelteTarget } from "../../src/generator/svelte/walker/svelte-target.js";
import { vueTarget } from "../../src/generator/vue/walker/vue-target.js";
import { generateSystemFiles } from "../_helpers/index.js";

/** A one-page system on `<platform>`/`<design>` whose body is `<body>`.
 *  An empty `design` omits the clause entirely — Feliz hosts its own framework
 *  and has no `.hbs` pack, so `design:` doesn't apply to it. */
const SYSTEM = (platform: string, design: string, body: string) => `
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
    deployable web { platform: ${platform} targets: api ui: Web { Sales: api }${design === "" ? "" : ` design: ${design}`} port: 3100 }
  }
`;

/** The single routed page's source, whatever the frontend calls it. */
function pageOf(files: Map<string, string>, ...suffixes: string[]): string {
  for (const [p, c] of files) if (suffixes.some((s) => p.endsWith(s))) return c;
  throw new Error(`no page emitted (looked for ${suffixes.join(", ")})`);
}

function catalogOf(files: Map<string, string>): Record<string, string> {
  const entry = [...files].find(([p]) => p.endsWith("locales/en.json"));
  if (!entry) throw new Error("no locale catalog emitted");
  return JSON.parse(entry[1]) as Record<string, string>;
}

/** App.tsx (the React shell) — where the shell chrome lives. */
function appOf(files: Map<string, string>): string {
  const entry = [...files].find(([p]) => p.endsWith("src/App.tsx"));
  if (!entry) throw new Error("no App.tsx emitted");
  return entry[1];
}

/** The app-shell source for a non-React frontend (`src/App.vue`,
 *  `(app)/+layout.svelte`, …) — the shell-chrome render site. */
function shellOf(files: Map<string, string>, suffix: string): string {
  const entry = [...files].find(([p]) => p.endsWith(suffix));
  if (!entry) throw new Error(`no app shell emitted (looked for ${suffix})`);
  return entry[1];
}

// EVERY shell-rendering pack on EVERY frontend, not just each frontend's
// default.  The skip-link slice wired 13 packs and missed shadcn v3/v4 — they
// rendered `{{{notFoundText}}}` and `{{{primaryNavAria}}}` but kept the skip
// link as raw text, so the string sat in the catalog, got translated, and did
// nothing on those two packs.  It survived four merged slices because every
// other assertion in this file pins ONE pack per frontend, which makes a
// template that forgets a token structurally invisible.
//
// One assertion covers all four frameworks because the emitted `t(key, default)`
// call is IDENTICAL everywhere — only the wrapper around it is framework-shaped
// (React/Svelte `{…}`, Vue `{{ … }}` / `:attr='…'`, Angular `[attr.x]='…'`).
// So this gate needs no per-framework binding table and cannot drift from one.
const SHELL_PACKS: ReadonlyArray<[platform: string, design: string, shell: string]> = [
  ["react", "mantine", "src/App.tsx"],
  ["react", "shadcn", "src/App.tsx"],
  ["react", "mui", "src/App.tsx"],
  ["react", "chakra", "src/App.tsx"],
  ["vue", "vuetify", "src/App.vue"],
  ["vue", "shadcnVue", "src/App.vue"],
  ["svelte", "flowbite", "(app)/+layout.svelte"],
  ["svelte", "shadcnSvelte", "(app)/+layout.svelte"],
  ["angular", "angularMaterial", "src/app/app.component.ts"],
  ["angular", "primeng", "src/app/app.component.ts"],
  ["angular", "spartanNg", "src/app/app.component.ts"],
];

describe("pack-chrome i18n — app-shell chrome, every pack on every frontend", () => {
  it.each(
    SHELL_PACKS,
  )("%s/%s renders every shell-chrome token (no raw string left behind)", async (platform, design, shell) => {
    const files = await generateSystemFiles(SYSTEM(platform, design, `Heading { "Welcome" }`));
    const on = shellOf(files, shell);
    for (const [key, english] of Object.entries(APP_SHELL_CHROME)) {
      // A pack need not SPELL every chrome string — mui renders no nav
      // landmark label, only chakra says "Open menu", the Angular packs carry
      // neither error boundary nor burger.  But whatever it DOES spell must be
      // bound, never raw.  So the invariant is "not raw", not "present": if
      // the English appears at all, it appears inside a t() call for its key.
      if (!on.includes(english)) continue;
      expect(on, `${platform}/${design} left "${english}" unbound`).toContain(
        `t(${JSON.stringify(key)}, ${JSON.stringify(english)})`,
      );
    }
  });
});

describe("pack-chrome i18n — React app-shell chrome", () => {
  it("binds the 404 + skip-link text through t() and imports t into App.tsx", async () => {
    const files = await generateSystemFiles(SYSTEM("react", "mantine", `Heading { "Welcome" }`));
    const app = appOf(files);
    expect(app).toContain(`import { t } from "./i18n"`);
    expect(app).toContain(`{t("chrome.notFound", "Not found")}`);
    expect(app).toContain(`{t("chrome.skipToContent", "Skip to content")}`);
    // Primary-navigation landmark aria binds through t() too (attribute form).
    expect(app).toContain(`aria-label={t("chrome.primaryNav", "Primary navigation")}`);
    const catalog = catalogOf(files);
    expect(catalog["chrome.notFound"]).toBe("Not found");
    expect(catalog["chrome.skipToContent"]).toBe("Skip to content");
    expect(catalog["chrome.primaryNav"]).toBe("Primary navigation");
  });

  it("stays byte-identical (raw shell text, no t import) for a string-less app", async () => {
    const files = await generateSystemFiles(SYSTEM("react", "mantine", `Text { status }`));
    const app = appOf(files);
    expect(app).toContain(">Not found<");
    expect(app).toContain(">Skip to content<");
    expect(app).toContain(`aria-label="Primary navigation"`);
    expect(app).not.toContain("import { t }");
    expect([...files].some(([p]) => p.endsWith("locales/en.json"))).toBe(false);
  });
});

// The remaining shell chrome is NON-uniform: coverage and attribute position
// both vary per pack.  "Something went wrong" is a `title=` prop on mantine's
// `<Alert>` / vuetify's `<v-alert>` but a TEXT child of shadcn's `<AlertTitle>`;
// the mobile nav toggle is spelled "Open menu" by chakra and "Toggle
// navigation" by the shadcn/flowbite family — two keys, because collapsing them
// onto one canonical English would re-word a pack and break byte-identical.
describe("pack-chrome i18n — error-boundary heading", () => {
  it("React (mantine): binds the `title=` ATTRIBUTE through t()", async () => {
    const files = await generateSystemFiles(SYSTEM("react", "mantine", `Heading { "Welcome" }`));
    expect(appOf(files)).toContain(
      `<Alert color="red" title={t("chrome.somethingWentWrong", "Something went wrong")}>`,
    );
    expect(catalogOf(files)["chrome.somethingWentWrong"]).toBe("Something went wrong");
  });

  it("React (shadcn): binds the TEXT position through t()", async () => {
    const files = await generateSystemFiles(SYSTEM("react", "shadcn", `Heading { "Welcome" }`));
    expect(appOf(files)).toContain(
      `<AlertTitle>{t("chrome.somethingWentWrong", "Something went wrong")}</AlertTitle>`,
    );
    expect(catalogOf(files)["chrome.somethingWentWrong"]).toBe("Something went wrong");
  });

  it("Vue (vuetify): binds the `title=` ATTRIBUTE as :title='t(…)'", async () => {
    const files = await generateSystemFiles(SYSTEM("vue", "vuetify", `Heading { "Welcome" }`));
    expect(shellOf(files, "src/App.vue")).toContain(
      `<v-alert type="error" :title='t("chrome.somethingWentWrong", "Something went wrong")' :text="appError.message" />`,
    );
    expect(catalogOf(files)["chrome.somethingWentWrong"]).toBe("Something went wrong");
  });

  it("Vue (shadcnVue): binds the TEXT position as {{ t(…) }}", async () => {
    const files = await generateSystemFiles(SYSTEM("vue", "shadcnVue", `Heading { "Welcome" }`));
    expect(shellOf(files, "src/App.vue")).toContain(
      `<AlertTitle>{{ t("chrome.somethingWentWrong", "Something went wrong") }}</AlertTitle>`,
    );
    expect(catalogOf(files)["chrome.somethingWentWrong"]).toBe("Something went wrong");
  });

  it("stays byte-identical (raw heading, both positions) with i18n off", async () => {
    const mantine = await generateSystemFiles(SYSTEM("react", "mantine", `Text { status }`));
    expect(appOf(mantine)).toContain(`<Alert color="red" title="Something went wrong">`);
    const shadcn = await generateSystemFiles(SYSTEM("react", "shadcn", `Text { status }`));
    expect(appOf(shadcn)).toContain(`<AlertTitle>Something went wrong</AlertTitle>`);
    const vuetify = await generateSystemFiles(SYSTEM("vue", "vuetify", `Text { status }`));
    expect(shellOf(vuetify, "src/App.vue")).toContain(
      `<v-alert type="error" title="Something went wrong" :text="appError.message" />`,
    );
    const shadcnVue = await generateSystemFiles(SYSTEM("vue", "shadcnVue", `Text { status }`));
    expect(shellOf(shadcnVue, "src/App.vue")).toContain(
      `<AlertTitle>Something went wrong</AlertTitle>`,
    );
  });
});

describe("pack-chrome i18n — nav-toggle aria", () => {
  it("React (chakra): binds `Open menu` — its own key, not the shadcn wording", async () => {
    const files = await generateSystemFiles(SYSTEM("react", "chakra", `Heading { "Welcome" }`));
    const app = appOf(files);
    expect(app).toContain(`aria-label={t("chrome.openMenu", "Open menu")}`);
    expect(app).not.toContain("Toggle navigation");
    expect(catalogOf(files)["chrome.openMenu"]).toBe("Open menu");
  });

  it("React (shadcn): binds `Toggle navigation`", async () => {
    const files = await generateSystemFiles(SYSTEM("react", "shadcn", `Heading { "Welcome" }`));
    expect(appOf(files)).toContain(
      `aria-label={t("chrome.toggleNavigation", "Toggle navigation")}`,
    );
    expect(catalogOf(files)["chrome.toggleNavigation"]).toBe("Toggle navigation");
  });

  it("Vue (shadcnVue): binds as :aria-label='t(…)'", async () => {
    const files = await generateSystemFiles(SYSTEM("vue", "shadcnVue", `Heading { "Welcome" }`));
    expect(shellOf(files, "src/App.vue")).toContain(
      `data-testid="nav-burger" :aria-label='t("chrome.toggleNavigation", "Toggle navigation")'`,
    );
    expect(catalogOf(files)["chrome.toggleNavigation"]).toBe("Toggle navigation");
  });

  it("Svelte (shadcnSvelte): binds as aria-label={t(…)}", async () => {
    const files = await generateSystemFiles(
      SYSTEM("svelte", "shadcnSvelte", `Heading { "Welcome" }`),
    );
    expect(shellOf(files, "(app)/+layout.svelte")).toContain(
      `aria-label={t("chrome.toggleNavigation", "Toggle navigation")}`,
    );
    expect(catalogOf(files)["chrome.toggleNavigation"]).toBe("Toggle navigation");
  });

  it("stays byte-identical (raw aria, both wordings) with i18n off", async () => {
    const chakra = await generateSystemFiles(SYSTEM("react", "chakra", `Text { status }`));
    expect(appOf(chakra)).toContain(`aria-label="Open menu"`);
    const shadcn = await generateSystemFiles(SYSTEM("react", "shadcn", `Text { status }`));
    expect(appOf(shadcn)).toContain(`aria-label="Toggle navigation"`);
    const shadcnVue = await generateSystemFiles(SYSTEM("vue", "shadcnVue", `Text { status }`));
    expect(shellOf(shadcnVue, "src/App.vue")).toContain(
      `data-testid="nav-burger" aria-label="Toggle navigation"`,
    );
    const shadcnSvelte = await generateSystemFiles(
      SYSTEM("svelte", "shadcnSvelte", `Text { status }`),
    );
    expect(shellOf(shadcnSvelte, "(app)/+layout.svelte")).toContain(
      `aria-label="Toggle navigation"`,
    );
  });
});

describe("pack-chrome i18n — loader aria-label", () => {
  it("React (shadcn): binds the spinner aria through t() keyed to chrome.loading", async () => {
    const files = await generateSystemFiles(
      SYSTEM("react", "shadcn", `Stack { Heading { "Welcome" }, Loader() }`),
    );
    const page = pageOf(files, "home.tsx");
    expect(page).toContain(`role="status" aria-label={t("chrome.loading", "Loading")}`);
    expect(catalogOf(files)["chrome.loading"]).toBe("Loading");
  });

  it("Vue (shadcnVue): binds aria as :aria-label='t(…)'", async () => {
    const files = await generateSystemFiles(
      SYSTEM("vue", "shadcnVue", `Stack { Heading { "Welcome" }, Loader() }`),
    );
    const page = pageOf(files, "home.vue");
    expect(page).toContain(`role="status" :aria-label='t("chrome.loading", "Loading")'`);
    expect(catalogOf(files)["chrome.loading"]).toBe("Loading");
  });

  it("Svelte (shadcnSvelte): binds aria as aria-label={t(…)}", async () => {
    const files = await generateSystemFiles(
      SYSTEM("svelte", "shadcnSvelte", `Stack { Heading { "Welcome" }, Loader() }`),
    );
    const page = pageOf(files, "(app)/+page.svelte", "+page.svelte");
    expect(page).toContain(`role="status" aria-label={t("chrome.loading", "Loading")}`);
    expect(catalogOf(files)["chrome.loading"]).toBe("Loading");
  });

  it("Angular (spartanNg): binds aria as [attr.aria-label]='t(…)' with t lifted onto the component", async () => {
    const files = await generateSystemFiles(
      SYSTEM("angular", "spartanNg", `Stack { Heading { "Welcome" }, Loader() }`),
    );
    const page = pageOf(files, "home.component.ts");
    expect(page).toContain(`role="status" [attr.aria-label]='t("chrome.loading", "Loading")'`);
    // Angular resolves template refs against the instance — `t` must be a member.
    expect(page).toContain("protected readonly t = t;");
    expect(catalogOf(files)["chrome.loading"]).toBe("Loading");
  });

  it("a chrome primitive alone turns i18n on (used-only chrome is translatable)", async () => {
    // `Loader()` renders pack chrome, so even with no AUTHORED string the page is
    // translatable: the extractor yields `chrome.loading`, the runtime ships, and
    // the spinner aria binds through t().  Chrome + emission stay in lockstep.
    const files = await generateSystemFiles(
      SYSTEM("react", "shadcn", `Stack { Text { status }, Loader() }`),
    );
    const page = pageOf(files, "home.tsx");
    expect(page).toContain(`aria-label={t("chrome.loading", "Loading")}`);
    expect(catalogOf(files)["chrome.loading"]).toBe("Loading");
  });

  it("stays byte-identical (no runtime) for a page with neither strings nor chrome", async () => {
    // No authored literal and no chrome-bearing primitive → nothing to extract →
    // no runtime, no t import.  The pre-i18n output is unchanged.
    const files = await generateSystemFiles(SYSTEM("react", "shadcn", `Text { status }`));
    const page = pageOf(files, "home.tsx");
    expect(page).not.toContain("import { t }");
    expect([...files].some(([p]) => p.endsWith("locales/en.json"))).toBe(false);
  });

  it("every chrome key it DOES carry holds the canonical English", async () => {
    // Chrome is used-only, so the catalog carries a SUBSET of the vocabulary
    // (this page has a `Loader()` but no grid, hence no `chrome.previous`).
    // What must hold for every key present is that its value is the canonical
    // source-language text — the same string the emitted `t(key, default)`
    // carries, or a locale-less app would render one thing and the catalog
    // would document another.
    const files = await generateSystemFiles(
      SYSTEM("react", "shadcn", `Stack { Heading { "Welcome" }, Loader() }`),
    );
    const catalog = catalogOf(files);
    const chromeKeys = Object.keys(catalog).filter((k) => k.startsWith("chrome."));
    expect(chromeKeys.length).toBeGreaterThan(0);
    for (const key of chromeKeys) {
      // Shell chrome (`APP_SHELL_CHROME`) is always merged and lives in its own
      // table; primitive chrome comes from `CHROME_MESSAGES`.
      expect(CHROME_MESSAGES[key] ?? APP_SHELL_CHROME[key]).toBe(catalog[key]);
    }
    // The GRID's own chrome is not here — nothing on this page renders one, and
    // "Previous" is contributed off the `DataGrid` call node.  "Next" and the
    // counter ARE here even so: they are shared with `Table`'s pager, whose
    // condition is not call-node-readable and therefore rides the
    // merged-when-already-enabled gate (`TABLE_PAGER_CHROME`).  That is the
    // documented cost of that gate — an over-merged key a translator translates
    // once and this app never shows — taken deliberately over the alternative,
    // a binding no locale could reach.
    expect(catalog["chrome.previous"]).toBeUndefined();
    expect(catalog["chrome.filter"]).toBeUndefined();
    expect(catalog["chrome.next"]).toBe("Next");
  });
});

// ---------------------------------------------------------------------------
// DataGrid pager chrome — the hoisted-child case
// ---------------------------------------------------------------------------
//
// Unlike the app shell (rendered inline in the page/App component) and the
// `Loader()` aria (rendered into the page body), the grid's pack markup is
// rendered into a HOISTED CHILD component.  On React that child is a module
// decl in the page's OWN file, so the page's `t` import already reaches it; on
// Vue and Svelte it is a separate sibling FILE and on Angular a separate
// COMPONENT, so each needs its own `t` — an import, and on Angular a class
// member too (templates resolve names against the instance).  That wiring is
// what these tests pin: the binding AND the thing it resolves against.

/** A one-page system whose body is a `DataGrid` inside a `QueryView`.
 *  `filterable` drives the per-column filter input — and therefore whether the
 *  "Filter" placeholder is chrome this UI actually renders. */
const GRID_BODY = (filterable: boolean) => `Stack {
  Heading { "Orders" },
  QueryView { of: Sales.Order.all, data: rows => DataGrid {
    Column { "Status", o => o.status, sortable: true${filterable ? ", filterable: true" : ""} },
    rows: rows,
    testid: "orders-data-grid"
  } }
}`;

/** The hoisted grid child, wherever this frontend puts it.  On React it is the
 *  page itself (same file); the others emit a sibling. */
function gridChildOf(files: Map<string, string>, ...suffixes: string[]): string {
  for (const [p, c] of files) if (suffixes.some((s) => p.endsWith(s))) return c;
  throw new Error(`no grid child emitted (looked for ${suffixes.join(", ")})`);
}

describe("pack-chrome i18n — DataGrid pager", () => {
  it("React (mantine): pager + filter bind through t(), child shares the page's t import", async () => {
    const files = await generateSystemFiles(SYSTEM("react", "mantine", GRID_BODY(true)));
    const page = pageOf(files, "home.tsx");
    expect(page).toContain(`{t("chrome.previous", "Previous")}`);
    expect(page).toContain(`{t("chrome.next", "Next")}`);
    expect(page).toContain(`placeholder={t("chrome.filter", "Filter")}`);
    // The child is a module decl in the PAGE's file, so the page's own import
    // block is exactly what it resolves against.
    expect(page).toContain(`import { t } from "../i18n"`);
    const catalog = catalogOf(files);
    expect(catalog["chrome.previous"]).toBe("Previous");
    expect(catalog["chrome.next"]).toBe("Next");
    expect(catalog["chrome.filter"]).toBe("Filter");
  });

  it("Vue (vuetify): the sibling SFC carries its own ../i18n import", async () => {
    const files = await generateSystemFiles(SYSTEM("vue", "vuetify", GRID_BODY(true)));
    const child = gridChildOf(files, "src/components/OrdersDataGrid.vue");
    expect(child).toContain(`{{ t("chrome.previous", "Previous") }}`);
    expect(child).toContain(`{{ t("chrome.next", "Next") }}`);
    expect(child).toContain(`:placeholder='t("chrome.filter", "Filter")'`);
    // `src/components/` is one hop under `src/`, where the runtime lives — and
    // unlike a page it never nests, so the specifier needs no depth rewrite.
    expect(child).toContain(`import { t } from "../i18n";`);
    expect(files.has("web/src/i18n.ts")).toBe(true);
    expect(catalogOf(files)["chrome.previous"]).toBe("Previous");
  });

  it("Svelte (flowbite): the sibling component imports t from $lib/i18n", async () => {
    const files = await generateSystemFiles(SYSTEM("svelte", "flowbite", GRID_BODY(true)));
    const child = gridChildOf(files, "src/lib/components/OrdersDataGrid.svelte");
    expect(child).toContain(`{t("chrome.previous", "Previous")}`);
    expect(child).toContain(`{t("chrome.next", "Next")}`);
    expect(child).toContain(`placeholder={t("chrome.filter", "Filter")}`);
    // Depth-agnostic alias — the same specifier the walker's `../i18n` seam
    // import rewrites to everywhere else on Svelte.
    expect(child).toContain(`import { t } from "$lib/i18n";`);
    expect(files.has("web/src/lib/i18n.ts")).toBe(true);
    expect(catalogOf(files)["chrome.next"]).toBe("Next");
  });

  it("Angular (angularMaterial): the sibling component imports t AND lifts it onto the class", async () => {
    const files = await generateSystemFiles(SYSTEM("angular", "angularMaterial", GRID_BODY(true)));
    const child = gridChildOf(files, "src/app/components/orders-data-grid.component.ts");
    expect(child).toContain(`{{ t("chrome.previous", "Previous") }}`);
    expect(child).toContain(`{{ t("chrome.next", "Next") }}`);
    expect(child).toContain(`[placeholder]='t("chrome.filter", "Filter")'`);
    expect(child).toContain(`import { t } from "../../lib/i18n";`);
    // The import alone is not enough — an Angular template evaluates against
    // the component INSTANCE, so a module-scope `t` resolves to nothing.
    expect(child).toContain("protected readonly t = t;");
    expect(files.has("web/src/lib/i18n.ts")).toBe(true);
    expect(catalogOf(files)["chrome.filter"]).toBe("Filter");
  });

  it("Feliz: the same chrome, spelled in F# through the renderTranslate seam", async () => {
    // Feliz has no `.hbs` pack and no import map — it renders the grid from its
    // own procedural pack into one `App.fs`.  So the chrome reaches it as a bare
    // EXPRESSION (`localizedChromeValue`) rather than a markup fragment, and the
    // call is spelled F# by the `renderTranslate` seam (#2370) instead of the JS
    // `t(key, default)`.  Same keys, same catalog — which is the point: a Feliz
    // grid must not carry catalog entries nothing emits.
    const files = await generateSystemFiles(SYSTEM("feliz", "", GRID_BODY(true)));
    const app = gridChildOf(files, "App.fs");
    expect(app).toContain(`prop.text (I18n.t "chrome.previous" "Previous")`);
    expect(app).toContain(`prop.text (I18n.t "chrome.next" "Next")`);
    expect(app).toContain(`prop.placeholder (I18n.t "chrome.filter" "Filter")`);
    // The F# runtime's own catalog carries them, so no key is unresolvable.
    expect(app).toContain(`"chrome.previous", "Previous"`);
  });

  it("contributes chrome.filter ONLY when a column is filterable", async () => {
    // The pager is unconditional in every pack; the filter input rides
    // `hasFilters`.  Catalog and emission are gated by the SAME predicate
    // (`data-grid-shape.ts`), so a grid with no filterable column must carry
    // neither the key nor the binding — a mismatch either way is invisible to a
    // structural test but breaks translators or the runtime.
    const files = await generateSystemFiles(SYSTEM("react", "mantine", GRID_BODY(false)));
    const page = pageOf(files, "home.tsx");
    expect(page).toContain(`{t("chrome.previous", "Previous")}`);
    expect(page).not.toContain("chrome.filter");
    const catalog = catalogOf(files);
    expect(catalog["chrome.previous"]).toBe("Previous");
    expect(catalog["chrome.filter"]).toBeUndefined();
  });

  it("a grid alone turns i18n on (used-only chrome is translatable)", async () => {
    // No authored literal anywhere — the grid's pager is the ONLY user-visible
    // text, and it is still translatable: the extractor yields the pager keys,
    // the runtime ships, and the labels bind through t().
    const files = await generateSystemFiles(
      SYSTEM(
        "react",
        "mantine",
        `QueryView { of: Sales.Order.all, data: rows => DataGrid {
           Column { "Status", o => o.status },
           rows: rows
         } }`,
      ),
    );
    const page = pageOf(files, "home.tsx");
    expect(page).toContain(`{t("chrome.previous", "Previous")}`);
    expect(page).toContain(`import { t } from "../i18n"`);
    expect(catalogOf(files)["chrome.previous"]).toBe("Previous");
  });
});

// ---------------------------------------------------------------------------
// The pager's position counter — chrome with ICU HOLES
// ---------------------------------------------------------------------------
//
// Every chrome string before this one was a whole sentence the pack owned.  The
// counter is not: the packs spelled it as `Page ` + one expression + ` of ` +
// another, which is a sentence NO locale can translate — the word order is
// baked into the concatenation, and "Seite 3 von 7" only works because German
// happens to agree with English here.  Languages that put the total first, or
// need a different particle between the numbers, cannot be expressed at all.
//
// So the counter moves into the catalog as ONE ICU message with two named holes
// (`chrome.pageOf` = "Page {page} of {pages}"), and the emitter supplies the
// hole values in each frontend's own expression language.  The catalog contract
// is unchanged — a static string, one key — and the runtime's
// `intl-messageformat` does the substitution, so a locale is free to reorder.
//
// The holes are also why this is a fifth spelling rather than a reuse: the four
// JS frontends read the TanStack `table` through a JS member chain, and Feliz
// reaches the same numbers through Fable's dynamic-access operator.

describe("pack-chrome i18n — pager position counter (ICU chrome)", () => {
  it("React (mantine): one t() call carrying both numbers as named ICU holes", async () => {
    const files = await generateSystemFiles(SYSTEM("react", "mantine", GRID_BODY(true)));
    const page = pageOf(files, "home.tsx");
    expect(page).toContain(
      `{t("chrome.pageOf", "Page {page} of {pages}", ` +
        `{ page: table.getState().pagination.pageIndex + 1, ` +
        `pages: Math.max(table.getPageCount(), 1) })}`,
    );
    // The sentence is gone from the markup — if any pack still spelled it
    // inline, half the counter would be translatable and half would not.
    expect(page).not.toContain("Page {table.getState()");
    expect(catalogOf(files)["chrome.pageOf"]).toBe("Page {page} of {pages}");
  });

  it("Vue (vuetify): the sibling SFC interpolates the same call", async () => {
    const files = await generateSystemFiles(SYSTEM("vue", "vuetify", GRID_BODY(true)));
    const child = gridChildOf(files, "src/components/OrdersDataGrid.vue");
    expect(child).toContain(
      `{{ t("chrome.pageOf", "Page {page} of {pages}", ` +
        `{ page: table.getState().pagination.pageIndex + 1, ` +
        `pages: Math.max(table.getPageCount(), 1) }) }}`,
    );
    expect(child).toContain(`import { t } from "../i18n";`);
  });

  it("Svelte (flowbite): the sibling component interpolates it", async () => {
    const files = await generateSystemFiles(SYSTEM("svelte", "flowbite", GRID_BODY(true)));
    const child = gridChildOf(files, "src/lib/components/OrdersDataGrid.svelte");
    expect(child).toContain(`{t("chrome.pageOf", "Page {page} of {pages}", { page: `);
    expect(child).toContain(`import { t } from "$lib/i18n";`);
  });

  it("Angular (angularMaterial): the template evaluates it against the instance", async () => {
    const files = await generateSystemFiles(SYSTEM("angular", "angularMaterial", GRID_BODY(true)));
    const child = gridChildOf(files, "src/app/components/orders-data-grid.component.ts");
    expect(child).toContain(`{{ t("chrome.pageOf", "Page {page} of {pages}", { page: `);
    // Both names in the expression are class members on Angular — `t` because
    // the template has no module scope, `Math` for the same reason.
    expect(child).toContain("protected readonly t = t;");
    expect(child).toContain("Math");
  });

  it("Feliz: I18n.tf — the seam's WITH-VALUES arm, over Fable dynamic access", async () => {
    // The four JS frontends share `t(key, default, values)`; F# has no such
    // call, so `renderTranslate` spells the holed form as `I18n.tf` over a list
    // of boxed pairs.  Same key, same default, same hole NAMES — only the way
    // the two numbers are reached differs, which is why the Feliz child supplies
    // its own hole expressions rather than reusing the JS ones.
    const files = await generateSystemFiles(SYSTEM("feliz", "", GRID_BODY(true)));
    const app = gridChildOf(files, "App.fs");
    expect(app).toContain(
      `prop.text (I18n.tf "chrome.pageOf" "Page {page} of {pages}" ` +
        `[ "page", box (unbox<int> (table?getState()?pagination?pageIndex) + 1); ` +
        `"pages", box (max (unbox<int> (table?getPageCount())) 1) ])`,
    );
    // The old hand-rolled concatenation is gone from the emitted F#.
    expect(app).not.toContain(`"Page " + string`);
    expect(app).toContain(`"chrome.pageOf", "Page {page} of {pages}"`);
  });
});

// Per-pack-VERSION coverage, the lesson the app-shell block above records: a
// template that keeps the sentence inline still COMPILES and still renders — it
// is simply untranslatable, which no build gate and no single-pack assertion can
// see.  The `design:` clause names a FAMILY and resolves to its newest version,
// so a generate-and-assert test can only ever reach one version per family;
// rendering each pack directly is what reaches all fifteen.

describe("pager counter — every pack version renders it through the token", () => {
  const GRID_PACKS = [
    "angularMaterial@v1",
    "chakra@v2",
    "chakra@v3",
    "flowbite@v1",
    "mantine@v7",
    "mantine@v9",
    "mui@v5",
    "mui@v7",
    "primeng@v1",
    "shadcn@v3",
    "shadcn@v4",
    "shadcnSvelte@v1",
    "shadcnVue@v1",
    "spartanNg@v1",
    "vuetify@v3",
  ];

  it.each(GRID_PACKS)("%s", (name) => {
    const pack = loadPack(resolvePackDir(name));
    // The same context `emitDataGrid` builds, with the counter replaced by a
    // sentinel so the assertion is about the TOKEN, not about any one frontend's
    // interpolation syntax.
    const html = pack.render("primitive-data-grid", {
      hasColumnVisibility: true,
      hasFilters: true,
      hasSelection: false,
      testidAttr: "",
      prevLabel: "Previous",
      nextLabel: "Next",
      filterPlaceholderAttr: `placeholder="Filter"`,
      pageOfLabel: "«COUNTER»",
      sortByAria: "«SORT-ARIA»",
      filterByAria: "«FILTER-ARIA»",
      visibilityLabel: "«VISIBILITY-LABEL»",
      headerBody: "",
      cellBody: "",
    });
    expect(html).toContain("«COUNTER»");
    // …and nothing left behind: the sentence must not ALSO be spelled inline.
    expect(html).not.toMatch(/Page\s*\\?\{/);
    // The per-column control names, same rule.  Only six packs render the sort
    // BUTTON (the others leave it to the target's `headerBody`), so that token
    // is asserted only where the pack spells it — but NO pack may keep the raw
    // sentence, which is what the negative match pins.
    expect(html).toContain("«FILTER-ARIA»");
    expect(html).not.toContain("Sort by ");
    expect(html).not.toContain("Filter by ");
  });
});

// The i18n-OFF half, pinned at the helper rather than through the generator: a
// UI containing a `DataGrid` is ALWAYS i18n-enabled (its pager chrome is a
// used-only contribution, which is exactly what flips the runtime on), so there
// is no generatable system in which the counter renders raw.  That makes the
// off-branch defensive code — and defensive code with no test is how a "byte
// identical when i18n is off" promise quietly stops being true.
//
// The expected strings below are the literal text the pack templates carried
// before this slice, copied from the pre-change `.hbs` files.

describe("ICU chrome with i18n off — the message re-assembled around its holes", () => {
  const HOLES = [
    { name: "page", expr: "table.getState().pagination.pageIndex + 1" },
    { name: "pages", expr: "Math.max(table.getPageCount(), 1)" },
  ];

  /** The narrow slice of a walk context the chrome helpers actually read. */
  const ctxWith = (target: unknown, i18nPrefix?: string) =>
    ({ target, i18nPrefix }) as unknown as WalkContext;

  it("React/Svelte: `Page {expr} of {expr}` — the JSX template, verbatim", () => {
    for (const target of [tsxTarget, svelteTarget]) {
      expect(localizedChromeIcuText(ctxWith(target), "pageOf", HOLES)).toBe(
        "Page {table.getState().pagination.pageIndex + 1} of {Math.max(table.getPageCount(), 1)}",
      );
    }
  });

  it("Vue/Angular: `Page {{ expr }} of {{ expr }}` — the mustache template, verbatim", () => {
    for (const target of [vueTarget, angularTarget]) {
      expect(localizedChromeIcuText(ctxWith(target), "pageOf", HOLES)).toBe(
        "Page {{ table.getState().pagination.pageIndex + 1 }} of " +
          "{{ Math.max(table.getPageCount(), 1) }}",
      );
    }
  });

  it("the VALUE form yields nothing, so a procedural pack keeps its own sentence", () => {
    // Feliz's counter is an F# concatenation, and no seam spells concatenation.
    // Returning `undefined` hands the decision back to the pack, whose `??`
    // fallback is the string it has always emitted — byte-identical by
    // construction rather than by reconstruction.
    expect(localizedChromeIcuValue(ctxWith(felizTarget), "pageOf", HOLES)).toBeUndefined();
    expect(localizedChromeIcuValue(ctxWith(felizTarget, "page.Home"), "pageOf", HOLES)).toContain(
      `I18n.tf "chrome.pageOf"`,
    );
  });

  it("throws when a hole has no value rather than emitting a literal `{page}`", () => {
    // A `{page}` that reached JSX children would be a syntax error in the
    // generated project — far from the catalog edit that caused it.  The
    // message and the emitter's value list are two halves of one contract, and
    // this is where they are checked against each other.
    expect(() => localizedChromeIcuText(ctxWith(tsxTarget), "pageOf", [HOLES[0]!])).toThrow(
      /no value supplied for ICU hole "pages"/,
    );
  });
});

// The recovery link + the ROOT error boundary — the last two app-shell chrome
// strings, and the two that don't map one-key-one-site:
//   * "Back to home" appears twice per React pack with DIFFERENT raw text — the
//     error boundary's button (bare) and the 404's anchor ("← Back to home").
//     ONE key serves both; the arrow stays literal in the template, so i18n-off
//     still concatenates to the byte-identical "← Back to home".
//   * `src/ErrorBoundary.tsx` is a SHARED shell file mounted by main.tsx outside
//     App.tsx, so it can't reuse the app-shell tokens — and its raw string
//     carries a full stop the in-shell heading doesn't, hence its own key.
describe("pack-chrome i18n — back-to-home + root error boundary", () => {
  it("React: one key drives BOTH sites, arrow kept outside the message", async () => {
    const files = await generateSystemFiles(SYSTEM("react", "mantine", `Heading { "Welcome" }`));
    const app = appOf(files);
    // The error boundary's button — bare.
    expect(app).toContain(`{t("chrome.backToHome", "Back to home")}`);
    // The 404's anchor — the "← " is decoration OUTSIDE the t() call, so
    // translators get a clean phrase and RTL/CJK isn't stuck with the glyph.
    expect(app).toContain(`← {t("chrome.backToHome", "Back to home")}</Anchor>`);
    expect(catalogOf(files)["chrome.backToHome"]).toBe("Back to home");
    // One catalog entry, not two.
    expect(Object.keys(catalogOf(files)).filter((k) => k.startsWith("chrome.backToHome"))).toEqual([
      "chrome.backToHome",
    ]);
  });

  it("Vue: the error boundary's recovery button binds too", async () => {
    for (const pack of ["vuetify", "shadcnVue"] as const) {
      const files = await generateSystemFiles(SYSTEM("vue", pack, `Heading { "Welcome" }`));
      expect(shellOf(files, "src/App.vue")).toContain(
        `{{ t("chrome.backToHome", "Back to home") }}`,
      );
      expect(catalogOf(files)["chrome.backToHome"]).toBe("Back to home");
    }
  });

  it("the ROOT ErrorBoundary binds its own key and imports t itself", async () => {
    const files = await generateSystemFiles(SYSTEM("react", "mantine", `Heading { "Welcome" }`));
    const boundary = shellOf(files, "src/ErrorBoundary.tsx");
    // Its own module ⇒ its own gated import (App.tsx's doesn't reach here).
    expect(boundary).toContain(`import { t } from "./i18n";`);
    expect(boundary).toContain(`{t("chrome.rootErrorTitle", "Something went wrong.")}`);
    expect(catalogOf(files)["chrome.rootErrorTitle"]).toBe("Something went wrong.");
    // Distinct from the IN-SHELL heading, which has no full stop.
    expect(catalogOf(files)["chrome.somethingWentWrong"]).toBe("Something went wrong");
  });

  it("stays byte-identical (raw text, no t import) with i18n off", async () => {
    const files = await generateSystemFiles(SYSTEM("react", "mantine", `Text { status }`));
    const app = appOf(files);
    // The button's label sits on its own line in the emitted JSX.
    expect(app).toMatch(/>\s*\n\s*Back to home\n\s*<\/Button>/);
    expect(app).toContain(`← Back to home</Anchor>`);
    const boundary = shellOf(files, "src/ErrorBoundary.tsx");
    expect(boundary).toContain(`<h2 style={msgStyle}>Something went wrong.</h2>`);
    expect(boundary).not.toContain("import { t }");
  });
});

// ---------------------------------------------------------------------------
// The `<select>` picker placeholder
// ---------------------------------------------------------------------------
//
// `SelectField` renders `primitive-select-field`, and nothing else does — so
// contributing `chrome.selectPlaceholder` off that call node is EXACT.
//
// The form-built pickers (`field-input-id-select` / `-enum-select`) are
// deliberately NOT wired: see the note in `i18n-chrome.ts`.  The last test here
// pins the reason, because the tempting fix regresses something a structural
// assertion would not notice.

describe("pack-chrome i18n — select placeholder", () => {
  const SELECT_BODY = `Stack {
    Heading { "Pick one" },
    SelectField { "Choice", bind: choice, options: ["a", "b"] }
  }`;

  /** The one-page system, with a `choice` state field for the picker to bind. */
  const SELECT_SYSTEM = (platform: string, design: string) =>
    SYSTEM(platform, design, SELECT_BODY).replace(
      `page Home { route: "/" body:`,
      `page Home { route: "/" state { choice: string = "" } body:`,
    );

  it("React (shadcn): binds the placeholder through t() keyed to the catalog", async () => {
    const files = await generateSystemFiles(SELECT_SYSTEM("react", "shadcn"));
    const page = pageOf(files, "home.tsx");
    expect(page).toContain(`placeholder={t("chrome.selectPlaceholder", "Select…")}`);
    // Renders into the PAGE, so `t` must be on the page's own import block —
    // the half a "does it contain t(...)" check would miss.
    expect(page).toContain(`import { t } from "../i18n"`);
    expect(catalogOf(files)["chrome.selectPlaceholder"]).toBe("Select…");
  });

  it("Vue (shadcnVue): binds it as :placeholder='t(…)'", async () => {
    const files = await generateSystemFiles(SELECT_SYSTEM("vue", "shadcnVue"));
    const page = pageOf(files, "home.vue");
    expect(page).toContain(`:placeholder='t("chrome.selectPlaceholder", "Select…")'`);
    expect(catalogOf(files)["chrome.selectPlaceholder"]).toBe("Select…");
  });

  /** A form whose aggregate has an `X id` (with `derived display`) and an enum
   *  field — so it renders two pickers from `field-input-*-select`. */
  const PICKER_FORM = (body: string) => `
    system Shop {
      subdomain Sales {
        context Orders {
          enum Tier { Bronze, Silver }
          aggregate Customer with crudish {
            name: string
            derived display: string = this.name
          }
          aggregate Order with crudish { customer: Customer id  tier: Tier }
          repository Orders for Order { }
        }
      }
      api SalesApi from Sales
      ui Web {
        api Sales: SalesApi
        page Home { route: "/" body: ${body} }
      }
      storage primary { type: postgres }
      resource st { for: Orders, kind: state, use: primary }
      deployable api { platform: node, contexts: [Orders], dataSources: [st], serves: SalesApi, port: 3000 }
      deployable web { platform: static targets: api ui: Web { Sales: api } design: shadcn port: 3100 }
    }
  `;

  it("a form's pickers bind through t() once the UI is i18n-enabled", async () => {
    // The form contributes NOTHING to the catalog itself; the key rides in via
    // `FORM_CHROME`, merged because this UI is already translatable (the
    // Heading).  Both halves answer the same question, so the binding can never
    // outrun the key.
    const files = await generateSystemFiles(
      PICKER_FORM(`Stack { Heading { "New order" }, CreateForm { of: Order } }`),
    );
    const page = pageOf(files, "home.tsx");
    expect(page).toContain(`placeholder={t("chrome.selectPlaceholder", "Select…")}`);
    expect(page).not.toContain(`placeholder="Select…"`);
    expect(catalogOf(files)["chrome.selectPlaceholder"]).toBe("Select…");
  });

  it("the SAME form stays English — and runtime-free — with nothing to translate", async () => {
    // The half that made the obvious design wrong.  Contributing the key from
    // `CreateForm` would key the bindings above, but it also flips i18n ON here,
    // shipping `src/i18n.ts`, `locales/en.json` and the `intl-messageformat`
    // dependency into an app with nothing to translate.  `FORM_CHROME` is merged
    // only for an ALREADY-enabled UI precisely so this case stays untouched.
    const files = await generateSystemFiles(PICKER_FORM(`CreateForm { of: Order }`));
    const page = pageOf(files, "home.tsx");
    expect(page).toContain(`placeholder="Select…"`);
    expect(page).not.toContain("chrome.selectPlaceholder");
    expect([...files].some(([p]) => p.endsWith("locales/en.json"))).toBe(false);
    expect([...files].some(([p]) => p.endsWith("src/i18n.ts"))).toBe(false);
  });

  it("emitter-built form chrome reaches the catalog when a page uses it", async () => {
    // `Delete <Agg>` and its `window.confirm` prompt are built in the EMITTER
    // from the aggregate name, so neither the content-hash extraction pass
    // (literals in the .ddd body) nor the pack-chrome `.hbs` slice ever saw
    // them — they shipped untranslated on every frontend.  They ride
    // `FORM_CHROME`, so they are merged for an app that is ALREADY i18n-enabled
    // rather than flipping i18n on for a form-only page.
    const files = await generateSystemFiles(
      SYSTEM("react", "shadcn", `Stack { Heading { "Welcome" }, DestroyForm { of: Order } }`),
    );
    const catalog = catalogOf(files);
    expect(catalog[chromeKey("deleteEntity")]).toBe(CHROME_MESSAGES[chromeKey("deleteEntity")]);
    expect(catalog[chromeKey("deleteConfirm")]).toBe(CHROME_MESSAGES[chromeKey("deleteConfirm")]);
    const page = [...files].find(([p]) => p.endsWith("home.tsx"))![1];
    expect(page).toContain('t("chrome.deleteConfirm"');
  });
});

// ---------------------------------------------------------------------------
// The `Table` pager — the same three strings, three lines away from the grid's
// ---------------------------------------------------------------------------
//
// `Table`'s pager is not pack markup at all: each `WalkerTarget` builds it as a
// literal string in `renderPager`, which made "Prev" / "Next" / "Page N of M"
// the one class of user-visible text living in the GENERATOR rather than in a
// template — and the one no locale could reach.  They now arrive pre-resolved
// through `PagerSpec.chrome`, in two forms (`PagerChrome`): the four JSX targets
// splice a rendered fragment, Feliz and Flutter take a target-native value.
//
// Merged-when-already-enabled (`TABLE_PAGER_CHROME`), NOT contributed off the
// `Table` call node — the pager is conditional on `serverControls`, a
// walk-context fact the target-agnostic extraction pass cannot see.  The last
// two tests are that gate in both directions.

/** A one-page system whose body is a client-paged `Table`.
 *
 *  The column header is a STATE ref rather than the literal `"Name"` it used to
 *  be: a `Column` header became a user-visible slot (`columnHeader`, M-T1.11),
 *  so a literal there is authored prose and would turn i18n on by itself —
 *  which is exactly the switch the last three cases here need OFF.  A dynamic
 *  header has no source string, so the fixture is string-less again and the
 *  merge-gate assertions still test the gate rather than the header. */
const PAGED_TABLE = (platform: string, design: string, extra = "", framework = "") => `
  system S {
    subdomain Sales {
      context Orders {
        aggregate Customer { name: string }
        repository Customers for Customer { find recent(): Customer }
      }
    }
    api SalesApi from Sales
    storage pg { type: postgres }
    resource ordersState { for: Orders, kind: state, use: pg }
    ui WebApp {${framework === "" ? "" : `\n      framework: ${framework}`}
      api Sales: SalesApi
      page X {
        route: "/x"
        state { pageNum: int = 1 colHeader: string = "Name" }
        body: Stack { ${extra}QueryView { of: Sales.Customer.recent, data: rows => Table(
          Column(colHeader, o => o.name),
          rows: rows,
          page: pageNum,
          pageSize: 5
        ) } }
      }
    }
    deployable api {
      platform: node
      contexts: [Orders]
      dataSources: [ordersState]
      serves: SalesApi
      port: 3000
    }
    deployable web {
      platform: ${platform}
      targets: api
      ui: WebApp { Sales: api }${design === "" ? "" : `\n      design: ${design}`}
      port: 3001
    }
  }
`;

/** The `Heading` that makes the UI translatable — the merge gate's ON switch. */
const TRANSLATABLE = `Heading { "Customers" }, `;

describe("pack-chrome i18n — the Table pager", () => {
  it.each([
    ["react", "mantine", "", "pages/x.tsx", `{t("chrome.prev", "Prev")}`],
    ["static", "shadcnVue", "vue", "pages/x.vue", `{{ t("chrome.prev", "Prev") }}`],
    ["static", "shadcnSvelte", "svelte", "x/+page.svelte", `{t("chrome.prev", "Prev")}`],
    [
      "static",
      "angularMaterial",
      "angular",
      "pages/x.component.ts",
      `{{ t("chrome.prev", "Prev") }}`,
    ],
  ])("%s/%s binds Prev, Next and the counter", async (platform, design, framework, file, prevBinding) => {
    const files = await generateSystemFiles(PAGED_TABLE(platform, design, TRANSLATABLE, framework));
    const page = pageOf(files, file);
    expect(page).toContain(prevBinding);
    expect(page).toContain(`t("chrome.pageOf", "Page {page} of {pages}", { page: `);
    // Not a literal left anywhere near the pager.
    expect(page).not.toContain(">Prev<");
    expect(page).not.toContain(">Page {");
    const catalog = catalogOf(files);
    expect(catalog["chrome.prev"]).toBe("Prev");
    expect(catalog["chrome.next"]).toBe("Next");
    expect(catalog["chrome.pageOf"]).toBe("Page {page} of {pages}");
  });

  it("Feliz: the labels are VALUES, and the counter keeps its own sprintf when off", async () => {
    const on = await generateSystemFiles(PAGED_TABLE("feliz", "", TRANSLATABLE));
    const app = pageOf(on, "App.fs");
    expect(app).toContain(`prop.text (I18n.t "chrome.prev" "Prev")`);
    expect(app).toContain(`I18n.tf "chrome.pageOf" "Page {page} of {pages}"`);
    expect(app).not.toContain(`sprintf "Page %d of %d"`);

    // …and with nothing else to translate, the target's own sentence stands.
    const off = pageOf(await generateSystemFiles(PAGED_TABLE("feliz", "")), "App.fs");
    expect(off).toContain(`prop.text (sprintf "Page %d of %d" model.PageNum __tp)`);
    expect(off).toContain(`prop.text "Prev"`);
  });

  it("Flutter: `const Text` survives i18n-off and is dropped when the label binds", async () => {
    // Dart rejects `const` over a `t(...)` call, so constness has to follow the
    // label — which is also what keeps the i18n-off output byte-identical.
    const off = pageOf(await generateSystemFiles(PAGED_TABLE("flutter", "")), "x_page.dart");
    expect(off).toContain(`child: const Text('Prev')`);
    expect(off).toContain(`Text('Page \${state.pageNum} of `);

    const on = pageOf(
      await generateSystemFiles(PAGED_TABLE("flutter", "", TRANSLATABLE)),
      "x_page.dart",
    );
    expect(on).toContain(`child: Text(t('chrome.prev', 'Prev'))`);
    expect(on).toContain(
      `Text(t('chrome.pageOf', 'Page {page} of {pages}', <String, Object>{'page'`,
    );
    expect(on).not.toContain("const Text('Prev')");
  });

  it("a paged Table alone does NOT turn i18n on (the pager is conditional)", async () => {
    // The other half of the merge-gate design.  `Table`'s pager depends on
    // `serverControls` — a walk-context fact, not a call-node one — so a
    // contribution could not be gated accurately in the extraction pass.  Merged
    // instead, which leaves a string-less app exactly as it was: raw English, no
    // runtime, no catalog, no `intl-messageformat`.
    const files = await generateSystemFiles(PAGED_TABLE("react", "mantine"));
    const page = pageOf(files, "pages/x.tsx");
    expect(page).toContain(">Prev</button>");
    expect(page).toContain("<span>Page {pageNum} of {");
    expect(page).not.toContain("chrome.");
    expect([...files].some(([p]) => p.endsWith("locales/en.json"))).toBe(false);
    expect([...files].some(([p]) => p.endsWith("src/i18n.ts"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-column control ARIA — holed chrome in ATTRIBUTE position
// ---------------------------------------------------------------------------
//
// "Sort by {column}" / "Filter by {column}" are the counter's problem one step
// harder: an ICU message whose i18n-off form is a CONCATENATION, and which lands
// in an attribute rather than in text.  The counter's off-path could reuse
// `renderInterpolation` (markup text position); an attribute has no such seam,
// and the raw spelling diverges four ways — a JS template literal on
// React/Svelte/Vue, `'…' + String(…)` on Angular (whose template grammar has no
// template literals), F# `+` on Feliz, Dart `${…}` interpolation on Flutter.
//
// Hence `renderStringConcat`: literal + expression pieces → one target-native
// string expression, with the JS template literal as the default so the three
// targets that already spelled it that way implement nothing.
//
// Unlike the pager the keys are contributed EXACTLY (`gridHasSortableColumn` /
// `gridHasFilterableColumn`), not merged: both predicates are fully readable off
// the call node, so no over-merge is needed.

describe("renderStringConcat — the i18n-off spelling, per target", () => {
  // The exact strings the packs and child renderers carried before this slice.
  // Asserting against them is the byte-identity proof: the off-path is
  // unreachable through the generator (a `DataGrid` always enables i18n, so its
  // aria always binds), which is precisely why the seam needs pinning here.
  const PARTS = [
    { text: "Sort by " },
    { expr: "String(h.column.columnDef.header ?? h.id)" },
  ] as const;
  const jsForm = "`Sort by ${String(h.column.columnDef.header ?? h.id)}`";

  it.each([
    ["react", tsxTarget, jsForm],
    ["svelte", svelteTarget, jsForm],
    ["vue", vueTarget, jsForm],
    ["angular", angularTarget, "'Sort by ' + String(h.column.columnDef.header ?? h.id)"],
    ["feliz", felizTarget, '("Sort by " + String(h.column.columnDef.header ?? h.id))'],
    ["flutter", flutterTarget, "'Sort by ${String(h.column.columnDef.header ?? h.id)}'"],
  ])("%s", (_name, target, expected) => {
    // An unset seam IS the contract for the three JS-template-literal targets,
    // so the default is exercised through the same helper the emitters use.
    const ctx = { target, i18nPrefix: undefined } as unknown as WalkContext;
    expect(localizedChromeIcuExpr(ctx, "sortBy", [{ name: "column", expr: PARTS[1].expr }])).toBe(
      expected,
    );
  });
});

describe("pack-chrome i18n — per-column control ARIA", () => {
  /** A grid with row selection on — the checkbox column's two names.
   *
   *  Its own system rather than the shared `SYSTEM`, because `selection:` must
   *  name a declared `string[]` state field: anything else is a validation
   *  ERROR (`loom.datagrid-selection-not-state`), which is precisely what makes
   *  the call-node predicate exact. */
  const SELECTION_SYS = (platform: string, design: string) => `
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
        page Home {
          route: "/"
          state { picked: string[] = [] }
          body: Stack {
            QueryView { of: Sales.Order.all, data: rows => DataGrid {
              Column { "Status", o => o.status },
              rows: rows,
              selection: picked,
              testid: "orders-data-grid"
            } }
          }
        }
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
      deployable web { platform: ${platform} targets: api ui: Web { Sales: api }${
        design === "" ? "" : ` design: ${design}`
      } port: 3100 }
    }
  `;

  /** A grid whose single column opts into sorting and/or filtering. */
  const ARIA_GRID = (sortable: boolean, filterable: boolean) => `Stack {
    QueryView { of: Sales.Order.all, data: rows => DataGrid {
      Column { "Status", o => o.status${sortable ? ", sortable: true" : ""}${
        filterable ? ", filterable: true" : ""
      } },
      rows: rows,
      testid: "orders-data-grid"
    } }
  }`;

  it.each([
    ["react", "mantine", "home.tsx", `aria-label={t("chrome.sortBy"`],
    ["vue", "vuetify", "src/components/OrdersDataGrid.vue", `:aria-label='t("chrome.sortBy"`],
    [
      "svelte",
      "flowbite",
      "src/lib/components/OrdersDataGrid.svelte",
      `aria-label={t("chrome.sortBy"`,
    ],
    [
      "angular",
      "angularMaterial",
      "src/app/components/orders-data-grid.component.ts",
      `[attr.aria-label]='t("chrome.sortBy"`,
    ],
  ])("%s/%s binds both control names", async (platform, design, file, sortBinding) => {
    const files = await generateSystemFiles(SYSTEM(platform, design, ARIA_GRID(true, true)));
    const child = gridChildOf(files, file);
    expect(child).toContain(sortBinding);
    expect(child).toContain(`"chrome.filterBy", "Filter by {column}", { column: `);
    // The hole is the COLUMN's own header, so the label still says WHICH column.
    expect(child).toContain("String(h.column.columnDef.header ?? h.id)");
    // No raw sentence left behind on either control.
    expect(child).not.toContain("Sort by ${");
    expect(child).not.toContain("'Filter by ' +");
    const catalog = catalogOf(files);
    expect(catalog["chrome.sortBy"]).toBe("Sort by {column}");
    expect(catalog["chrome.filterBy"]).toBe("Filter by {column}");
  });

  it("Feliz: F# values through the seam's WITH-VALUES arm", async () => {
    const app = gridChildOf(
      await generateSystemFiles(SYSTEM("feliz", "", ARIA_GRID(true, true))),
      "App.fs",
    );
    expect(app).toContain(
      `prop.ariaLabel (I18n.tf "chrome.sortBy" "Sort by {column}" ` +
        `[ "column", box (loomText (h?column?columnDef?header)) ])`,
    );
    expect(app).toContain(
      `prop.ariaLabel (I18n.tf "chrome.filterBy" "Filter by {column}" ` +
        `[ "column", box (loomText (h?column?columnDef?header)) ])`,
    );
    expect(app).not.toContain(`("Sort by " + loomText`);
    expect(app).not.toContain(`("Filter by " + loomText`);
  });

  it.each([
    ["react", "mantine", "home.tsx", `aria-label={t("chrome.selectAllRows", "Select all rows")}`],
    [
      "vue",
      "vuetify",
      "src/components/OrdersDataGrid.vue",
      `:aria-label='t("chrome.selectAllRows", "Select all rows")'`,
    ],
    [
      "svelte",
      "flowbite",
      "src/lib/components/OrdersDataGrid.svelte",
      `aria-label={t("chrome.selectAllRows", "Select all rows")}`,
    ],
    [
      "angular",
      "angularMaterial",
      "src/app/components/orders-data-grid.component.ts",
      `[attr.aria-label]='t("chrome.selectAllRows", "Select all rows")'`,
    ],
  ])("%s/%s names its selection checkboxes", async (platform, design, file, binding) => {
    // A checkbox has NO visible label, so this string is its entire accessible
    // name — the one grid control that is unusable, not merely English, when a
    // locale can't reach it.
    const files = await generateSystemFiles(SELECTION_SYS(platform, design));
    const child = gridChildOf(files, file);
    expect(child).toContain(binding);
    expect(child).not.toContain(`aria-label="Select all rows"`);
    expect(child).not.toContain(`aria-label="Select row"`);
    const catalog = catalogOf(files);
    expect(catalog["chrome.selectAllRows"]).toBe("Select all rows");
    expect(catalog["chrome.selectRow"]).toBe("Select row");
  });

  it("React stops shadowing the translator with the TanStack table", async () => {
    // The select column's header lambda destructured `{ table: t }` — the exact
    // name of the imported translator.  A `t("chrome.selectAllRows", …)` inside
    // it would have called the TABLE object and thrown at runtime; no type
    // checker sees it, because TanStack's `table` is happily `any`-ish here.
    // Renaming the shadow is why this binding is reachable at all.
    const files = await generateSystemFiles(SELECTION_SYS("react", "mantine"));
    const page = pageOf(files, "home.tsx");
    expect(page).toContain("header: ({ table: tbl }) => (");
    expect(page).not.toContain("header: ({ table: t }) => (");
    expect(page).toContain("checked={tbl.getIsAllPageRowsSelected()}");
  });

  it("Feliz names them as F# values", async () => {
    const app = gridChildOf(await generateSystemFiles(SELECTION_SYS("feliz", "")), "App.fs");
    expect(app).toContain(`prop.ariaLabel (I18n.t "chrome.selectAllRows" "Select all rows")`);
    expect(app).toContain(`prop.ariaLabel (I18n.t "chrome.selectRow" "Select row")`);
    expect(app).not.toContain(`prop.ariaLabel "Select all rows"`);
  });

  it("a grid with no selection carries neither key", async () => {
    // `selection:` naming a non-state field is a validation ERROR, so the arg's
    // presence on the call node settles whether the column renders — which is
    // what lets these be contributed exactly rather than merged.
    const catalog = catalogOf(
      await generateSystemFiles(SYSTEM("react", "mantine", ARIA_GRID(true, true))),
    );
    expect(catalog["chrome.selectAllRows"]).toBeUndefined();
    expect(catalog["chrome.selectRow"]).toBeUndefined();
  });

  it("each key is contributed by its OWN predicate, not by the grid as a whole", async () => {
    // `sortable:` and `filterable:` are independent, so one gate would be wrong
    // in both directions.  A sort-only grid renders a sort button and no filter
    // input; the catalog has to say exactly that.
    const sortOnly = catalogOf(
      await generateSystemFiles(SYSTEM("react", "mantine", ARIA_GRID(true, false))),
    );
    expect(sortOnly["chrome.sortBy"]).toBe("Sort by {column}");
    expect(sortOnly["chrome.filterBy"]).toBeUndefined();

    const filterOnly = catalogOf(
      await generateSystemFiles(SYSTEM("react", "mantine", ARIA_GRID(false, true))),
    );
    expect(filterOnly["chrome.filterBy"]).toBe("Filter by {column}");

    const neither = catalogOf(
      await generateSystemFiles(SYSTEM("react", "mantine", ARIA_GRID(false, false))),
    );
    expect(neither["chrome.filterBy"]).toBeUndefined();
    // …but the pager is unconditional, so its keys are still there.
    expect(neither["chrome.previous"]).toBe("Previous");
    // `chrome.sortBy` is deliberately NOT asserted absent here.  The GRID
    // contributes it exactly (the sort-only case above proves that), but
    // `Table`'s sortable header needs it too and cannot be gated on the call
    // node — so it also rides `TABLE_CONTROLS_CHROME`, merged into every
    // i18n-enabled app.  `filterBy` has no such second home, which is why it
    // stays the honest witness that the two predicates are independent.
  });
});
