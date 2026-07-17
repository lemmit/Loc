// Feliz `data-testid` emission — the foundation that makes a generated Feliz
// (F#/Fable/Elmish) frontend driveable by the SHARED, framework-neutral
// Playwright page objects (`src/generator/_frontend/page-objects-builder.ts` et
// al.), exactly like React/Vue/Svelte/Angular.  Feliz emits `Html.X [ prop… ]`
// (not JSX/HTML strings), so a testid rides as `prop.custom("data-testid", …)`;
// before this it emitted NONE, so the page objects had nothing to locate.
//
// Each assertion below pins one strand of the page-object contract on the
// scaffolded surface (list / detail / create / operation-modal / workflow), so a
// regression that drops a testid fails a fast per-PR generator test rather than
// only the (dotnet-gated) full-stack round-trip.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// A scaffolded Sales system mirroring `web/src/examples/sales-system-*.ddd`: a
// `Money` value object on `Product`, an `Order` with a `contains lines`
// containment + an `addLine(productId, qty)` operation, and a `placeOrder`
// workflow — the shapes the shared page objects drive.
const SYS = `
system Sales {
  api SalesApi from Sales
  subdomain Sales {
    context Sales {
      valueobject Money { amount: decimal  currency: string }
      aggregate Customer with crudish { name: string  derived display: string = name }
      aggregate Product with crudish { sku: string  price: Money  derived display: string = sku }
      aggregate Order with crudish {
        customerId: Customer id
        contains lines: OrderLine[]
        function isMutable(): bool = true
        operation addLine(productId: Product id, qty: int) {
          precondition isMutable()
          lines += OrderLine { productId: productId, quantity: qty }
        }
        entity OrderLine { productId: Product id  quantity: int }
      }
      repository Customers for Customer { }
      repository Products for Product { }
      repository Orders for Order { }
      workflow placeOrder transactional {
        create(customerId: Customer id, productId: Product id, qty: int) {
          precondition qty > 0
          let o = Order.create({ customerId: customerId })
        }
      }
    }
  }
  ui WebApp with scaffold(subdomains: [Sales]) { api Sales: SalesApi }
  storage db { type: postgres }
  resource st { for: Sales, kind: state, use: db }
  deployable api { platform: node contexts: [Sales] dataSources: [st] serves: SalesApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Sales: api } port: 3005 }
}
`;

async function appFs(): Promise<string> {
  const files = await generateSystemFiles(SYS);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

/** Assert the app emits `prop.custom("data-testid", "<id>")` for a STATIC id. */
function hasTestid(app: string, id: string): boolean {
  return app.includes(`prop.custom("data-testid", "${id}")`);
}

describe("feliz data-testid emission — scaffold page-object contract", () => {
  it("list page: root + create button + per-row testid", async () => {
    const app = await appFs();
    expect(hasTestid(app, "orders-list")).toBe(true);
    expect(hasTestid(app, "orders-list-create")).toBe(true);
    // The per-row testid is a DYNAMIC expression (`"orders-row-" + row.id`) so it
    // rides `prop.custom` with the F# concat, not a static string.
    expect(app).toContain('prop.custom("data-testid", (("orders-row-" + row.id)))');
  });

  it("detail page: root + per-field + contained-collection table", async () => {
    const app = await appFs();
    expect(hasTestid(app, "orders-detail")).toBe(true);
    expect(hasTestid(app, "orders-detail-customerId")).toBe(true);
    // The contained `lines` collection card carries `<slug>-detail-<containment>`
    // (the `<c>Rows()` locator reads `.locator("tbody tr")` under it).
    expect(hasTestid(app, "orders-detail-lines")).toBe(true);
  });

  it("create form: root + per-field inputs + value-object sub-fields + submit", async () => {
    const app = await appFs();
    expect(hasTestid(app, "products-new")).toBe(true);
    expect(hasTestid(app, "products-new-input-sku")).toBe(true);
    // A value-object field flattens to per-sub-field inputs whose testid nests
    // under the field (`price-amount`) — matching the page object's VO fill.
    expect(hasTestid(app, "products-new-input-price-amount")).toBe(true);
    expect(hasTestid(app, "products-new-input-price-currency")).toBe(true);
    expect(hasTestid(app, "products-new-submit")).toBe(true);
    // An `X id` create field (a native <select>) carries its own field testid.
    expect(hasTestid(app, "orders-new-input-customerId")).toBe(true);
  });

  it("operation modal: trigger + form container + param inputs + submit", async () => {
    const app = await appFs();
    // The `<summary>` trigger the op page-object clicks FIRST.
    expect(hasTestid(app, "orders-op-addLine")).toBe(true);
    // The form container it then waits for (`-form`), the param inputs it fills,
    // and the submit it clicks — the `-form`/`-input`/`-submit` suffixes on the
    // same base distinguish them from the bare trigger.
    expect(hasTestid(app, "orders-op-addLine-form")).toBe(true);
    expect(hasTestid(app, "orders-op-addLine-input-productId")).toBe(true);
    expect(hasTestid(app, "orders-op-addLine-input-qty")).toBe(true);
    expect(hasTestid(app, "orders-op-addLine-submit")).toBe(true);
  });

  it("workflow form: root + per-param inputs + submit (snake-cased slug)", async () => {
    const app = await appFs();
    // Workflow slug is `snake(wf.name)` — `placeOrder` → `place_order`.
    expect(hasTestid(app, "workflow-place_order")).toBe(true);
    expect(hasTestid(app, "workflow-place_order-input-customerId")).toBe(true);
    expect(hasTestid(app, "workflow-place_order-input-qty")).toBe(true);
    expect(hasTestid(app, "workflow-place_order-submit")).toBe(true);
  });

  it("testids ride prop.custom (never a JSX data-testid= attribute string)", async () => {
    const app = await appFs();
    // Feliz is F#, not JSX — the walker's static ` data-testid="…"` fragment must
    // be unwrapped to a prop, never spliced verbatim.
    expect(app).not.toContain('data-testid="');
  });
});
