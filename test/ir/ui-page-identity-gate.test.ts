// ---------------------------------------------------------------------------
// The LANGUAGE-LAYER half of the page-emit-identity family.
//
// Two pages that resolve to one emit path (or to one scaffold archetype slot)
// are indistinguishable to every frontend, and every frontend resolved that the
// same silent way: last write wins on the file map, first write wins on the
// page-object map.  Before these gates, a duplicated `area Ops { … }` block in
// one scope parsed clean — `checkPageScope` scoped page uniqueness per area
// NODE, not per area NAME — and one page's body simply vanished from the build
// with no diagnostic anywhere.
//
// The emitPath check lives in the IR layer on purpose: it covers React, Vue,
// Svelte, Angular, Feliz, Flutter and Phoenix at once, rather than seven
// per-frontend guards each catching its own topology's half.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function irErrors(source: string, code: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === code)
    .map((d) => d.message);
}

/** Langium-side (AST) diagnostics for a source, by code. */
async function astErrors(source: string, code: string): Promise<string[]> {
  const { doc } = await parseString(source);
  return (doc.diagnostics ?? [])
    .filter((d) => d.severity === 1 && d.code === code)
    .map((d) => d.message);
}

const PRELUDE = `
  subdomain Sales {
    context Orders {
      aggregate Order { code: string  derived display: string = code }
      repository Orders for Order { }
      workflow ship {
        create(code: string) { precondition code.length > 0 }
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
`;

const TAIL = `
  deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], serves: SalesApi, port: 8080 }
  deployable web { platform: react, targets: api, ui: WebApp { Sales: api }, port: 3001 }
`;

// ---------------------------------------------------------------------------
// `loom.ui-duplicate-area`
// ---------------------------------------------------------------------------

describe("loom.ui-duplicate-area", () => {
  const DUPLICATE = `
    system Dup {
      ${PRELUDE}
      ui WebApp {
        api Sales: SalesApi
        area Ops {
          page Dashboard { route: "/ops/a" body: Stack { Heading { "A", level: 1 }, testid: "a" } }
        }
        area Ops {
          page Overview { route: "/ops/b" body: Stack { Heading { "B", level: 1 }, testid: "b" } }
        }
      }
      ${TAIL}
    }
  `;

  it("rejects two same-named area blocks in one scope", async () => {
    const errs = await astErrors(DUPLICATE, "loom.ui-duplicate-area");
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("Duplicate area 'Ops' in ui 'WebApp'");
  });

  it("accepts distinct sibling areas and a nested area of the same name", async () => {
    // `area Ops { area Ops { … } }` is DIFFERENT scopes — the paths differ
    // (`ops` vs `ops/ops`), so no page can collide.  The check is per scope.
    const errs = await astErrors(
      `
      system Ok {
        ${PRELUDE}
        ui WebApp {
          api Sales: SalesApi
          area Ops {
            page Dashboard { route: "/ops/a" body: Stack { Heading { "A", level: 1 }, testid: "a" } }
            area Ops {
              page Dashboard { route: "/ops/ops/a" body: Stack { Heading { "B", level: 1 }, testid: "b" } }
            }
          }
          area Finance {
            page Dashboard { route: "/finance/a" body: Stack { Heading { "C", level: 1 }, testid: "c" } }
          }
        }
        ${TAIL}
      }
    `,
      "loom.ui-duplicate-area",
    );
    expect(errs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `loom.ui-page-path-collision`
// ---------------------------------------------------------------------------

describe("loom.ui-page-path-collision", () => {
  it("rejects an area-placed page that lands on a scaffold page's conventional path", async () => {
    // `area Workflows { page Ship }` → `src/pages/workflows/ship.tsx`, which is
    // exactly where the scaffold's `ShipWorkflow` page goes.  The two pages
    // classify DIFFERENTLY (one custom, one workflow-form), so only the path
    // check sees this one.
    const errs = await irErrors(
      `
      system Clash {
        ${PRELUDE}
        ui WebApp with scaffold(workflows: [ship]) {
          api Sales: SalesApi
          area Workflows {
            page Ship {
              route: "/workflows/ship-custom"
              body: Stack { Heading { "Custom", level: 1 }, testid: "ship" }
            }
          }
        }
        ${TAIL}
      }
    `,
      "loom.ui-page-path-collision",
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("src/pages/workflows/ship.tsx");
    expect(errs[0]).toContain("page 'Ship' in area workflows");
    expect(errs[0]).toContain("page 'ShipWorkflow'");
  });

  it("stays silent on distinct areas holding same-named pages", async () => {
    const errs = await irErrors(
      `
      system Fine {
        ${PRELUDE}
        ui WebApp {
          api Sales: SalesApi
          area Ops {
            page Dashboard { route: "/ops/d" body: Stack { Heading { "A", level: 1 }, testid: "a" } }
          }
          area Finance {
            page Dashboard { route: "/finance/d" body: Stack { Heading { "B", level: 1 }, testid: "b" } }
          }
        }
        ${TAIL}
      }
    `,
      "loom.ui-page-path-collision",
    );
    expect(errs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `loom.ui-page-slot-collision`
// ---------------------------------------------------------------------------

describe("loom.ui-page-slot-collision", () => {
  it("rejects two pages claiming one aggregate archetype slot", async () => {
    // The scaffold's `area Orders { page List }` and the author's
    // `area Sales { area Orders { page List } }` BOTH classify as aggregate
    // Order's list page.  Only one can be routed; before this gate the other
    // was emitted as an unreachable file with no diagnostic.
    const errs = await irErrors(
      `
      system Slot {
        ${PRELUDE}
        ui WebApp with scaffold(aggregates: [Order]) {
          api Sales: SalesApi
          area Sales {
            area Orders {
              page List {
                route: "/orders"
                body: Stack { Heading { "Mine", level: 1 }, testid: "mine" }
              }
            }
          }
        }
        ${TAIL}
      }
    `,
      "loom.ui-page-slot-collision",
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("the list page of aggregate 'Order'");
    expect(errs[0]).toContain("page 'List' in area sales/orders");
  });

  it("stays silent when the override lands in the scaffold's own scope", async () => {
    // Same-scope override is the SUPPORTED path: the macro expander merges the
    // synthesised `area Orders` into the author's and drops its `page List`, so
    // exactly one page fills the slot.
    const errs = await irErrors(
      `
      system Ok {
        ${PRELUDE}
        ui WebApp with scaffold(aggregates: [Order]) {
          api Sales: SalesApi
          area Orders {
            page List {
              route: "/orders"
              body: Stack { Heading { "Mine", level: 1 }, testid: "mine" }
            }
          }
        }
        ${TAIL}
      }
    `,
      "loom.ui-page-slot-collision",
    );
    expect(errs).toEqual([]);
  });

  it("stays silent on a plain multi-aggregate scaffold", async () => {
    const errs = await irErrors(
      `
      system Multi {
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
        deployable web { platform: react, targets: api, ui: App { Shop: api }, port: 3001 }
      }
    `,
      "loom.ui-page-slot-collision",
    );
    expect(errs).toEqual([]);
  });
});
