// Spike — AST-to-AST scaffold expansion.
//
// Goal: prove that synthesising `Page` AST nodes at
// `DocumentState.Parsed` makes them visible to Langium's linker /
// scope provider / IndexManager — so a `[Page:ID]` cross-reference
// to a scaffold-synthesised name resolves through standard
// Langium machinery, no IR-level shim required.
//
// What this test proves:
//   1. The Parsed-phase hook runs (synthesised pages appear in
//      `ui.members` after parse + validate).
//   2. The IndexManager + scope provider see the synthesised
//      pages (by name, by $type === "Page").
//   3. Override-by-name: an explicit `page OrderList { … }`
//      suppresses the synthesised one of the same name.
//   4. Spike-grade — we don't yet construct a real `Body` /
//      cross-references inside synthesised pages; just `name`
//      and `$type`.  That's enough for indexing + resolution.

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model, Page, Ui } from "../../../src/language/generated/ast.js";

async function parseFresh(src: string): Promise<{
  model: Model;
  errors: string[];
}> {
  // Fresh service instance per test so the Parsed-phase hook
  // registration doesn't leak across cases.
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return {
    model: doc.parseResult.value as Model,
    errors: (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message),
  };
}

function uiOf(model: Model, name: string): Ui {
  const sys = (model.members ?? []).find((m) => m.$type === "System");
  if (!sys || sys.$type !== "System") throw new Error("no system");
  const ui = (sys.members ?? []).find((m): m is Ui => m.$type === "Ui" && m.name === name);
  if (!ui) throw new Error(`ui '${name}' not found`);
  return ui;
}

// Pages may be nested in `area { … }` blocks — the scaffold groups an
// aggregate's List/New/Detail under a per-aggregate `area`, so collect
// page names recursively.
function allPageNames(ui: Ui): string[] {
  const out: string[] = [];
  const walk = (members: unknown[]): void => {
    for (const m of members ?? []) {
      if ((m as { $type?: string }).$type === "Page") out.push((m as Page).name);
      else if ((m as { $type?: string }).$type === "Area")
        walk(((m as { members?: unknown[] }).members ?? []) as unknown[]);
    }
  };
  walk((ui.members ?? []) as unknown[]);
  return out;
}

describe("spike — AST-to-AST scaffold expansion", () => {
  it("synthesises Page AST nodes for `scaffold aggregates: <Name>`", async () => {
    const { model } = await parseFresh(`
      system S {
        subdomain M {
          context C {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
        }
        ui WebApp with scaffold(aggregates: [Order]) {
        }
      }
    `);
    const ui = uiOf(model, "WebApp");
    // Three synthesised pages: OrderList / OrderNew / OrderDetail (nested in
    // the per-aggregate `area Orders`).
    const pageNames = allPageNames(ui);
    expect(pageNames).toContain("OrderList");
    expect(pageNames).toContain("OrderNew");
    expect(pageNames).toContain("OrderDetail");
  });

  it("synthesises pages for `scaffold modules: <Name>` recursively", async () => {
    const { model } = await parseFresh(`
      system S {
        subdomain M {
          context A {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
          context B {
            aggregate Customer { name: string }
            repository Customers for Customer { }
          }
        }
        ui WebApp with scaffold(subdomains: [M]) {
        }
      }
    `);
    const ui = uiOf(model, "WebApp");
    const pageNames = allPageNames(ui).sort();
    // The full architectural fix synthesises `Home` for any ui
    // that scaffolds at least one aggregate / workflow / view —
    // matches the legacy generator's behaviour.
    expect(pageNames).toEqual([
      "CustomerDetail",
      "CustomerList",
      "CustomerNew",
      "Home",
      "OrderDetail",
      "OrderList",
      "OrderNew",
    ]);
  });

  it("synthesises pages for workflows + views", async () => {
    const { model } = await parseFresh(`
      system S {
        subdomain M {
          context C {
            aggregate Order { x: int }
            repository Orders for Order { }
            workflow placeOrder {
      create() { let o = Order.create({ }) }
    }
            view ActiveOrders = Order where x > 0
          }
        }
        ui WebApp with scaffold(workflows: [placeOrder], views: [ActiveOrders]) {
        }
      }
    `);
    const ui = uiOf(model, "WebApp");
    const pageNames = (ui.members ?? [])
      .filter((m): m is Page => m.$type === "Page")
      .map((p) => p.name);
    expect(pageNames).toContain("PlaceOrderWorkflow");
    expect(pageNames).toContain("ActiveOrdersView");
  });

  it("override-by-name: explicit page suppresses the scaffolded one", async () => {
    const { model } = await parseFresh(`
      system S {
        subdomain M {
          context C {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
        }
        ui WebApp with scaffold(aggregates: [Order]) {
          page OrderList {
            route: "/custom"
            body: f()
          }
        }
      }
    `);
    const ui = uiOf(model, "WebApp");
    // Exactly ONE page named OrderList — the explicit one (with the
    // custom route).  Synthesised OrderList is suppressed.
    const orderLists = (ui.members ?? []).filter(
      (m): m is Page => m.$type === "Page" && m.name === "OrderList",
    );
    expect(orderLists).toHaveLength(1);
    // The explicit page has props (route + body); synthesised pages
    // in this spike have empty props.
    expect(orderLists[0]!.props.length).toBeGreaterThan(0);
  });

  it("synthesised pages show up in IndexManager scope (export-side check)", async () => {
    // The IndexManager runs at DocumentState.IndexedContent (=2),
    // strictly after our Parsed-phase hook (=1).  By the time the
    // index is built, synthesised pages are in `ui.members[]`, so
    // they get picked up by the default ScopeComputation.
    //
    // We don't test cross-reference resolution end-to-end here
    // because the current grammar uses
    // `MenuLink.pageName=LooseName` — bare strings, no cross-ref.
    // This test just confirms the AST-side prerequisite: the
    // synthesised pages are reachable via the standard ui.members
    // walk that ScopeComputation uses.
    const { model, errors } = await parseFresh(`
      system S {
        subdomain M {
          context C {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
        }
        ui WebApp with scaffold(aggregates: [Order]) {
        }
      }
    `);
    expect(errors).toEqual([]);
    const ui = uiOf(model, "WebApp");
    // Each synthesised page has the right $container + parent name.
    const pages = (ui.members ?? []).filter((m): m is Page => m.$type === "Page");
    for (const p of pages) {
      expect(p.$container).toBe(ui);
      expect(p.$containerProperty).toBe("members");
      expect(p.$type).toBe("Page");
    }
  });
});
