import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Named layouts — Vue (Phase 8).
//
// A `layout <Name> { header / main / footer }` wraps every page that
// selects it via `layout: <Name>`.  React weaves wrappers into App.tsx
// and SvelteKit uses route groups; the vue-router-native shape is nested
// routes — the layout SFC (slots + an inner `<router-view />`) is the
// parent `component`, the layout-bound pages its `children`.  `layout:
// none` mounts top-level; the default chrome moves to
// `src/layouts/DefaultLayout.vue` and App.vue becomes a thin host.
// Default-only uis keep the flat router + chrome-in-App.vue shape.
// ---------------------------------------------------------------------------

const SRC = `
  system S {
    subdomain Shop { context Cart {
      aggregate Item { name: string  derived display: string = name }
      repository Items for Item { }
    } }
    api ShopApi from Shop
    layout Marketing {
      header { Heading { "Acme", level: 3 } }
      main
      footer { Text { "© Acme" } }
    }
    ui Web {
      api Cart: ShopApi
      page Landing { route: "/" layout: Marketing body: Stack { Heading { "Welcome" } } }
      page Dash { route: "/dash" body: Heading { "Dashboard" } }
      page Kiosk { route: "/kiosk" layout: none body: Heading { "Kiosk" } }
    }
    deployable api { platform: node, contexts: [Cart], serves: ShopApi, port: 3000 }
    deployable web { platform: vue, targets: api, ui: Web { Cart: api }, port: 3001 }
  }
`;

async function vueFiles(src: string): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web/")) out.set(p.slice("web/".length), c);
  }
  return out;
}

describe("named layouts — Vue", () => {
  it("emits a layout SFC with the walked slots around an inner router-view", async () => {
    const files = await vueFiles(SRC);
    const layout = files.get("src/layouts/Marketing.vue")!;
    expect(layout).toBeDefined();
    // header + footer walked to pack markup, the `main` slot is the outlet.
    expect(layout).toContain("<h3>Acme</h3>");
    expect(layout).toContain("<router-view />");
    expect(layout).toContain("© Acme");
    expect(layout).toContain('data-testid="layout-marketing"');
    // a11y: the slots are wrapped in landmark elements (parity with the auto
    // DefaultLayout + the React/Svelte named layouts).
    expect(layout).toContain("<header>");
    expect(layout).toContain('<main id="main-content"><router-view /></main>');
    expect(layout).toContain("<footer>");
  });

  it("restructures into nested routes (none top-level, named + default wrappers)", async () => {
    const files = await vueFiles(SRC);
    const router = files.get("src/router.ts")!;
    expect(router).toContain('import MarketingLayout from "./layouts/Marketing.vue";');
    expect(router).toContain('import DefaultLayout from "./layouts/DefaultLayout.vue";');
    // Kiosk (layout: none) mounts top-level, no wrapper.
    expect(router).toContain('{ path: "/kiosk", component: Kiosk },');
    // Landing nests under MarketingLayout; Dash under DefaultLayout.
    expect(router).toMatch(
      /component: MarketingLayout,\s*children: \[\s*\{ path: "\/", component: Landing \}/,
    );
    expect(router).toMatch(
      /component: DefaultLayout,\s*children: \[\s*\{ path: "\/dash", component: Dash \}/,
    );
    // The catch-all stays inside the default chrome.
    expect(router).toContain('{ path: "/:pathMatch(.*)*", component: NotFound },');
  });

  it("App.vue is a thin <router-view /> host; the chrome moved to DefaultLayout", async () => {
    const files = await vueFiles(SRC);
    const app = files.get("src/App.vue")!;
    expect(app).toContain("<router-view />");
    expect(app).not.toContain("v-navigation-drawer"); // chrome no longer here
    const def = files.get("src/layouts/DefaultLayout.vue")!;
    expect(def).toBeDefined();
    expect(def).toContain("<router-view"); // the chrome's inner outlet
  });

  it("a default-only ui keeps the flat router + chrome-in-App.vue shape", async () => {
    const files = await vueFiles(`
      system S {
        subdomain Shop { context Cart {
          aggregate Item { name: string  derived display: string = name }
          repository Items for Item { }
        } }
        api ShopApi from Shop
        ui Web {
          api Cart: ShopApi
          page Dash { route: "/dash" body: Heading { "Dashboard" } }
        }
        deployable api { platform: node, contexts: [Cart], serves: ShopApi, port: 3000 }
        deployable web { platform: vue, targets: api, ui: Web { Cart: api }, port: 3001 }
      }`);
    expect(files.has("src/layouts/Marketing.vue")).toBe(false);
    expect(files.has("src/layouts/DefaultLayout.vue")).toBe(false);
    // Router is flat (pages mount directly, no children: arrays).
    const router = files.get("src/router.ts")!;
    expect(router).not.toContain("children:");
    expect(router).toContain('{ path: "/dash", component: Dash },');
  });
});
