// Slice 4 — scaffold expander.
//
// These tests pin the rewrite from each `scaffold` selector kind to
// the synthesised `PageIR` set, plus override-by-name resolution and
// cross-directive double-scaffold detection.  Slice 5's emitter is
// the byte-equivalence layer; here we check structural fidelity to
// the spec.

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { lowerModel } from "../src/ir/lower.js";
import { enrichLoomModel } from "../src/ir/enrichments.js";
import { validateLoomModel } from "../src/ir/validate.js";
import { expandScaffolds } from "../src/ir/scaffold-expand.js";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";
import type { LoomModel, PageIR, UiIR } from "../src/ir/loom-ir.js";

async function buildLoom(src: string): Promise<LoomModel> {
  const { parseHelper } = await import("langium/test");
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  // Lower without enrichment so individual tests can call expander
  // directly when they want to inspect diagnostics.
  const doc = await helper(src, { validation: false });
  return lowerModel(doc.parseResult.value as Model);
}

async function buildEnriched(src: string): Promise<LoomModel> {
  const loom = await buildLoom(src);
  return enrichLoomModel(loom);
}

function uiOf(loom: LoomModel, name: string): UiIR {
  const ui = loom.systems[0]!.uis.find((u) => u.name === name);
  if (!ui) throw new Error(`ui '${name}' not found`);
  return ui;
}

function pageOf(ui: UiIR, name: string): PageIR {
  const p = ui.pages.find((p) => p.name === name);
  if (!p) throw new Error(`page '${name}' not found in ui '${ui.name}'`);
  return p;
}

