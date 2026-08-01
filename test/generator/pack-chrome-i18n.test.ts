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

import { describe, expect, it } from "vitest";
import { CHROME_MESSAGES } from "../../src/generator/_walker/i18n-chrome.js";
import { generateSystemFiles } from "../_helpers/index.js";

/** A one-page system on `<platform>`/`<design>` whose body is `<body>`. */
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
    deployable web { platform: ${platform} targets: api ui: Web { Sales: api } design: ${design} port: 3100 }
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

describe("pack-chrome i18n — React app-shell chrome", () => {
  it("binds the 404 + skip-link text through t() and imports t into App.tsx", async () => {
    const files = await generateSystemFiles(SYSTEM("react", "mantine", `Heading { "Welcome" }`));
    const app = appOf(files);
    expect(app).toContain(`import { t } from "./i18n"`);
    expect(app).toContain(`{t("chrome.notFound", "Not found")}`);
    expect(app).toContain(`{t("chrome.skipToContent", "Skip to content")}`);
    const catalog = catalogOf(files);
    expect(catalog["chrome.notFound"]).toBe("Not found");
    expect(catalog["chrome.skipToContent"]).toBe("Skip to content");
  });

  it("stays byte-identical (raw shell text, no t import) for a string-less app", async () => {
    const files = await generateSystemFiles(SYSTEM("react", "mantine", `Text { status }`));
    const app = appOf(files);
    expect(app).toContain(">Not found<");
    expect(app).toContain(">Skip to content<");
    expect(app).not.toContain("import { t }");
    expect([...files].some(([p]) => p.endsWith("locales/en.json"))).toBe(false);
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

  it("merges the full chrome vocabulary into the catalog (translator-facing)", async () => {
    const files = await generateSystemFiles(
      SYSTEM("react", "shadcn", `Stack { Heading { "Welcome" }, Loader() }`),
    );
    const catalog = catalogOf(files);
    for (const [key, message] of Object.entries(CHROME_MESSAGES)) {
      expect(catalog[key]).toBe(message);
    }
  });
});
