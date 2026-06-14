import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Money in page `state {}` — the Decimal import + decimal.js dep.
//
// A money-typed state field renders as `<Decimal>` + `new Decimal("0")`
// (react useState / svelte $state / vue ref).  Before this fix the
// shells emitted the `Decimal` reference without importing decimal.js,
// and `contextUsesMoney` (aggregate/wire-shape only) never flipped the
// package.json dep — so the bundle didn't compile.  These pin the import
// + dep across all three JS-family frontends.  (Money in page state is
// niche, so no shipped example exercises it; output stays byte-identical
// vs main.)
// ---------------------------------------------------------------------------

function sysFor(platform: string, design: string): string {
  return `
system MoneyState {
  subdomain Shop {
    context Cart {
      aggregate Item { name: string  derived display: string = name }
      repository Items for Item { }
    }
  }
  api ShopApi from Shop
  storage primary { type: postgres }
  resource cartState { for: Cart, kind: state, use: primary }
  ui Web {
    api Cart: ShopApi
    page Home {
      route: "/"
      state { total: money }
      body: Stack { Heading { "Total" }, Text { total } }
    }
  }
  deployable api {
    platform: hono
    contexts: [Cart]
    dataSources: [cartState]
    serves: ShopApi
    port: 3000
  }
  deployable web {
    platform: ${platform}
    targets: api
    ui: Web { Cart: api }
    design: ${design}
    port: 3001
  }
}
`;
}

describe("money page-state pulls in decimal.js (import + dep)", () => {
  it("react: page imports Decimal and package.json carries decimal.js", async () => {
    const out = await generateSystemFiles(sysFor("static", "mantine"));
    const page = out.get("web/src/pages/home.tsx") ?? "";
    expect(page).toContain('import Decimal from "decimal.js";');
    expect(page).toContain('useState<Decimal>(new Decimal("0"))');
    expect(out.get("web/package.json") ?? "").toContain('"decimal.js"');
  });

  it("svelte: page imports Decimal and package.json carries decimal.js", async () => {
    const out = await generateSystemFiles(sysFor("svelte", "shadcnSvelte"));
    const page = out.get("web/src/routes/(app)/+page.svelte") ?? "";
    expect(page).toContain('import Decimal from "decimal.js";');
    expect(page).toContain('new Decimal("0")');
    expect(out.get("web/package.json") ?? "").toContain('"decimal.js"');
  });

  it("vue: page imports Decimal and package.json carries decimal.js", async () => {
    const out = await generateSystemFiles(sysFor("vue", "vuetify"));
    const page = out.get("web/src/pages/home.vue") ?? "";
    expect(page).toContain('import Decimal from "decimal.js";');
    expect(page).toContain('new Decimal("0")');
    expect(out.get("web/package.json") ?? "").toContain('"decimal.js"');
  });
});
