// page-metamodel IR.
//
// These tests pin the AST → IR lowering for `ui` SystemMembers,
// pages, components, scaffold directives, the optional menu block,
// `match` expressions, and block-body lambdas.
//
// Lowering here is intentionally shallow: scaffold directives stay as
// literal `ScaffoldIR` (the expander expands them); validator obligations
// are handled separately; the per-target generator consumes the
// page IR.  These tests cover only what lowering produces.

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import type { ExprIR, LoomModel, PageIR, UiIR } from "../../src/ir/loom-ir.js";
import { lowerModel } from "../../src/ir/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

async function buildLoom(src: string): Promise<LoomModel> {
  const { parseHelper } = await import("langium/test");
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  // Validation off for IR shape tests — most of these systems have
  // dangling references the validator will object to.
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

describe("page metamodel — IR shape", () => {
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
    // `ui.scaffolds` was removed when `scaffold` migrated to a
    // stdlib macro — see Phase 4 of the macro plan.  Pages and
    // components are the only first-class UI members now.
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

  it("`with scaffold(modules: [...])` synthesises pages by AST time", async () => {
    // The `scaffold` macro splices Page AST nodes into the ui's
    // members at the IndexedContent phase; by the time we lower
    // to IR, every page is a regular PageIR with no special
    // provenance flag.  The original macro call has no IR-level
    // residue (was previously kept on `ui.scaffolds`, removed in
    // the Phase 4 finalisation commit).
    const loom = await buildLoom(`
      system Acme {
        module M { context A { aggregate Order { x: int } repository Orders for Order { } } }
        ui WebApp with scaffold(modules: [M]) {
        }
      }
    `);
    const ui = uiByName(loom, "WebApp");
    const pageNames = ui.pages.map((p) => p.name).sort();
    expect(pageNames).toContain("OrderList");
    expect(pageNames).toContain("OrderNew");
    expect(pageNames).toContain("OrderDetail");
  });

  it("lowers a `page` with route/title/requires/state/body/menu meta", async () => {
    // CallExpr accepts named-arg syntax (`List(of: Order)`)
    // and PageMenuMeta accepts soft-keyword keys (`section:`,
    // `label:`) — both via the `LooseName` rule.
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
            body: List(of: Order)
            menu { section: "Sales", label: "Orders" }
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
    if (page.body?.kind === "call") {
      expect(page.body.args).toHaveLength(1);
      expect(page.body.argNames).toEqual(["of"]);
    }
    expect(page.menuMeta?.entries.map((e) => e.name)).toEqual(["section", "label"]);
  });

  it("lowers a page with parameters (typed) — including `id` as a param name", async () => {
    // `Parameter.name` uses `LooseName`, so `id` no
    // longer collides with the IdRef magic-identifier keyword and
    // can be used as a route-param name.
    const loom = await buildLoom(`
      system Acme {
        module M { context C { aggregate Customer { name: string } repository Customers for Customer { } } }
        ui WebApp {
          page CustomerDetail(id: Id<Customer>) {
            route: "/customers/:id"
            body: Detail(of: Customer, by: id)
          }
        }
      }
    `);
    const page = uiByName(loom, "WebApp").pages.find(
      (p): p is PageIR => p.name === "CustomerDetail",
    )!;
    // The scaffold expander rewrites `Detail(of:, by:)`
    // bodies into walker-stdlib compositions.  The page now carries
    // the expanded `Stack(Breadcrumbs, Heading, QueryView, …)` body
    // instead of the original `Detail(of:, by:)`.  Params survive
    // intact — including `id: Id<Customer>` (and the expander
    // appends an `id: string` synthetic if missing; here the user
    // declared it as `Id<Customer>` so no synthetic append).
    expect(page.params.length).toBeGreaterThanOrEqual(1);
    const idParam = page.params.find((p) => p.name === "id")!;
    expect(idParam.name).toBe("id");
    // Body root is the expanded Stack call.
    expect(page.body?.kind).toBe("call");
    if (page.body?.kind === "call") {
      expect(page.body.name).toBe("Stack");
    }
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
    const loom = await buildLoom(`
      system Acme {
        module M { context C { aggregate Order { x: int } repository Orders for Order { } } }
        ui WebApp {
          component OrderPanel(order: Order) {
            state { tab: string = "summary" }
            body: Stack(items: [order, tab])
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
    expect((main!.links[0] as { props: { name: string }[] }).props[0]!.name).toBe("label");
    expect(main!.links[1]).toMatchObject({ kind: "page", pageName: "Reports" });
    expect(ext!.links[0]).toMatchObject({
      kind: "external",
      label: "Docs",
      url: "https://example.com",
    });
  });

  it("lowers `match { … }` to a kind:'match' ExprIR with arms + otherwise", async () => {
    // named-arg call surface in arm values no longer
    // breaks parsing.
    const loom = await buildLoom(`
      system Acme {
        ui WebApp {
          page X {
            route: "/x"
            state { step: int = 0 }
            body: match {
              step == 0 => List(of: Order)
              step == 1 => Empty()
              else      => Heading("done")
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
    // Grammar accepts `match { }`; the validator will warn /
    // error.  Lowering still produces a valid IR shape.
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
    const _loom = await buildLoom(`
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
    // Fullstack dotnet: `ui:` on a dotnet deployable defaults
    // the framework to `react` — the embedded SPA renders against the
    // React generator, with output landing under ClientApp/ of the
    // .NET project.  Backend-only dotnet (no `ui:`) leaves both
    // `uiName` and `uiFramework` undefined.
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
    expect(dep.uiFramework).toBe("react");
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

  it("preserves positional vs named-arg distinction in CallExpr", async () => {
    // Mixed positional + named — argNames is populated only when at
    // least one arg is named; a fully-positional call leaves
    // argNames undefined for IR compactness.
    const loom = await buildLoom(`
      system Acme {
        ui WebApp {
          page A { route: "/a", body: f(1, 2, 3) }
          page B { route: "/b", body: g(of: Order, scope: source) }
          page C { route: "/c", body: h(1, name: "x") }
        }
      }
    `);
    const ui = uiByName(loom, "WebApp");
    const aBody = ui.pages.find((p) => p.name === "A")!.body!;
    const bBody = ui.pages.find((p) => p.name === "B")!.body!;
    const cBody = ui.pages.find((p) => p.name === "C")!.body!;
    if (aBody.kind !== "call" || bBody.kind !== "call" || cBody.kind !== "call")
      throw new Error("expected call IR");
    expect(aBody.argNames).toBeUndefined();
    expect(bBody.argNames).toEqual(["of", "scope"]);
    expect(cBody.argNames).toEqual([undefined, "name"]);
  });

  it("admits keyword-shaped argument names via `LooseName`", async () => {
    // Without LooseName, `state:` and `body:` would fail because
    // they are hard keywords from `StateBlock` / `BodyProp`.
    const loom = await buildLoom(`
      system Acme {
        ui WebApp {
          page X {
            route: "/x"
            body: Form(state: draft, body: editor)
          }
        }
      }
    `);
    const page = uiByName(loom, "WebApp").pages[0]!;
    if (page.body?.kind !== "call") throw new Error("expected call");
    expect(page.body.argNames).toEqual(["state", "body"]);
  });

  it("admits soft-keyword names in MenuMetaEntry / MenuLinkProp", async () => {
    const loom = await buildLoom(`
      system Acme {
        ui WebApp {
          page Home { route: "/", body: Heading("hi") }
          menu {
            section "Main" {
              link Home { label: "Start" }
            }
          }
        }
      }
    `);
    const ui = uiByName(loom, "WebApp");
    const link = ui.menu!.sections[0]!.links[0];
    if (link!.kind !== "page") throw new Error("expected page link");
    expect(link!.props.map((p) => p.name)).toEqual(["label"]);
  });

  it("Platform enum accepts 'static'", async () => {
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
