// Slice 2 — page-metamodel IR.
//
// These tests pin the AST → IR lowering for `ui` SystemMembers,
// pages, components, scaffold directives, the optional menu block,
// `match` expressions, and block-body lambdas.
//
// Slice 2 is intentionally shallow: scaffold directives stay as
// literal `ScaffoldIR` (Slice 4 expands them); validator obligations
// land in Slice 3; the per-target generator (Slice 5) consumes the
// page IR.  These tests cover only what Slice 2 produces.

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { lowerModel } from "../src/ir/lower.js";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";
import type { ExprIR, LoomModel, PageIR, UiIR } from "../src/ir/loom-ir.js";

async function buildLoom(src: string): Promise<LoomModel> {
  const { parseHelper } = await import("langium/test");
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  // Validation off for IR shape tests — most of these systems have
  // dangling references the validator (Slice 3) will object to.
  const doc = await helper(src, { validation: false });
  return lowerModel(doc.parseResult.value as Model);
}

function firstSystem(loom: LoomModel) {
  return loom.systems[0]!;
}

function uiByName(loom: LoomModel, name: string): UiIR {
  const ui = firstSystem(loom).uis.find((u) => u.name === name);
  if (!ui) throw new Error(`ui '${name}' not found`);
  return ui;
}

describe("page metamodel — IR shape (Slice 2)", () => {
  it("attaches `uis` to SystemIR (empty when none declared)", async () => {
    const loom = await buildLoom(`
      system Acme {
        module M { context C { } }
      }
    `);
    expect(firstSystem(loom).uis).toEqual([]);
  });

  it("lowers an empty `ui` block as a UiIR with no members", async () => {
    const loom = await buildLoom(`
      system Acme {
        ui WebApp { }
      }
    `);
    const ui = uiByName(loom, "WebApp");
    expect(ui.pages).toEqual([]);
    expect(ui.components).toEqual([]);
    expect(ui.scaffolds).toEqual([]);
    expect(ui.menu).toBeUndefined();
  });

  it("preserves source order of multiple ui blocks", async () => {
    const loom = await buildLoom(`
      system Acme {
        ui A { }
        ui B { }
        ui C { }
      }
    `);
    expect(firstSystem(loom).uis.map((u) => u.name)).toEqual(["A", "B", "C"]);
  });

  it("lowers `scaffold modules: …` as a literal directive — not expanded", async () => {
    const loom = await buildLoom(`
      system Acme {
        ui WebApp {
          scaffold modules: M, N
          scaffold aggregates: Order
          scaffold workflows: placeOrder
          scaffold views: ActiveOrders, OrderSummary
        }
      }
    `);
    const ui = uiByName(loom, "WebApp");
    expect(ui.scaffolds).toEqual([
      { selector: "modules", targets: ["M", "N"] },
      { selector: "aggregates", targets: ["Order"] },
      { selector: "workflows", targets: ["placeOrder"] },
      { selector: "views", targets: ["ActiveOrders", "OrderSummary"] },
    ]);
    // Slice 2: scaffold expansion is Slice 4's job — `pages` stays
    // empty here even though scaffolds reference real domain.
    expect(ui.pages).toEqual([]);
  });

  it("lowers a `page` with route/title/requires/state/body/menu meta", async () => {
    // Note on test surface: current Slice 1 grammar doesn't yet
    // accept named-argument syntax inside CallExpr (`Foo(name: x)`),
    // and `section` is a hard keyword from `MenuSection` so
    // PageMenuMeta keys like `section: "..."` collide.  Both gaps
    // are real and tracked for a follow-up grammar slice; for the
    // IR-shape test we use surface the grammar accepts cleanly:
    // positional call args + non-colliding metadata keys.
    const loom = await buildLoom(`
      system Acme {
        ui WebApp {
          page OrderConsole {
            route: "/orders"
            title: "Orders"
            requires currentUser.id != null
            state {
              filter: string = ""
              selectedId: string
            }
            body: List(Order)
            menu { group: "Sales", caption: "Orders" }
          }
        }
      }
    `);
    const ui = uiByName(loom, "WebApp");
    const page = ui.pages.find((p) => p.name === "OrderConsole")!;
    expect(page.route).toBe("/orders");
    expect(page.title?.kind).toBe("literal");
    expect(page.requires?.kind).toBe("binary");
    expect(page.state.map((f) => f.name)).toEqual(["filter", "selectedId"]);
    expect(page.state[0]!.init?.kind).toBe("literal");
    expect(page.state[1]!.init).toBeUndefined();
    expect(page.body?.kind).toBe("call");
    expect(page.menuMeta?.entries.map((e) => e.name)).toEqual([
      "group",
      "caption",
    ]);
  });

  it("lowers a page with parameters (typed)", async () => {
    // `id` as a Parameter.name collides with the IdRef hard keyword;
    // grammar fix is a separate concern — use `customerId` here.
    const loom = await buildLoom(`
      system Acme {
        module M { context C { aggregate Customer { name: string } repository Customers for Customer { } } }
        ui WebApp {
          page CustomerDetail(customerId: Id<Customer>) {
            route: "/customers/:id"
            body: Detail(Customer)
          }
        }
      }
    `);
    const page = uiByName(loom, "WebApp").pages.find(
      (p): p is PageIR => p.name === "CustomerDetail",
    )!;
    expect(page.params).toHaveLength(1);
    expect(page.params[0]!.name).toBe("customerId");
    expect(page.params[0]!.type).toEqual({
      kind: "id",
      targetName: "Customer",
      valueType: "guid",
    });
  });

  it("merges multiple `state {}` blocks in a single page", async () => {
    const loom = await buildLoom(`
      system Acme {
        ui WebApp {
          page X {
            route: "/x"
            state { a: int = 0 }
            state { b: string }
            body: Empty()
          }
        }
      }
    `);
    const page = uiByName(loom, "WebApp").pages.find((p) => p.name === "X")!;
    expect(page.state.map((f) => f.name)).toEqual(["a", "b"]);
  });

  it("lowers a `component` declaration with params + body + state", async () => {
    // Positional-arg calls only (see grammar-gap notes elsewhere).
    const loom = await buildLoom(`
      system Acme {
        module M { context C { aggregate Order { x: int } repository Orders for Order { } } }
        ui WebApp {
          component OrderPanel(order: Order) {
            state { tab: string = "summary" }
            body: stack(order, tab)
          }
        }
      }
    `);
    const ui = uiByName(loom, "WebApp");
    expect(ui.components).toHaveLength(1);
    const comp = ui.components[0]!;
    expect(comp.name).toBe("OrderPanel");
    expect(comp.params.map((p) => p.name)).toEqual(["order"]);
    expect(comp.state.map((f) => f.name)).toEqual(["tab"]);
    expect(comp.body.kind).toBe("call");
  });

  it("lowers a `menu` block with internal and external links", async () => {
    const loom = await buildLoom(`
      system Acme {
        ui WebApp {
          page Home { route: "/", body: Heading("Hi") }
          page Reports { route: "/reports", body: List(of: Report) }
          menu {
            section "Main" {
              link Home { label: "Start" },
              link Reports
            }
            section "External" {
              link "Docs" -> "https://example.com",
              link "Status" -> "https://status.example.com"
            }
          }
        }
      }
    `);
    const ui = uiByName(loom, "WebApp");
    expect(ui.menu).toBeDefined();
    expect(ui.menu!.sections).toHaveLength(2);
    const [main, ext] = ui.menu!.sections;
    expect(main!.label).toBe("Main");
    expect(main!.links).toHaveLength(2);
    expect(main!.links[0]).toMatchObject({ kind: "page", pageName: "Home" });
    expect((main!.links[0] as { props: { name: string }[] }).props[0]!.name).toBe(
      "label",
    );
    expect(main!.links[1]).toMatchObject({ kind: "page", pageName: "Reports" });
    expect(ext!.links[0]).toMatchObject({
      kind: "external",
      label: "Docs",
      url: "https://example.com",
    });
  });

  it("lowers `match { … }` to a kind:'match' ExprIR with arms + otherwise", async () => {
    // Use simple positional-arg calls — named-arg syntax inside
    // CallExpr triggers parser recovery that swallows subsequent
    // arms (real grammar gap, tracked for a follow-up slice).
    const loom = await buildLoom(`
      system Acme {
        ui WebApp {
          page X {
            route: "/x"
            state { step: int = 0 }
            body: match {
              step == 0 => list(Order)
              step == 1 => empty()
              else      => heading("done")
            }
          }
        }
      }
    `);
    const page = uiByName(loom, "WebApp").pages.find((p) => p.name === "X")!;
    expect(page.body?.kind).toBe("match");
    if (page.body?.kind !== "match") throw new Error("expected match IR");
    expect(page.body.arms).toHaveLength(2);
    expect(page.body.arms[0]!.cond.kind).toBe("binary");
    expect(page.body.arms[0]!.value.kind).toBe("call");
    expect(page.body.otherwise?.kind).toBe("call");
  });

  it("lowers `match` with no arms and no else as an empty match expression", async () => {
    // Grammar accepts `match { }`; Slice 3 validator will warn /
    // error.  Slice 2 still produces a valid IR shape.
    const loom = await buildLoom(`
      system Acme {
        ui WebApp { page X { route: "/x", body: match { } } }
      }
    `);
    const page = uiByName(loom, "WebApp").pages[0]!;
    expect(page.body?.kind).toBe("match");
    if (page.body?.kind !== "match") throw new Error("expected match IR");
    expect(page.body.arms).toEqual([]);
    expect(page.body.otherwise).toBeUndefined();
  });

  it("lowers `match` outside a page body — in a derived property", async () => {
    const loom = await buildLoom(`
      system Acme {
        module M {
          context C {
            enum Status { Draft, Confirmed }
            aggregate Order {
              status: Status
              derived label: string = match {
                status == Draft => "Pending"
                else            => "Closed"
              }
            }
            repository Orders for Order { }
          }
        }
      }
    `);
    const order = firstSystem(loom).modules[0]!.contexts[0]!.aggregates.find(
      (a) => a.name === "Order",
    )!;
    const derived = order.derived.find((d) => d.name === "label")!;
    expect(derived.expr.kind).toBe("match");
  });

  it("lowers a single-expression lambda with `body` set, no `block`", async () => {
    // Existing v22 form — verifies regression: lambdas keep producing
    // the body field that prior renderers depend on.
    const loom = await buildLoom(`
      system Acme {
        module M {
          context C {
            aggregate Order { x: int }
            repository Orders for Order {
              find expensive(min: int): Order[] where x > min
            }
          }
        }
      }
    `);
    // The find filter is `x > min` — no lambda involved.  Use a
    // collection-op style filter instead via a derived property.
    const loom2 = await buildLoom(`
      system Acme {
        module M {
          context C {
            aggregate Bag {
              x: int
              contains items: Item[]
              derived count: int = items.filter(i => i.flag).count
              entity Item { flag: bool }
            }
            repository Bags for Bag { }
          }
        }
      }
    `);
    const bag = firstSystem(loom2).modules[0]!.contexts[0]!.aggregates.find(
      (a) => a.name === "Bag",
    )!;
    const derived = bag.derived.find((d) => d.name === "count")!;
    // Walk to find the lambda: receiver of the .count is a method-call
    // whose arg[0] is the lambda.
    let cursor: ExprIR = derived.expr;
    // member receiver chain — drill until we hit a method-call.
    while (cursor.kind === "member") cursor = cursor.receiver;
    if (cursor.kind !== "method-call") throw new Error("expected method-call");
    const lam = cursor.args[0];
    expect(lam?.kind).toBe("lambda");
    if (lam?.kind !== "lambda") throw new Error("expected lambda");
    expect(lam.body).toBeDefined();
    expect(lam.block).toBeUndefined();
  });

  it("attaches uiName + uiFramework to deployable IR (sugar form)", async () => {
    const loom = await buildLoom(`
      system Acme {
        module M { context C { } }
        ui WebApp { }
        deployable api {
          platform: dotnet
          ui: WebApp
          port: 8080
        }
      }
    `);
    const dep = firstSystem(loom).deployables.find((d) => d.name === "api")!;
    expect(dep.uiName).toBe("WebApp");
    expect(dep.uiFramework).toBeUndefined();
  });

  it("attaches uiName + uiFramework to deployable IR (block form)", async () => {
    const loom = await buildLoom(`
      system Acme {
        module M { context C { } }
        ui WebApp { }
        deployable web {
          platform: static
          targets: api
          ui WebApp { framework: react }
          port: 3001
        }
      }
    `);
    const dep = firstSystem(loom).deployables.find((d) => d.name === "web")!;
    expect(dep.uiName).toBe("WebApp");
    expect(dep.uiFramework).toBe("react");
  });

  it("Platform enum accepts 'static' (Slice 1 grammar / Slice 2 IR)", async () => {
    const loom = await buildLoom(`
      system Acme {
        module M { context C { } }
        deployable api { platform: dotnet, port: 8080 }
        deployable web { platform: static, targets: api, port: 3001 }
      }
    `);
    const platforms = firstSystem(loom).deployables.map((d) => d.platform);
    expect(platforms).toContain("static");
  });
});
