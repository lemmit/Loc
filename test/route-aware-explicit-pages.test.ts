// Slice 11.1 — route-aware emission for explicit pages.
//
// Before: explicit pages with non-conventional names (e.g.
// `page OrderConsole { route: "/customers/:id/orders", body:
// List(of: Order) }`) emitted at conventional scaffold paths
// (`src/pages/orders/list.tsx`) — IGNORING the page's `route`
// property.  Result: collisions with scaffolded files, no
// real path for the user's custom URL, App.tsx never knew the
// page existed.
//
// After:
//   - Override-by-name (page name == expected scaffolded name)
//     keeps the conventional path so it cleanly replaces the
//     synthesised file.  Existing byte-equivalence preserved.
//   - Non-conventional explicit pages emit at
//     `src/pages/<name-snake>.tsx` and App.tsx receives extra
//     `import` + `Route` entries via the new
//     `deriveExtraRoutesFromUi` helper.
//
// What this test pins:
//   1. `page OrderConsole(customerId: Id<Customer>) { route:
//      "/customers/:customerId/orders", body: List(of: Order) }`
//      emits `src/pages/order_console.tsx`, NOT under
//      `src/pages/orders/`.
//   2. App.tsx imports `OrderConsole` from `./pages/order_console`.
//   3. App.tsx routes the user's custom path
//      (`/customers/:customerId/orders`) to `<OrderConsole />`.
//   4. Override-by-name still works: `page OrderList { body:
//      List(of: Order) }` still emits at the conventional
//      `src/pages/orders/list.tsx`.

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
  return generateSystems(doc.parseResult.value as Model).files;
}

describe("Slice 11.1 — route-aware explicit-page emission", () => {
  it("emits non-conventional pages at src/pages/<name-snake>.tsx", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M {
          context C {
            aggregate Order { customerId: string }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          page OrderConsole {
            route: "/custom/orders"
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
    // The page name `OrderConsole` doesn't match the conventional
    // `OrderList` shape, so it emits at the page-name-derived path
    // — NOT at `src/pages/orders/list.tsx`.
    expect([...files.keys()]).toContain("web/src/pages/order_console.tsx");
    // No conventional-path output for OrderConsole's body shape.
    const ordersListPath = "web/src/pages/orders/list.tsx";
    // OrderConsole's body IS `List(of: Order)`, but because its
    // name doesn't match the conventional shape, it doesn't emit
    // there — leaving the conventional path free for any actual
    // OrderList override or scaffold synthesis.
    expect(files.get(ordersListPath)).toBeUndefined();
  });

  it("App.tsx imports + routes non-conventional pages", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M {
          context C {
            aggregate Order { customerId: string }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          page OrderConsole {
            route: "/customers/:customerId/orders"
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
    const appTsx = files.get("web/src/App.tsx")!;
    expect(appTsx).toBeDefined();
    // Import the explicit page from the name-derived module.
    expect(appTsx).toMatch(
      /import OrderConsole from "\.\/pages\/order_console";/,
    );
    // Route the user's exact path to the page component.
    expect(appTsx).toMatch(
      /path="\/customers\/:customerId\/orders"\s+element=\{<OrderConsole \/>\}/,
    );
  });

  it("override-by-name keeps the conventional path AND no extra route", async () => {
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
    // Override emits at the conventional scaffold path.
    expect([...files.keys()]).toContain("web/src/pages/orders/list.tsx");
    // No `src/pages/order_list.tsx` file (would mean we emitted
    // both paths, breaking App.tsx imports).
    expect(files.get("web/src/pages/order_list.tsx")).toBeUndefined();
    // App.tsx still imports the conventional way — no extra route.
    const appTsx = files.get("web/src/App.tsx")!;
    expect(appTsx).toMatch(/import OrderList from "\.\/pages\/orders\/list";/);
    expect(appTsx).not.toMatch(/import OrderList from "\.\/pages\/order_list";/);
  });

  it("a single ui can mix overrides + non-conventional pages", async () => {
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
          page OrderConsole {
            route: "/customers/:customerId/orders"
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
    // Override (conventional path) + non-conventional (name path).
    expect([...files.keys()]).toContain("web/src/pages/orders/list.tsx");
    expect([...files.keys()]).toContain("web/src/pages/order_console.tsx");
    const appTsx = files.get("web/src/App.tsx")!;
    expect(appTsx).toMatch(/import OrderList from "\.\/pages\/orders\/list";/);
    expect(appTsx).toMatch(
      /import OrderConsole from "\.\/pages\/order_console";/,
    );
  });
});
