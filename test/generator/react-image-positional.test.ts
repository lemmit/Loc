// Regression: `Image { "..." }` must carry its positional arg as the image src.
//
// `emitImage` read only the NAMED `src:`/`alt:` args, so the positional form
// `Image { "/logo.png" }` (the documented display-primitive shorthand, like
// `Text { "x" }`) emitted a bare `<Image />` with no src — a blank/placeholder
// box.  The first positional now feeds `src`, matching how Text/Money/EnumBadge
// read their primary value (`named ?? positional[0]`).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const SRC = `
system Acme {
  subdomain Sales {
    context S {
      aggregate Order { sku: string }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    page Brand {
      route: "/brand"
      body: Image { "/logo.png" }
    }
  }
  storage primarySql { type: postgres }
  resource sState { for: S, kind: state, use: primarySql }
  deployable api {
    platform: hono
    contexts: [S]
    dataSources: [sState]
    serves: SalesApi
    port: 3001
  }
  deployable web_app {
    platform: static
    targets: api
    ui: WebApp { Sales: api }
    port: 5173
  }
}
`;

describe("react Image primitive — positional arg feeds src", () => {
  it("renders the positional literal as the image src, not a bare <Image />", async () => {
    const files = await generateSystemFiles(SRC);
    const page = [...files.entries()].find(([p]) => /pages\/brand\.tsx$/.test(p))?.[1];
    expect(page, "brand page").toBeDefined();
    expect(page).toContain('src="/logo.png"');
    expect(page).not.toMatch(/<Image \/>/);
  });
});
