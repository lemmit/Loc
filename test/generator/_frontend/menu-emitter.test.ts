// The sidebar derivation — `src/generator/_frontend/menu-emitter.ts`.
//
// `deriveSidebarFromUi` is the ONE menu driver all five ui-bearing targets
// share (React, Vue, Svelte, Angular and the Phoenix sidebar), so a divergence
// here is a divergence everywhere.  It has two surface forms and returns
// `undefined` for neither-of-the-above (the caller then falls back to the
// hard-coded aggregate/workflow grouping):
//
//   1. an explicit `ui.menu { section "S" { link P } }` — authoritative,
//      walked link-by-link;
//   2. no menu block → the per-page `menu { section:, label:, order:, hidden: }`
//      metadata on CUSTOM pages, grouped by section.
//
// The load-bearing property (first describe below) is the one that makes a
// generated app compile and navigate: every entry the menu emits must point at
// a page the frontend actually emitted a module for.  A nav link to a page that
// was never written is a dangling route at runtime; a nav link whose page the
// shell imports from a reconstructed path is TS2307 at build time.

import { describe, expect, it } from "vitest";
import { deriveSidebarFromUi } from "../../../src/generator/_frontend/menu-emitter.js";
import {
  buildPageModuleIndex,
  pageModuleSpecifier,
} from "../../../src/generator/_frontend/page-identity.js";
import type { PageIR, UiIR } from "../../../src/ir/types/loom-ir.js";
import { classifyPage, type PageNameCtx, pageSlotKey } from "../../../src/ir/util/page-kind.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const CTX: PageNameCtx = { aggregateNames: ["Order"], workflowNames: [] };

const HEAD = `
  subdomain Sales {
    context Orders {
      aggregate Order with crudish { code: string }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource st { for: Orders, kind: state, use: primary }
  deployable api { platform: node contexts: [Orders] serves: SalesApi dataSources: [st] port: 8080 }
`;

// Explicit `menu { … }`, over the whole matrix an entry can be: an
// area-qualified custom page, a scaffolded (slotted) page reached by its
// qualified name, a page carrying `menu { hidden: true }`, and an external URL.
const EXPLICIT = `
system Shop {
${HEAD}
  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    area Ops {
      page Dashboard { route: "/ops/dashboard" title: "Ops dashboard" body: Heading { "Ops" } }
    }
    page Secret { route: "/secret" menu { hidden: true } body: Heading { "Secret" } }
    menu {
      section "Main" {
        link Ops.Dashboard,
        link Orders.List { label: "All orders" },
        link Secret,
        link "Docs" -> "https://example.com/docs"
      }
    }
  }
  deployable web { platform: react targets: api ui: WebApp { Sales: api } port: 3001 }
}
`;

// No `ui.menu` — the per-page `menuMeta` fallback driver, with a hidden page,
// two ordered siblings in one section and one page with no section at all.
const FALLBACK = `
system Shop2 {
${HEAD}
  ui WebApp {
    api Sales: SalesApi
    page Beta { route: "/beta" menu { section: "Ops", label: "Beta", order: 2 } body: Heading { "b" } }
    page Alpha { route: "/alpha" menu { section: "Ops", label: "Alpha", order: 1 } body: Heading { "a" } }
    page Ghost { route: "/ghost" menu { section: "Ops", label: "Ghost", hidden: true } body: Heading { "g" } }
    page Loose { route: "/loose" menu { } body: Heading { "l" } }
  }
  deployable web { platform: react targets: api ui: WebApp { Sales: api } port: 3001 }
}
`;

// Scaffold-only: every page is a slotted archetype, so the fallback driver has
// nothing eligible and the caller must get its default grouping back.
const SCAFFOLD_ONLY = `
system Shop3 {
${HEAD}
  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
  }
  deployable web { platform: react targets: api ui: WebApp { Sales: api } port: 3001 }
}
`;

async function loadUi(source: string): Promise<UiIR> {
  const model = await buildLoomModel(source);
  const ui = model.systems[0]?.uis[0];
  if (!ui) throw new Error("fixture emitted no ui");
  return ui;
}

/** The page an entry actually links to.  `NavEntryVM` carries no page handle —
 *  its identity IS the resolved route (`to`), which is what the router matches
 *  — so this is the accessor every "does this link go anywhere" question goes
 *  through. */
const pageOfEntry = (ui: UiIR, to: string): PageIR | undefined =>
  ui.pages.find((p) => (p.route ?? "") === to);

