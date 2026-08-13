// ---------------------------------------------------------------------------
// PAGE EMIT IDENTITY across the frontends.
//
// One root cause, seven symptoms: page identity was reconstructed BY CONVENTION
// from `page.name` at each consumer — `./pages/${snake(name)}`,
// `${snake(name)}_page.dart`, `e2e/pages/${snake(name)}.ts`, `<Name>Component`,
// the Feliz `Page` DU case, the Phoenix `<Name>Live` module — while lowering had
// already computed the authoritative answer on the IR node (`page.area` →
// `page.emitPath`).  `page.name` is unique only WITHIN one area scope, so every
// one of those sites either diverged from the file the page emitter actually
// wrote, or collided with a same-named page in another area.
//
// No `.ddd` in the repo hand-authored an `area { … }` block (every area came
// from `with scaffold(...)`, which only emits flat single-level ones), so the
// whole family shipped uncovered.  These are the regression pins; the compile
// half lives in the per-PR frontend build gates, which now see a nested area
// through `web/src/examples/dashboard-system.ddd`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** Two custom pages sharing ONE name across two sibling areas — legal `.ddd`
 *  (page uniqueness is per scope, `checkPageScope`), and the shape that broke
 *  Angular, Feliz, Phoenix, Flutter and the Playwright page objects. */
const DUPLICATE_NAME_ACROSS_AREAS = (extraDeployables: string) => `
  system AreaProbe {
    subdomain Sales {
      context Orders {
        aggregate Order { code: string  derived display: string = code }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    storage pg { type: postgres }
    resource ordersState { for: Orders, kind: state, use: pg }
    ui WebApp {
      api Sales: SalesApi
      area Ops {
        page Dashboard {
          route: "/ops/dashboard"
          body: Stack { Heading { "Ops dashboard", level: 1 }, testid: "ops-dashboard" }
        }
      }
      area Finance {
        page Dashboard {
          route: "/finance/dashboard"
          body: Stack { Heading { "Finance dashboard", level: 1 }, testid: "finance-dashboard" }
        }
      }
    }
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], serves: SalesApi, port: 8080 }
    ${extraDeployables}
  }
`;

/** A scaffold over TWO aggregates — the pages are ROLE-named (`List` inside
 *  `area Products` / `area Customers`), so a consumer keying on `page.name`
 *  collapses every aggregate onto one artefact.  This needs no hand-authored
 *  area at all: it fires on plain `with scaffold(...)`. */
const TWO_AGGREGATE_SCAFFOLD = (extraDeployables: string) => `
  system Shop {
    subdomain Sales {
      context Orders {
        aggregate Product with crudish { name: string  price: money }
        aggregate Customer with crudish { name: string  email: string }
        repository Products for Product { }
        repository Customers for Customer { }
      }
    }
    api ShopApi from Sales
    storage pg { type: postgres }
    resource ordersState { for: Orders, kind: state, use: pg }
    ui App with scaffold(aggregates: [Product, Customer]) { api Shop: ShopApi }
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], serves: ShopApi, port: 3000 }
    ${extraDeployables}
  }
`;

const REACT = `deployable web { platform: react, targets: api, ui: WebApp { Sales: api }, port: 3001 }`;
const ANGULAR = `deployable ng { platform: angular, targets: api, ui: WebApp { Sales: api }, port: 3002 }`;
const FELIZ = `deployable fs { platform: feliz, targets: api, ui: WebApp { Sales: api }, port: 3003 }`;
const SVELTE = `deployable sv { platform: svelte, targets: api, ui: WebApp { Sales: api }, port: 3004 }`;
const FLUTTER_APP = `deployable fl { platform: flutter, targets: api, ui: App { Shop: api }, port: 3005 }`;
const FLUTTER_WEB = `deployable fl { platform: flutter, targets: api, ui: WebApp { Sales: api }, port: 3005 }`;

// ---------------------------------------------------------------------------
// D1 — React's router import must follow `emitPath`, not `page.name`.
// ---------------------------------------------------------------------------