describe("scaffold expander (Slice 4)", () => {
  it("synthesises List + New + Detail for a scaffolded aggregate", async () => {
    const loom = await buildEnriched(`
      system S {
        module Sales {
          context Orders {
            aggregate Order { customerId: string }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          scaffold aggregates: Order
        }
      }
    `);
    const ui = uiOf(loom, "WebApp");
    const names = ui.pages.map((p) => p.name).filter((n) => n.startsWith("Order"));
    expect(names).toEqual(["OrderList", "OrderNew", "OrderDetail"]);
    const list = pageOf(ui, "OrderList");
    expect(list.route).toBe("/orders");
    expect(list.body?.kind).toBe("call");
    if (list.body?.kind === "call") {
      expect(list.body.name).toBe("List");
      expect(list.body.argNames).toEqual(["of"]);
    }
    expect(list.scaffoldOrigin).toEqual({
      kind: "aggregate-list",
      aggregateName: "Order",
      contextName: "Orders",
    });
    expect(pageOf(ui, "OrderNew").route).toBe("/orders/new");
    expect(pageOf(ui, "OrderDetail").route).toBe("/orders/:id");
    // Detail page carries an `id: Id<Order>` route param.
    expect(pageOf(ui, "OrderDetail").params).toEqual([
      {
        name: "id",
        type: { kind: "id", targetName: "Order", valueType: "guid" },
      },
    ]);
  });

  it("expands a `scaffold modules: <Name>` directive recursively", async () => {
    const loom = await buildEnriched(`
      system S {
        module Sales {
          context Orders {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
          context Customers {
            aggregate Customer { name: string }
            repository Customers for Customer { }
          }
        }
        ui WebApp { scaffold modules: Sales }
      }
    `);
    const ui = uiOf(loom, "WebApp");
    const aggregatePages = ui.pages
      .filter((p) => p.scaffoldOrigin?.kind?.startsWith("aggregate-"))
      .map((p) => p.name)
      .sort();
    // Each aggregate emits 3 pages × 2 aggregates = 6 pages.
    expect(aggregatePages).toEqual(
      [
        "CustomerDetail",
        "CustomerList",
        "CustomerNew",
        "OrderDetail",
        "OrderList",
        "OrderNew",
      ],
    );
  });

  it("expands `scaffold workflows: <name>` to one workflow form page + a shared WorkflowsIndex", async () => {
    const loom = await buildEnriched(`
      system S {
        module Sales {
          context Orders {
            aggregate Order { customerId: string }
            repository Orders for Order { }
            workflow placeOrder(customerId: string) {
              let order = Order.create({ customerId: customerId })
            }
          }
        }
        ui WebApp { scaffold workflows: placeOrder }
      }
    `);
    const ui = uiOf(loom, "WebApp");
    const pageNames = ui.pages.map((p) => p.name).sort();
    expect(pageNames).toContain("PlaceOrderWorkflow");
    expect(pageNames).toContain("WorkflowsIndex");
    expect(pageNames).toContain("Home"); // shared Home page synthesised
    const wfPage = pageOf(ui, "PlaceOrderWorkflow");
    expect(wfPage.route).toBe("/workflows/place_order");
    expect(wfPage.scaffoldOrigin).toEqual({
      kind: "workflow-form",
      workflowName: "placeOrder",
      contextName: "Orders",
    });
  });

  it("expands `scaffold views: <Name>` to one view page + a shared ViewsIndex", async () => {
    const loom = await buildEnriched(`
      system S {
        module Sales {
          context Orders {
            aggregate Order { status: string }
            repository Orders for Order { }
            view ActiveOrders = Order where status == "open"
          }
        }
        ui WebApp { scaffold views: ActiveOrders }
      }
    `);
    const ui = uiOf(loom, "WebApp");
    expect(ui.pages.find((p) => p.name === "ActiveOrdersView")).toBeDefined();
    expect(ui.pages.find((p) => p.name === "ViewsIndex")).toBeDefined();
    const view = pageOf(ui, "ActiveOrdersView");
    expect(view.route).toBe("/views/active_orders");
    expect(view.scaffoldOrigin).toEqual({
      kind: "view-list",
      viewName: "ActiveOrders",
      contextName: "Orders",
    });
  });

  it("preserves `source: 'explicit'` on user-declared pages", async () => {
    const loom = await buildEnriched(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Home { route: "/", body: f() }
        }
      }
    `);
    const ui = uiOf(loom, "WebApp");
    const home = pageOf(ui, "Home");
    expect(home.source).toBe("explicit");
  });

  it("override-by-name: explicit page displaces the scaffolded page", async () => {
    const loom = await buildEnriched(`
      system S {
        module Sales {
          context Orders {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          scaffold aggregates: Order
          page OrderList {
            route: "/orders/all"
            body: List(of: Order, custom: true)
          }
        }
      }
    `);
    const ui = uiOf(loom, "WebApp");
    // Exactly one OrderList — the explicit one.
    const orderLists = ui.pages.filter((p) => p.name === "OrderList");
    expect(orderLists).toHaveLength(1);
    expect(orderLists[0]!.source).toBe("explicit");
    expect(orderLists[0]!.route).toBe("/orders/all");
    // The other two scaffold pages remain.
    expect(ui.pages.find((p) => p.name === "OrderNew")?.source).toBe("scaffold");
    expect(ui.pages.find((p) => p.name === "OrderDetail")?.source).toBe(
      "scaffold",
    );
  });

  it("scaffolds Home + WorkflowsIndex + ViewsIndex unconditionally on coverage", async () => {
    const loom = await buildEnriched(`
      system S {
        module Sales {
          context Orders {
            aggregate Order { x: int }
            repository Orders for Order { }
            workflow placeOrder() {
              let order = Order.create({ })
            }
            view ActiveOrders = Order where x > 0
          }
        }
        ui WebApp { scaffold modules: Sales }
      }
    `);
    const ui = uiOf(loom, "WebApp");
    const names = ui.pages.map((p) => p.name);
    expect(names).toContain("Home");
    expect(names).toContain("WorkflowsIndex");
    expect(names).toContain("ViewsIndex");
  });

  it("does not synthesise the shared index pages when no coverage exists", async () => {
    const loom = await buildEnriched(`
      system S {
        module M { context C { } }
        ui WebApp { }
      }
    `);
    const ui = uiOf(loom, "WebApp");
    const names = ui.pages.map((p) => p.name);
    expect(names).not.toContain("Home");
    expect(names).not.toContain("WorkflowsIndex");
    expect(names).not.toContain("ViewsIndex");
  });

  it("does not double-scaffold when `modules: <M>` and `aggregates: <A>` (A in M) coexist", async () => {
    // The expander returns a single PageIR per page name (first
    // source wins) and surfaces the conflict via `diagnostics`; the
    // post-IR validator (`validateLoomModel`) translates that into
    // an error.
    const loom = await buildLoom(`
      system S {
        module Sales {
          context Orders {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          scaffold modules: Sales
          scaffold aggregates: Order
        }
      }
    `);
    const sys = loom.systems[0]!;
    const ui = sys.uis[0]!;
    const result = expandScaffolds(ui, sys);
    // Final page set has no duplicates.
    const orderLists = result.pages.filter((p) => p.name === "OrderList");
    expect(orderLists).toHaveLength(1);
    // Diagnostics report the conflict.
    expect(result.diagnostics.some((d) => d.pageName === "OrderList")).toBe(
      true,
    );
    expect(result.diagnostics.some((d) => d.pageName === "OrderNew")).toBe(
      true,
    );
    expect(result.diagnostics.some((d) => d.pageName === "OrderDetail")).toBe(
      true,
    );
  });

  it("post-IR validator surfaces the cross-directive double-scaffold conflict", async () => {
    const loom = enrichLoomModel(
      await buildLoom(`
        system S {
          module Sales {
            context Orders {
              aggregate Order { x: int }
              repository Orders for Order { }
            }
          }
          ui WebApp {
            scaffold modules: Sales
            scaffold aggregates: Order
          }
        }
      `),
    );
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /scaffold directives produce duplicate page 'OrderList'/.test(
            d.message,
          ),
      ),
    ).toBe(true);
  });

  it("expander is a pure function — does not mutate `ui` or `sys`", async () => {
    const loom = await buildLoom(`
      system S {
        module Sales {
          context Orders {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
        }
        ui WebApp { scaffold aggregates: Order }
      }
    `);
    const sys = loom.systems[0]!;
    const ui = sys.uis[0]!;
    const beforeUiPages = ui.pages.length;
    const beforeUiScaffolds = ui.scaffolds.length;
    expandScaffolds(ui, sys);
    expandScaffolds(ui, sys);
    expect(ui.pages.length).toBe(beforeUiPages);
    expect(ui.scaffolds.length).toBe(beforeUiScaffolds);
  });

  it("preserves explicit pages first, scaffolded next, shared indexes last", async () => {
    const loom = await buildEnriched(`
      system S {
        module Sales {
          context Orders {
            aggregate Order { x: int }
            repository Orders for Order { }
            workflow placeOrder() { let o = Order.create({ }) }
          }
        }
        ui WebApp {
          page Custom { route: "/custom", body: f() }
          scaffold aggregates: Order
          scaffold workflows: placeOrder
        }
      }
    `);
    const ui = uiOf(loom, "WebApp");
    const sources = ui.pages.map((p) => p.source);
    // Explicit page first; the rest are scaffold (including Home / WorkflowsIndex).
    expect(sources[0]).toBe("explicit");
    expect(sources.slice(1).every((s) => s === "scaffold")).toBe(true);
  });

  it("hides New / Detail aggregate pages from the default sidebar", async () => {
    const loom = await buildEnriched(`
      system S {
        module Sales {
          context Orders {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
        }
        ui WebApp { scaffold aggregates: Order }
      }
    `);
    const ui = uiOf(loom, "WebApp");
    const list = pageOf(ui, "OrderList");
    const detail = pageOf(ui, "OrderDetail");
    const newPage = pageOf(ui, "OrderNew");
    // List page's menu metadata carries section/label; New + Detail
    // get `hidden: true`.
    expect(list.menuMeta?.entries.find((e) => e.name === "section")).toBeDefined();
    expect(detail.menuMeta?.entries.find((e) => e.name === "hidden")).toBeDefined();
    expect(newPage.menuMeta?.entries.find((e) => e.name === "hidden")).toBeDefined();
  });
});
