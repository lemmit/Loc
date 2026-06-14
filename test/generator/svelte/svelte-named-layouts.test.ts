import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Named layouts — SvelteKit route-group flavour (Phase 8, svelte).
//
// A `layout <Name> { header / main / footer }` wraps every page that
// selects it via `layout: <Name>`.  React weaves these into the App.tsx
// router; the SvelteKit-native shape is a route group `(<name>)` whose
// `+layout.svelte` renders the slots around `{@render children()}`.
// `layout: none` stays `(bare)`; the default stays `(app)`.
// ---------------------------------------------------------------------------

const SRC = `
system S {
  subdomain Shop {
    context Cart {
      aggregate Item { name: string  derived display: string = name }
      repository Items for Item { }
    }
  }
  api ShopApi from Shop
  storage primary { type: postgres }
  resource cartState { for: Cart, kind: state, use: primary }

  layout Marketing {
    header { Heading { "Acme", level: 3 } }
    main
    footer { Text { "© Acme" } }
  }

  ui Web {
    api Cart: ShopApi
    page Landing {
      route: "/"
      layout: Marketing
      body: Stack { Heading { "Welcome" } }
    }
    page Dash { route: "/dash" body: Heading { "Dashboard" } }
  }
  deployable api {
    platform: hono
    contexts: [Cart]
    dataSources: [cartState]
    serves: ShopApi
    port: 3000
  }
  deployable web {
    platform: svelte
    targets: api
    ui: Web { Cart: api }
    design: shadcnSvelte
    port: 3001
  }
}
`;

describe("svelte named layouts — route groups", () => {
  it("emits a (<name>)/+layout.svelte rendering the slots around children", async () => {
    const out = await generateSystemFiles(SRC);
    const layout = out.get("web/src/routes/(marketing)/+layout.svelte");
    expect(layout, "named layout emitted").toBeDefined();
    expect(layout).toContain("let { children } = $props();");
    expect(layout).toContain("{@render children()}");
    // header + footer slots walked to markup (Heading → <h3>, Text → <p>).
    expect(layout).toContain("Acme");
    expect(layout).toContain("© Acme");
  });

  it("routes a `layout: <Name>` page into the named group, others into (app)", async () => {
    const out = await generateSystemFiles(SRC);
    const keys = [...out.keys()];
    // Landing (layout: Marketing, route /) → the (marketing) group.
    expect(keys).toContain("web/src/routes/(marketing)/+page.svelte");
    // Dash (default layout) → the (app) chrome group.
    expect(keys).toContain("web/src/routes/(app)/dash/+page.svelte");
    // Landing did NOT land in (app).
    expect(keys).not.toContain("web/src/routes/(app)/+page.svelte");
  });

  it("emits no named-layout group when no page selects one", async () => {
    const noLayout = SRC.replace(/\n\s*layout: Marketing/, "").replace(
      /\n {2}layout Marketing \{[\s\S]*?\n {2}\}\n/,
      "\n",
    );
    const out = await generateSystemFiles(noLayout);
    expect([...out.keys()].some((k) => k.includes("(marketing)"))).toBe(false);
    // Both pages fall back to the default chrome group.
    expect(out.has("web/src/routes/(app)/+page.svelte")).toBe(true);
  });
});