describe("D1 — React router imports the module the page emitter wrote", () => {
  const NESTED = `
    system Nested {
      subdomain Sales {
        context Orders {
          aggregate Order { code: string  derived display: string = code }
          repository Orders for Order { }
        }
      }
      api SalesApi from Sales
      storage pg { type: postgres }
      resource ordersState { for: Orders, kind: state, use: pg }
      ui WebApp {
        api Sales: SalesApi
        area Ops {
          page Dashboard {
            route: "/dashboard"
            body: Stack { Heading { "Dash", level: 1 }, testid: "dash" }
          }
          area Billing {
            page Invoices {
              route: "/ops/billing/invoices"
              body: Stack { Heading { "Invoices", level: 1 }, testid: "invoices" }
            }
          }
        }
      }
      deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], serves: SalesApi, port: 8080 }
      ${REACT}
    }
  `;

  it("imports one and two levels of area at their real paths", async () => {
    const files = await generateSystemFiles(NESTED);
    const app = files.get("web/src/App.tsx")!;

    // The files the page emitter actually wrote.
    expect(files.has("web/src/pages/ops/dashboard.tsx")).toBe(true);
    expect(files.has("web/src/pages/ops/billing/invoices.tsx")).toBe(true);

    // …and the imports that must resolve against them.  `./pages/dashboard`
    // was the shipped bug: TS2307, an app that does not compile.
    expect(app).toContain('from "./pages/ops/dashboard"');
    expect(app).toContain('from "./pages/ops/billing/invoices"');
    expect(app).not.toContain('from "./pages/dashboard"');
    expect(app).not.toContain('from "./pages/invoices"');
  });

  it("names the imported component exactly as the page module exports it", async () => {
    const files = await generateSystemFiles(NESTED);
    const app = files.get("web/src/App.tsx")!;
    const dash = files.get("web/src/pages/ops/dashboard.tsx")!;
    const invoices = files.get("web/src/pages/ops/billing/invoices.tsx")!;

    expect(dash).toContain("export default function OpsDashboard(");
    expect(invoices).toContain("export default function OpsBillingInvoices(");
    expect(app).toContain('import OpsDashboard from "./pages/ops/dashboard"');
    expect(app).toContain('import OpsBillingInvoices from "./pages/ops/billing/invoices"');
  });
});

// ---------------------------------------------------------------------------
// D2 — an area-placed override of a scaffold page must not be orphaned.
// ---------------------------------------------------------------------------

describe("D2 — the App shell imports where the conventional page really landed", () => {
  it("routes /orders at the author's area-placed List page, not the conventional path", async () => {
    // Only ONE list page for Order here — the ui declares no scaffold, so
    // nothing competes for the slot; the shell must still find it at its area
    // path rather than rebuilding `./pages/orders/list` by convention.
    const files = await generateSystemFiles(`
      system Override {
        subdomain Sales {
          context Orders {
            aggregate Order with crudish { code: string  derived display: string = code }
            repository Orders for Order { }
          }
        }
        api SalesApi from Sales
        storage pg { type: postgres }
        resource ordersState { for: Orders, kind: state, use: pg }
        ui WebApp with scaffold(aggregates: [Order]) {
          api Sales: SalesApi
          area Sales {
            area Orders {
              page Detail {
                route: "/orders/:id"
                body: Stack { Heading { "My own order detail", level: 1 }, testid: "my-detail" }
              }
            }
          }
        }
        deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], serves: SalesApi, port: 8080 }
        ${REACT}
      }
    `);
    const app = files.get("web/src/App.tsx")!;
    expect(files.has("web/src/pages/sales/orders/detail.tsx")).toBe(true);
    // The author's page is what /orders/:id mounts.  Importing
    // `./pages/orders/detail` here left the authored page a dead file with no
    // tsc error anywhere — the silent one.
    expect(app).toContain('import OrderDetail from "./pages/sales/orders/detail"');
  });
});

// ---------------------------------------------------------------------------
// D3 — Flutter: per-aggregate scaffold pages must be distinct.
// ---------------------------------------------------------------------------

