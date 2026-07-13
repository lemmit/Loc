import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { LoomModel } from "../../src/ir/types/loom-ir.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// `area { }` page grouping (docs/old/proposals/unfoldable-page-scaffolding.md,
// v1).  Grouping is by containment: a page inside one or more `area` blocks
// lands at `src/pages/<area-path>/<page>.tsx`, the path joining down the
// nesting.  Area-less pages stay flat.
// ---------------------------------------------------------------------------

async function buildLoom(src: string): Promise<LoomModel> {
  const { parseHelper } = await import("langium/test");
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: false });
  return lowerModel(doc.parseResult.value as Model);
}

const pageNamed = (loom: LoomModel, name: string) => {
  const p = loom.systems[0]!.uis[0]!.pages.find((x) => x.name === name);
  if (!p) throw new Error(`page '${name}' not found`);
  return p;
};

describe("page areas — containment grouping", () => {
  it("nested areas set the page's area path + emitPath; top-level pages stay flat", async () => {
    const loom = await buildLoom(`
      system Acme {
        subdomain S { context C { aggregate Order { name: string } } }
        ui App {
          // A neutral top-level page (Home/WorkflowsIndex/ViewsIndex are the
          // reserved dashboard names classifyPage keys on) — stays custom with a
          // flat, unset emitPath.
          page Landing { route: "/" body: Text { "hi" } }
          area Sales {
            area Orders {
              page List { route: "/orders" body: Text { "list" } }
            }
            page CustomersIndex { route: "/customers" body: Text { "customers" } }
          }
        }
      }
    `);

    // top-level page: no area, default flat path (emitPath unset)
    const home = pageNamed(loom, "Landing");
    expect(home.area).toBeUndefined();
    expect(home.emitPath).toBeUndefined();

    // doubly-nested: pages/sales/orders/list.tsx
    const list = pageNamed(loom, "List");
    expect(list.area).toEqual(["sales", "orders"]);
    expect(list.emitPath).toBe("src/pages/sales/orders/list.tsx");

    // singly-nested: pages/sales/customers_index.tsx
    const customers = pageNamed(loom, "CustomersIndex");
    expect(customers.area).toEqual(["sales"]);
    expect(customers.emitPath).toBe("src/pages/sales/customers_index.tsx");
  });

  it("all area-nested pages are collected onto the ui (not dropped)", async () => {
    const loom = await buildLoom(`
      system Acme {
        ui App {
          area A { page P1 { route: "/1" body: Text { "1" } } area B { page P2 { route: "/2" body: Text { "2" } } } }
        }
      }
    `);
    const names = loom.systems[0]!.uis[0]!.pages.map((p) => p.name).sort();
    expect(names).toEqual(["P1", "P2"]);
  });
});
