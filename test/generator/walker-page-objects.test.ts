// walker-side Playwright page-object emitter.
//
// Parallel to `page-objects-builder.ts` (scaffold archetypes get
// `<Agg>ListPage` / `<Agg>NewPage` / `<Agg>DetailPage`).  This
// module covers explicit (walker-emitted) pages: one page-object
// class per page, exposing a typed `Locator` getter per static
// `testid:` literal.
//
// What this slice pins:
//   1. Static routes ("/welcome") emit `static readonly url = …`
//      + a parameterless `goto()` method.
//   2. Parameterised routes ("/orders/:orderId") emit
//      `static urlFor(orderId: string)` + `goto(orderId: string)`
//      that interpolates the params.
//   3. Each static `testid:` literal becomes a typed `Locator`
//      getter on the class.  Getter names are camel-cased from
//      the testid (hyphens / snake-case → camelCase).
//   4. `Form(of: <Agg>)` synthesises per-field + submit testids
//      that ALSO surface as Locator getters (round-trip parity
//      with the scaffold New-page object).
//   5. Path-collision contract: walker output lives at
//      `e2e/pages/<page-snake>.ts`; scaffold output at
//      `e2e/pages/<aggregate-camel>.ts`.  No accidental overlap.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("walker-side e2e page-object emitter", () => {
  it("emits e2e/pages/<page-snake>.ts for a walker-eligible explicit page", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Welcome {
            route: "/welcome"
            body:  Stack(
              Heading("Welcome", testid: "welcome-h"),
              Text("Pick a destination.", testid: "welcome-body")
            )
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const po = files.get("web/e2e/pages/welcome.ts")!;
    expect(po).toBeDefined();
    expect(po).toMatch(/import type \{ Page, Locator \} from "@playwright\/test"/);
    expect(po).toMatch(/export class WelcomePage \{/);
    expect(po).toMatch(/static readonly url = "\/welcome"/);
    expect(po).toMatch(/async goto\(\): Promise<this>/);
    expect(po).toMatch(/await this\.page\.goto\(WelcomePage\.url\)/);
  });

  it("exposes one Locator getter per static testid (camel-cased name)", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Welcome {
            route: "/welcome"
            body:  Stack(
              Heading("Welcome", testid: "welcome-h"),
              Text("Body text", testid: "welcome-body")
            )
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const po = files.get("web/e2e/pages/welcome.ts")!;
    expect(po).toMatch(
      /get welcomeH\(\): Locator \{\s*return this\.page\.getByTestId\("welcome-h"\);\s*\}/,
    );
    expect(po).toMatch(
      /get welcomeBody\(\): Locator \{\s*return this\.page\.getByTestId\("welcome-body"\);\s*\}/,
    );
  });

  it("parameterised routes emit urlFor + goto with typed params", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page OrderDetail(orderId: string) {
            route: "/orders/:orderId"
            body:  Heading("Order", testid: "order-detail-h")
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const po = files.get("web/e2e/pages/order_detail.ts")!;
    expect(po).toBeDefined();
    expect(po).toMatch(/static urlFor\(orderId: string\): string/);
    expect(po).toMatch(/return `\/orders\/\$\{orderId\}`/);
    expect(po).toMatch(/async goto\(orderId: string\): Promise<this>/);
    expect(po).toMatch(/this\.page\.goto\(OrderDetailPage\.urlFor\(orderId\)\)/);
  });

  it("Form(of:) synthesised testids surface as Locator getters", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M {
          context C {
            aggregate Order {
              customerId: string display
              quantity:   int
            }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          page CreateOrder {
            route: "/orders/new"
            body:  Form(of: Order)
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const po = files.get("web/e2e/pages/create_order.ts")!;
    expect(po).toBeDefined();
    // Form-synthesised testids: <namespace>-input-<f> and -submit.
    expect(po).toMatch(/getByTestId\("orders-new-input-customerId"\)/);
    expect(po).toMatch(/getByTestId\("orders-new-input-quantity"\)/);
    expect(po).toMatch(/getByTestId\("orders-new-submit"\)/);
  });

  it("explicit Form testid: prefix replaces the auto-derived namespace", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M {
          context C {
            aggregate Order {
              customerId: string display
            }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          page PlaceOrder {
            route: "/place-order"
            body:  Form(of: Order, testid: "place-order")
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const po = files.get("web/e2e/pages/place_order.ts")!;
    expect(po).toBeDefined();
    expect(po).toMatch(/getByTestId\("place-order-input-customerId"\)/);
    expect(po).toMatch(/getByTestId\("place-order-submit"\)/);
    // Auto-derived "orders-new-*" testids should NOT leak in.
    expect(po).not.toMatch(/getByTestId\("orders-new-/);
  });

  it("scaffold-archetype pages still emit at e2e/pages/<aggregate-camel>.ts (no collision)", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M {
          context C {
            aggregate Order {
              customerId: string display
            }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          scaffold aggregates: Order
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    // Scaffold's per-aggregate page-object module.
    expect(files.has("web/e2e/pages/order.ts")).toBe(true);
    // Walker's per-page modules don't shadow.  (The scaffold-
    // archetype pages route through `inferBodyDispatch` and skip
    // the walker page-object branch by construction.)
    expect(files.has("web/e2e/pages/order_list.ts")).toBe(false);
    expect(files.has("web/e2e/pages/order_new.ts")).toBe(false);
    expect(files.has("web/e2e/pages/order_detail.ts")).toBe(false);
  });
});