describe("D3 — Flutter scaffold pages are per-aggregate, not per-role", () => {
  it("emits a distinct page file + widget class per aggregate", async () => {
    const files = await generateSystemFiles(TWO_AGGREGATE_SCAFFOLD(FLUTTER_APP));
    const pages = [...files.keys()].filter((k) => k.startsWith("fl/lib/pages/"));

    // The bug: ONE `list_page.dart` (last aggregate wins) serving both routes.
    expect(pages).toContain("fl/lib/pages/product_list_page.dart");
    expect(pages).toContain("fl/lib/pages/customer_list_page.dart");
    expect(pages).not.toContain("fl/lib/pages/list_page.dart");

    const main = files.get("fl/lib/main.dart")!;
    expect(main).toContain("'/products': (context) => const ProductListPage()");
    expect(main).toContain("'/customers': (context) => const CustomerListPage()");

    // Every import URI exactly once — a repeat means two pages resolved to one
    // module.  `flutter analyze` grades a duplicate import an INFO, and CI runs
    // `--no-fatal-infos`, so the build stayed green on this.
    const imports = main.split("\n").filter((l) => l.startsWith("import 'pages/"));
    expect(new Set(imports).size).toBe(imports.length);
  });

  it("gives each page's Riverpod triad its own top-level identifiers", async () => {
    const files = await generateSystemFiles(TWO_AGGREGATE_SCAFFOLD(FLUTTER_APP));
    const product = files.get("fl/lib/pages/product_list_page.dart")!;
    const customer = files.get("fl/lib/pages/customer_list_page.dart")!;
    // `main.dart` imports every page file, so two `final listProvider`
    // declarations land in one import scope.
    expect(product).toContain("final productListProvider =");
    expect(customer).toContain("final customerListProvider =");
    expect(product).not.toContain("final listProvider =");
    expect(customer).not.toContain("final listProvider =");
  });

  it("keeps same-named custom pages in different areas apart", async () => {
    const files = await generateSystemFiles(DUPLICATE_NAME_ACROSS_AREAS(FLUTTER_WEB));
    expect(files.has("fl/lib/pages/ops_dashboard_page.dart")).toBe(true);
    expect(files.has("fl/lib/pages/finance_dashboard_page.dart")).toBe(true);
    expect(files.has("fl/lib/pages/dashboard_page.dart")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D4 — Phoenix/HEEx: one LiveView module per page.
// ---------------------------------------------------------------------------

describe("D4 — Phoenix emits one LiveView module per page", () => {
  const PHOENIX = `
    system PhxProbe {
      subdomain Sales {
        context Orders {
          aggregate Order { code: string  derived display: string = code }
          repository Orders for Order { }
        }
      }
      api SalesApi from Sales
      storage pg { type: postgres }
      resource ordersState { for: Orders, kind: state, use: pg }
      ui WebApp {
        api Sales: SalesApi
        area Ops {
          page Dashboard {
            route: "/ops/dashboard"
            body: Stack { Heading { "Ops", level: 1 }, testid: "ops" }
          }
        }
        area Finance {
          page Dashboard {
            route: "/finance/dashboard"
            body: Stack { Heading { "Finance", level: 1 }, testid: "finance" }
          }
        }
      }
      deployable phx {
        platform: elixir, contexts: [Orders], dataSources: [ordersState],
        serves: SalesApi, ui: WebApp { Sales: phx }, port: 4000
      }
    }
  `;

  it("does not collapse two same-named pages onto one *_live.ex", async () => {
    const files = await generateSystemFiles(PHOENIX);
    const live = [...files.keys()].filter((k) => k.includes("_web/live/"));
    expect(live).toContain("phx/lib/phx_web/live/ops_dashboard_live.ex");
    expect(live).toContain("phx/lib/phx_web/live/finance_dashboard_live.ex");
    expect(live).not.toContain("phx/lib/phx_web/live/dashboard_live.ex");

    const router = files.get("phx/lib/phx_web/router.ex")!;
    expect(router).toContain('live "/ops/dashboard", OpsDashboardLive');
    expect(router).toContain('live "/finance/dashboard", FinanceDashboardLive');
  });
});

// ---------------------------------------------------------------------------
// D6 — Angular / Feliz duplicate identifiers (the LOUD half).
// ---------------------------------------------------------------------------

describe("D6 — same-named pages across areas do not produce duplicate identifiers", () => {
  it("Angular: one component class + one module per page (TS2300)", async () => {
    const files = await generateSystemFiles(DUPLICATE_NAME_ACROSS_AREAS(ANGULAR));
    const routes = files.get("ng/src/app/app.routes.ts")!;
    const imports = routes.split("\n").filter((l) => l.startsWith("import {"));
    expect(new Set(imports).size).toBe(imports.length);
    expect(routes).toContain("OpsDashboardComponent");
    expect(routes).toContain("FinanceDashboardComponent");
    expect(files.has("ng/src/app/pages/ops-dashboard.component.ts")).toBe(true);
    expect(files.has("ng/src/app/pages/finance-dashboard.component.ts")).toBe(true);
  });

  it("Feliz: distinct Page union cases and view functions", async () => {
    const files = await generateSystemFiles(DUPLICATE_NAME_ACROSS_AREAS(FELIZ));
    const app = files.get("fs/src/App.fs")!;
    const cases = app
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^\| [A-Z][A-Za-z0-9]*$/.test(l));
    expect(new Set(cases).size).toBe(cases.length);
    expect(app).toContain("| OpsDashboard");
    expect(app).toContain("| FinanceDashboard");
    expect(app).toContain("opsDashboardView");
    expect(app).toContain("financeDashboardView");
  });

  it("React: distinct component identifiers", async () => {
    const files = await generateSystemFiles(DUPLICATE_NAME_ACROSS_AREAS(REACT));
    const app = files.get("web/src/App.tsx")!;
    expect(app).toContain('import OpsDashboard from "./pages/ops/dashboard"');
    expect(app).toContain('import FinanceDashboard from "./pages/finance/dashboard"');
    const imports = app.split("\n").filter((l) => l.startsWith("import "));
    expect(new Set(imports).size).toBe(imports.length);
  });
});

// ---------------------------------------------------------------------------
// D7 — Playwright page objects: first-wins drop.
// ---------------------------------------------------------------------------

describe("D7 — every custom page gets its own Playwright page object", () => {
  it("React does not drop the second same-named page's object", async () => {
    const files = await generateSystemFiles(DUPLICATE_NAME_ACROSS_AREAS(REACT));
    const objects = [...files.keys()].filter((k) => k.startsWith("web/e2e/pages/"));
    expect(objects).toContain("web/e2e/pages/ops_dashboard.ts");
    expect(objects).toContain("web/e2e/pages/finance_dashboard.ts");
    // The old path — one file, first page wins, second silently dropped while
    // `smoke.spec.ts` (route-keyed) still emitted BOTH tests.
    expect(objects).not.toContain("web/e2e/pages/dashboard.ts");
    // …and each object drives its own route.
    expect(files.get("web/e2e/pages/ops_dashboard.ts")!).toContain("/ops/dashboard");
    expect(files.get("web/e2e/pages/finance_dashboard.ts")!).toContain("/finance/dashboard");
  });

  it("Svelte does not drop the second same-named page's object", async () => {
    const files = await generateSystemFiles(DUPLICATE_NAME_ACROSS_AREAS(SVELTE));
    const objects = [...files.keys()].filter((k) => k.startsWith("sv/e2e/pages/"));
    expect(objects).toContain("sv/e2e/pages/ops_dashboard.ts");
    expect(objects).toContain("sv/e2e/pages/finance_dashboard.ts");
    expect(objects).not.toContain("sv/e2e/pages/dashboard.ts");
  });
});

// ---------------------------------------------------------------------------
// The byte-identity guard.  Every fix above changes an identifier ONLY when the
// page carries an `area`; the whole shipped corpus is area-less at the top
// level, so an area-less custom page must keep the exact names it had.
// ---------------------------------------------------------------------------

describe("area-less pages keep their pre-existing identifiers", () => {
  it("emits ./pages/<snake> + <Name> + e2e/pages/<snake> for a top-level page", async () => {
    const files = await generateSystemFiles(`
      system Flat {
        subdomain Sales {
          context Orders {
            aggregate Order { code: string  derived display: string = code }
            repository Orders for Order { }
          }
        }
        api SalesApi from Sales
        storage pg { type: postgres }
        resource ordersState { for: Orders, kind: state, use: pg }
        ui WebApp {
          api Sales: SalesApi
          page Dashboard {
            route: "/dashboard"
            body: Stack { Heading { "Dash", level: 1 }, testid: "dash" }
          }
        }
        deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], serves: SalesApi, port: 8080 }
        ${REACT}
      }
    `);
    expect(files.has("web/src/pages/dashboard.tsx")).toBe(true);
    expect(files.has("web/e2e/pages/dashboard.ts")).toBe(true);
    expect(files.get("web/src/App.tsx")!).toContain('import Dashboard from "./pages/dashboard"');
  });
});
