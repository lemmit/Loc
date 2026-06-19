// Regression: a UI `menu` external link (`link "X" -> "https://…"`) must render
// as a real external anchor, not a React-Router `<NavLink to="__external:…">`.
//
// The menu emitter injects a sentinel `__external:<url>` token into the nav
// entry's `to` (shared with the Phoenix sidebar, which slices it).  The React
// app-shell templates rendered that token verbatim into a `<NavLink to=…>`, so
// clicking "Status page" pushed the literal string `__external:https://…` onto
// the router and landed on NotFound.  No test covered the external-link path.
//
// The nav VM now carries `external` + a clean `href`; every React pack renders
// external entries as a plain anchor (`target="_blank" rel="noreferrer"`).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const src = (design: string) => `
system S {
  subdomain M {
    context Sales {
      aggregate Order with crudish { sku: string }
      repository Orders for Order { }
    }
  }
  api SalesApi from M
  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    menu {
      section "Platform" {
        link "Status page" -> "https://status.example.com"
      }
    }
  }
  storage primarySql { type: postgres }
  deployable api {
    platform: node
    contexts: [Sales]
    serves: SalesApi
    port: 3001
  }
  deployable web_app {
    platform: static
    targets: api
    ui: WebApp { Sales: api }
    port: 5173
    design: ${design}
  }
}
`;

describe.each(["mantine", "shadcn"])("react (%s) — menu external link", (design) => {
  it("renders a real external anchor, not a NavLink to the __external: sentinel", async () => {
    const files = await generateSystemFiles(src(design));
    const app = files.get("web_app/src/App.tsx");
    expect(app, "App.tsx").toBeDefined();
    // The sentinel must never reach the wire.
    expect(app).not.toContain("__external:");
    // A real external link: the URL as an href, opened in a new tab.
    expect(app).toContain('href="https://status.example.com"');
    expect(app).toContain('target="_blank"');
    expect(app).toContain('rel="noreferrer"');
  });
});
