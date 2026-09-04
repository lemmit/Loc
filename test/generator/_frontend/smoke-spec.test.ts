// The route-driven Playwright smoke spec — `src/generator/_frontend/smoke-spec.ts`.
//
// One framework-neutral spec shared by React, Vue, Svelte, Angular, Feliz and
// the Phoenix LiveView emitter.  Two things make it worth pinning:
//
//   * it is driven BY ROUTE, never by importing the page objects.  The shape it
//     replaced emitted a per-served-aggregate
//     `import { <Agg>ListPage } from "./pages/<agg>"`, which assumes the
//     scaffold shape for every served aggregate — on a ui with custom or
//     partial pages that is a module-not-found, which Playwright reports as
//     "No tests found" and exits NON-ZERO.  A route needs no module.
//   * a ui made entirely of parameterised pages must still produce a spec with
//     at least one test, for the same non-zero-exit reason.
//
// NOTE on the selection rule.  The wave brief described this as "one assertion
// per NON-HIDDEN page"; the module does not consult `menu { hidden: true }` at
// all, and should not — `hidden` means "absent from the SIDEBAR", not
// "unreachable", and a hidden page is still a route the app must serve.  The
// actual rule, pinned below, is: skip a page with route PARAMS or a `:` in its
// route (it would need a seeded entity — that is the per-page specs' job), and
// emit one navigation assertion for every other page.

import { describe, expect, it } from "vitest";
import { smokeSpec } from "../../../src/generator/_frontend/smoke-spec.js";
import type { PageIR, UiIR } from "../../../src/ir/types/loom-ir.js";
import type { PageNameCtx } from "../../../src/ir/util/page-kind.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const CTX: PageNameCtx = { aggregateNames: ["Order"], workflowNames: [] };

// Scaffolded Order pages (list `/orders`, new `/orders/new`, detail
// `/orders/:id`, home `/`) plus a custom page inside `area Ops` and a
// `menu { hidden: true }` page.
const SRC = `
system Shop {
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
  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    area Ops {
      page Dashboard { route: "/ops/dashboard" body: Heading { "Ops" } }
    }
    page Secret { route: "/secret" menu { hidden: true } body: Heading { "Secret" } }
  }
  deployable web { platform: react targets: api ui: WebApp { Sales: api } port: 3001 }
}
`;

async function loadUi(): Promise<UiIR> {
  const model = await buildLoomModel(SRC);
  const ui = model.systems[0]?.uis[0];
  if (!ui) throw new Error("fixture emitted no ui");
  return ui;
}

