// Slice 11 — explicit-page emission via body-shape dispatch.
//
// Before: explicit pages (`page X { route, body, … }`) were silently
// dropped by the React emitter — only scaffold-synthesised pages
// emitted, because the emitter dispatched on `page.scaffoldOrigin`
// (which is undefined for explicit pages).
//
// After: any page whose body matches a known stdlib component
// (`List(of: T)`, `Form(creates: T)`, `Form(runs: <wf>)`,
// `Detail(of: T)`, `List(of: view <View>)`, `Home`, `WorkflowsIndex`,
// `ViewsIndex`) routes through the same dispatch table.  Scaffold-
// synthesised AND explicit pages emit identically when their body
// shapes match.
//
// What this proves:
//   1. An explicit `page <Name>` with a recognised body produces
//      the right `src/pages/.../...tsx` file (file content
//      delegated to the same renderXxx function the scaffold path
//      uses).
//   2. Override-by-name still works: an explicit page replaces
//      the synthesised one at the same name; the explicit page's
//      body drives emission.
//   3. Pages with unrecognised bodies are silently skipped (no
//      emit, no error in v0).  Slice 11.1 will route them through
//      a deeper component-table walker.

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { generateSystems } from "../src/system/index.js";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";

async function buildAndGenerate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  const model = doc.parseResult.value as Model;
  return generateSystems(model).files;
}

describe("Slice 11 — explicit-page emission via body-shape dispatch", () => {
  it("emits src/pages/orders/list.tsx for an explicit `page OrderList { body: List(of: Order) }`", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M {
          context C {
            aggregate Order { customerId: string }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          page OrderList {
            route: "/orders"
            body:  List(of: Order)
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    expect([...files.keys()]).toContain("web/src/pages/orders/list.tsx");
    const content = files.get("web/src/pages/orders/list.tsx")!;
    // Sanity: matches the legacy renderListPage shape (uses
    // Mantine Table, calls useAllOrders / useAll<Order>).  Loose
    // contains-check — the exact content lives under the pack
    // template, which can change.
    expect(content).toMatch(/useAll/);
    expect(content).toMatch(/Order/);
  });

  it("override-by-name: explicit OrderList alongside `scaffold aggregates: Order` produces the same files (no duplicates)", async () => {
    // Confirms the AST expander suppresses synthesis on
    // collision AND the emitter still emits OrderList from the
    // explicit declaration.
    const files = await buildAndGenerate(`
      system S {
        module M {
          context C {
            aggregate Order { customerId: string }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          scaffold aggregates: Order
          page OrderList {
            route: "/orders"
            body:  List(of: Order)
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    // OrderList page emits exactly one file (not two — the
    // scaffold-synthesised one is suppressed by override-by-name
    // at the AST layer).
    const orderListFiles = [...files.keys()].filter((k) =>
      k.endsWith("orders/list.tsx"),
    );
    expect(orderListFiles).toHaveLength(1);
    expect(orderListFiles[0]).toBe("web/src/pages/orders/list.tsx");
    // OrderNew + OrderDetail still emit (scaffold synthesis for
    // them wasn't overridden).
    expect([...files.keys()]).toContain("web/src/pages/orders/new.tsx");
    expect([...files.keys()]).toContain("web/src/pages/orders/detail.tsx");
  });

  it("dispatches Form(creates: T) → src/pages/<plural>/new.tsx", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M {
          context C {
            aggregate Customer { name: string }
            repository Customers for Customer { }
          }
        }
        ui WebApp {
          page CustomerNew {
            route: "/customers/new"
            body:  Form(creates: Customer)
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    expect([...files.keys()]).toContain("web/src/pages/customers/new.tsx");
  });

  it("dispatches Detail(of: T) → src/pages/<plural>/detail.tsx", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M {
          context C {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          page OrderDetail {
            route: "/orders/:id"
            body:  Detail(of: Order)
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    expect([...files.keys()]).toContain("web/src/pages/orders/detail.tsx");
  });

  it("dispatches Form(runs: <workflow>) → src/pages/workflows/<slug>.tsx", async () => {
    // Slice 11.1: conventional-override naming.  The page's name
    // (`PlaceOrderWorkflow`) matches the synthesiser's expected
    // shape, so it emits at the conventional workflow path.  A
    // page named differently (`PlaceOrderForm`) is a non-
    // conventional explicit page and emits at
    // `src/pages/<name-snake>.tsx` with App.tsx routing instead.
    const files = await buildAndGenerate(`
      system S {
        module M {
          context C {
            aggregate Order { x: int }
            repository Orders for Order { }
            workflow placeOrder() { let o = Order.create({ }) }
          }
        }
        ui WebApp {
          page PlaceOrderWorkflow {
            route: "/workflows/place_order"
            body:  Form(runs: placeOrder)
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    expect([...files.keys()]).toContain(
      "web/src/pages/workflows/place_order.tsx",
    );
  });

  it("silently skips pages with unrecognised body shapes (v0 — Slice 11.1 handles deep walks)", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Custom {
            route: "/custom"
            body:  SomeUnknownThing(foo: 42)
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    // No crash, no spurious file.  The page is silently
    // unprocessed in v0 (Slice 11.1 promise: deeper dispatch).
    const customFiles = [...files.keys()].filter((k) => /custom/i.test(k));
    expect(customFiles).toEqual([]);
  });
});
