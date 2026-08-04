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
import { APP_SHELL_CHROME, CHROME_MESSAGES } from "../../src/generator/_walker/i18n-chrome.js";
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

describe("pack-chrome i18n — React app-shell chrome", () => {
  // EVERY React pack, not just the default one.  The skip-link slice wired 13
  // packs and missed shadcn v3/v4 — they rendered `{{{notFoundText}}}` and
  // `{{{primaryNavAria}}}` but kept the skip link as raw text, so the string was
  // in the catalog and untranslatable on those two packs.  A per-pack loop is
  // what catches a template that forgets a token; a single-pack assertion never
  // could.
  it.each([
    "mantine",
    "shadcn",
    "mui",
    "chakra",
  ])("%s renders every shell-chrome token (no raw string left behind)", async (design) => {
    const on = appOf(await generateSystemFiles(SYSTEM("react", design, `Heading { "Welcome" }`)));
    for (const [key, english] of Object.entries(APP_SHELL_CHROME)) {
      // A pack need not SPELL every chrome string (mui has no nav landmark
      // label, only chakra says "Open menu") — but whatever it spells must be
      // bound, never raw.  So: if the English appears at all, it appears
      // inside a t() call for its own key.
      if (!on.includes(english)) continue;
      expect(on, `${design} left "${english}" unbound`).toContain(
        `t(${JSON.stringify(key)}, ${JSON.stringify(english)})`,
      );
    }
  });

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
    // The grid's chrome is NOT here — nothing on this page renders a pager.
    expect(catalog["chrome.previous"]).toBeUndefined();
    expect(catalog["chrome.next"]).toBeUndefined();
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
});