const titles = (spec: string): string[] =>
  [...spec.matchAll(/^test\("([^"]+)"/gm)].map((m) => m[1] as string);
const gotos = (spec: string): string[] =>
  [...spec.matchAll(/page\.goto\("([^"]*)"\)/g)].map((m) => m[1] as string);

/** A hand-built ui — the two edge shapes no valid `.ddd` fixture can express
 *  in one file (a ui with ONLY parameterised pages; a route carrying regex
 *  metacharacters). */
const uiOf = (pages: Partial<PageIR>[]): UiIR =>
  ({
    name: "WebApp",
    pages: pages.map((p) => ({ params: [], state: [], derived: [], actions: [], ...p }) as PageIR),
    components: [],
    stores: [],
    apiParams: [],
  }) as UiIR;

describe("smokeSpec — one navigation assertion per param-less route", () => {
  it("covers every param-less page and nothing else", async () => {
    const ui = await loadUi();
    const spec = smokeSpec(ui, CTX);
    const expected = ui.pages
      .filter((p) => p.params.length === 0 && p.route && !p.route.includes(":"))
      .map((p) => p.route as string);
    expect(gotos(spec)).toEqual(expected);
    expect(gotos(spec)).toEqual(["/ops/dashboard", "/secret", "/orders", "/orders/new", "/"]);
    expect(titles(spec)).toHaveLength(expected.length);
  });

  it("skips a parameterised route — it needs a seeded entity (the per-page specs' job)", async () => {
    const ui = await loadUi();
    const spec = smokeSpec(ui, CTX);
    // `/orders/:id` exists as a page…
    expect(ui.pages.some((p) => p.route === "/orders/:id")).toBe(true);
    // …and is deliberately absent from the smoke.
    expect(spec).not.toContain("/orders/:id");
    expect(titles(spec)).not.toContain("OrderDetail loads");
  });

  it("still covers a `menu { hidden: true }` page — hidden is a SIDEBAR fact, not a route fact", async () => {
    const ui = await loadUi();
    const secret = ui.pages.find((p) => p.name === "Secret");
    expect(secret?.menuMeta?.entries.some((e) => e.name === "hidden")).toBe(true);
    expect(gotos(smokeSpec(ui, CTX))).toContain("/secret");
  });

  it("titles each test by the page's EMIT name, not its role-scoped page name", async () => {
    const ui = await loadUi();
    // `List` repeats across aggregates and `Dashboard` across areas; the emit
    // name is unique, which is what makes a test title stable + greppable.
    expect(titles(smokeSpec(ui, CTX))).toEqual([
      "OpsDashboard loads",
      "Secret loads",
      "OrderList loads",
      "OrderNew loads",
      "Home loads",
    ]);
  });

  it("asserts the URL with an END-anchored regex over the escaped route", async () => {
    const ui = await loadUi();
    const spec = smokeSpec(ui, CTX);
    expect(spec).toContain(
      'test("OrderList loads", async ({ page }) => {\n' +
        '  await page.goto("/orders");\n' +
        '  await expect(page).toHaveURL(new RegExp("/orders$"));\n' +
        "});",
    );
  });

  it("emits the fixtures import once, at the top", async () => {
    const spec = smokeSpec(await loadUi(), CTX);
    expect(spec.startsWith("// Auto-generated smoke spec.\n")).toBe(true);
    expect(spec.match(/import \{ test, expect \} from "\.\/fixtures";/g)).toHaveLength(1);
  });
});

describe("smokeSpec — the degenerate uis", () => {
  it("falls back to the SPA root when every page is parameterised (never zero tests)", () => {
    const spec = smokeSpec(
      uiOf([
        { name: "Detail", route: "/orders/:id", params: [{ name: "id" }] as PageIR["params"] },
        { name: "Edit", route: "/orders/:id/edit", params: [{ name: "id" }] as PageIR["params"] },
      ]),
      CTX,
    );
    // Zero tests is a Playwright "No tests found" → non-zero exit → a red gate
    // on a system that is perfectly fine.
    expect(titles(spec)).toEqual(["app root loads"]);
    expect(spec).toContain('await page.goto("/")');
    expect(spec).toContain('await expect(page.locator("body")).toBeVisible();');
  });

  it("falls back for a ui with no pages at all", () => {
    expect(titles(smokeSpec(uiOf([]), CTX))).toEqual(["app root loads"]);
  });

  it("skips a page with no route, and a `:`-bearing route with no declared params", () => {
    const spec = smokeSpec(
      uiOf([
        { name: "Routeless" },
        { name: "Colonic", route: "/thing/:slug" },
        { name: "Fine", route: "/fine" },
      ]),
      CTX,
    );
    expect(gotos(spec)).toEqual(["/fine"]);
  });

  it("escapes regex metacharacters in the route before anchoring", () => {
    const spec = smokeSpec(uiOf([{ name: "Docs", route: "/docs/v1.0(beta)" }]), CTX);
    // Unescaped, `.` and `(` would make `toHaveURL` match the wrong URL — or
    // throw on an unbalanced group.
    expect(spec).toContain(
      'await expect(page).toHaveURL(new RegExp("/docs/v1\\\\.0\\\\(beta\\\\)$"));',
    );
    expect(spec).toContain('await page.goto("/docs/v1.0(beta)");');
  });
});
