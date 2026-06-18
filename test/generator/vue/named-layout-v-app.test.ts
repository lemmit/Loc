// Regression: on the Vuetify pack, a named `layout` SFC is a top-level routed
// component, so it must provide the `<v-app>` root that every Vuetify component
// (and the page rendered in its `<router-view/>`) needs for layout/theme
// injection.  The named-layout emitter hardcoded a plain
// `<div class="loom-layout">`, so pages under a named layout (e.g. /dashboard)
// rendered Vuetify components outside `<v-app>` and mis-rendered/threw at
// runtime — while the auto `DefaultLayout.vue` (a pack template) correctly wraps
// in `<v-app>`.  No test covered the Vue named-layout root element.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Acme {
  subdomain Sales {
    context S {
      aggregate Order { name: string }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  layout Marketing {
    header { Heading { "Acme", level: 3 } }
    main
    footer { Text { "© Acme" } }
  }
  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    page Dashboard {
      route: "/dashboard"
      layout: Marketing
      body: Heading { "Dashboard", level: 2 }
    }
  }
  storage primarySql { type: postgres }
  resource sState { for: S, kind: state, use: primarySql }
  deployable api {
    platform: node
    contexts: [S]
    dataSources: [sState]
    serves: SalesApi
    port: 3001
  }
  deployable webApp {
    platform: vue
    targets: api
    ui: WebApp { Sales: api }
    port: 5173
  }
}
`;

describe("vue (vuetify) — named layout provides the <v-app> root", () => {
  it("wraps the named-layout SFC in <v-app> (parity with DefaultLayout)", async () => {
    const files = await generateSystemFiles(SRC);
    const marketing = files.get("web_app/src/layouts/Marketing.vue");
    expect(marketing, "Marketing.vue named layout").toBeDefined();
    expect(marketing).toMatch(/<v-app[ >]/);
    expect(marketing).toContain("</v-app>");
    // ...and never the plain non-Vuetify wrapper.
    expect(marketing).not.toContain('class="loom-layout"');
    // The page slot still mounts inside the layout.
    expect(marketing).toContain("<router-view");
  });
});