describe("deriveSidebarFromUi — every menu entry resolves to an EMITTED module", () => {
  it("links only to pages the frontend wrote a module for", async () => {
    const ui = await loadUi(EXPLICIT);
    const sections = deriveSidebarFromUi(ui, CTX);
    expect(sections).toBeDefined();
    const entries = (sections ?? []).flatMap((s) => s.entries);
    expect(entries.length).toBeGreaterThan(0);
    const index = buildPageModuleIndex(ui, CTX);

    for (const entry of entries) {
      if (entry.external) {
        // An off-site link resolves to no page at all — by construction it
        // needs no module.
        expect(entry.href).toMatch(/^https?:\/\//);
        continue;
      }
      const page = pageOfEntry(ui, entry.to);
      // (a) the route the entry navigates to is a route this ui declares.
      expect(page, `menu entry "${entry.label}" → ${entry.to} matches no page`).toBeDefined();
      if (!page) continue;
      // (b) the module that page emits is one the shell can reach.  Two
      //     mount paths, and the entry must be on one of them:
      //       - a SLOTTED page is imported through `buildPageModuleIndex`;
      //       - a `custom` page has no slot (`pageSlotKey` → undefined) and is
      //         mounted directly at its own specifier.
      //     Note this is why the property is NOT `index.has(slot)` for every
      //     entry: a custom page is legitimately absent from the index.
      const slot = pageSlotKey(classifyPage(page, CTX));
      if (slot === undefined) {
        expect(pageModuleSpecifier(page)).toMatch(/^\.\/pages\//);
      } else {
        expect(index.has(slot)).toBe(true);
        expect(index.get(slot)).toBe(pageModuleSpecifier(page));
      }
    }
  });

  it("holds for the fallback (menuMeta) driver too", async () => {
    const ui = await loadUi(FALLBACK);
    const sections = deriveSidebarFromUi(ui, CTX) ?? [];
    for (const entry of sections.flatMap((s) => s.entries)) {
      const page = pageOfEntry(ui, entry.to);
      expect(page, `menu entry "${entry.label}" → ${entry.to} matches no page`).toBeDefined();
    }
  });
});

describe("deriveSidebarFromUi — explicit `menu { … }` block", () => {
  it("emits the authored sections + links in source order", async () => {
    const ui = await loadUi(EXPLICIT);
    const sections = deriveSidebarFromUi(ui, CTX) ?? [];
    expect(sections.map((s) => s.label)).toEqual(["Main"]);
    expect(sections[0]?.entries.map((e) => e.to)).toEqual([
      "/ops/dashboard",
      "/orders",
      "/secret",
      "__external:https://example.com/docs",
    ]);
  });

  it("labels: link `label:` > page menuMeta label > page title > page name", async () => {
    const ui = await loadUi(EXPLICIT);
    const entries = (deriveSidebarFromUi(ui, CTX) ?? []).flatMap((s) => s.entries);
    // `link Orders.List { label: "All orders" }` — the link's own override.
    expect(entries.find((e) => e.to === "/orders")?.label).toBe("All orders");
    // No override, no menuMeta label → the page's string-literal `title:`.
    expect(entries.find((e) => e.to === "/ops/dashboard")?.label).toBe("Ops dashboard");
    // Neither → the page name.
    expect(entries.find((e) => e.to === "/secret")?.label).toBe("Secret");
  });

  it("carries a catalog key only for AUTHORED labels (A13b)", async () => {
    const ui = await loadUi(EXPLICIT);
    const sections = deriveSidebarFromUi(ui, CTX) ?? [];
    const entries = sections.flatMap((s) => s.entries);
    // The section heading is authored → keyed under the `menu` prefix.
    expect(sections[0]?.labelKey).toMatch(/^menu\.section\./);
    // An authored link `label:` → keyed; the extraction pass records the same.
    expect(entries.find((e) => e.to === "/orders")?.labelKey).toMatch(/^menu\.link\./);
    expect(entries.find((e) => e.external)?.labelKey).toMatch(/^menu\.link\./);
    // A DERIVED label (page title / page name) is not in the catalog, so it
    // carries no key — a key that resolves to nothing is the dead-key defect.
    expect(entries.find((e) => e.to === "/ops/dashboard")?.labelKey).toBeUndefined();
    expect(entries.find((e) => e.to === "/secret")?.labelKey).toBeUndefined();
  });

  it("renders an external link as an anchor payload, never a router target", async () => {
    const ui = await loadUi(EXPLICIT);
    const ext = (deriveSidebarFromUi(ui, CTX) ?? [])
      .flatMap((s) => s.entries)
      .find((e) => e.external);
    expect(ext).toMatchObject({
      to: "__external:https://example.com/docs",
      external: true,
      href: "https://example.com/docs",
      label: "Docs",
      testId: "nav-ext-docs",
      activeArgs: `""`,
    });
  });

  it("test ids: archetype-derived for a slotted page, AREA-QUALIFIED for a custom one", async () => {
    const ui = await loadUi(EXPLICIT);
    const entries = (deriveSidebarFromUi(ui, CTX) ?? []).flatMap((s) => s.entries);
    expect(entries.find((e) => e.to === "/orders")?.testId).toBe("nav-orders");
    // `nav-dashboard` would be ambiguous across sibling areas (Playwright
    // strict mode matches two links) — the area is folded in.
    expect(entries.find((e) => e.to === "/ops/dashboard")?.testId).toBe("nav-ops_dashboard");
    expect(entries.find((e) => e.to === "/orders")?.activeArgs).toBe(`"/orders"`);
    expect(entries.find((e) => e.to === "/ops/dashboard")?.activeArgs).toBe(`"/ops/dashboard"`);
  });

  it("an explicitly LINKED page appears even when it declares `menu { hidden: true }`", async () => {
    // Pinned as ACTUAL behaviour, and it is the intended one: under an explicit
    // menu block, membership is by INCLUSION — the author lists what the
    // sidebar shows, so omitting a link is how a page is hidden
    // (`examples/sales-ui.ddd` § 8: "Same effect as `menu { hidden: true }`,
    // applied via omission rather than declaration").  The `hidden` filter is
    // therefore scoped to the fallback driver alone (menu-emitter.ts:130-133),
    // where nothing else expresses the author's intent.
    const ui = await loadUi(EXPLICIT);
    const secret = ui.pages.find((p) => p.name === "Secret");
    expect(secret?.menuMeta?.entries.some((e) => e.name === "hidden")).toBe(true);
    const entries = (deriveSidebarFromUi(ui, CTX) ?? []).flatMap((s) => s.entries);
    expect(entries.map((e) => e.to)).toContain("/secret");
  });
});

describe("deriveSidebarFromUi — the menuMeta fallback grouping", () => {
  it("groups CUSTOM pages by `section`, ordering each group by `order:`", async () => {
    const ui = await loadUi(FALLBACK);
    const sections = deriveSidebarFromUi(ui, CTX) ?? [];
    expect(sections.map((s) => s.label)).toEqual(["Ops", ""]);
    // `order: 1` before `order: 2` — declaration order in the source is
    // Beta-then-Alpha, so this is the sort, not the source order.
    expect(sections[0]?.entries.map((e) => e.label)).toEqual(["Alpha", "Beta"]);
    // A page with a `menu { }` block but no section joins the unnamed group.
    expect(sections[1]?.entries.map((e) => e.to)).toEqual(["/loose"]);
    expect(sections[1]?.labelKey).toBeUndefined();
  });

  it("DROPS a page declaring `menu { hidden: true }`", async () => {
    const ui = await loadUi(FALLBACK);
    const sections = deriveSidebarFromUi(ui, CTX) ?? [];
    const entries = sections.flatMap((s) => s.entries);
    // The page exists (it has a route, it is emitted, it is reachable) — it is
    // only absent from the SIDEBAR.
    expect(ui.pages.some((p) => p.name === "Ghost")).toBe(true);
    expect(entries.map((e) => e.to)).not.toContain("/ghost");
    expect(entries.map((e) => e.label)).not.toContain("Ghost");
    expect(entries.map((e) => e.to)).toEqual(["/alpha", "/beta", "/loose"]);
  });

  it("keys the section heading under the FIRST page of the sorted group", async () => {
    const ui = await loadUi(FALLBACK);
    const sections = deriveSidebarFromUi(ui, CTX) ?? [];
    // Alpha sorts first, so the heading's key rides Alpha's prefix — every
    // page in the group carries the same message, so any one of them keys it.
    expect(sections[0]?.labelKey).toMatch(/^page\.Alpha\.menu\.section\./);
    expect(sections[0]?.entries[0]?.labelKey).toMatch(/^page\.Alpha\.menu\.label\./);
  });

  it("returns undefined when nothing drives a sidebar (caller keeps its default)", async () => {
    const ui = await loadUi(SCAFFOLD_ONLY);
    // Every page here is a slotted archetype, so none is `custom` — the
    // fallback driver is deliberately restricted to hand-written pages so
    // scaffold defaults never pre-empt the app shell's own grouping.
    expect(ui.pages.length).toBeGreaterThan(0);
    expect(deriveSidebarFromUi(ui, CTX)).toBeUndefined();
  });
});
