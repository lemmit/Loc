// Angular full-stack round-trip hardening — the codegen fixes that took the
// nightly `frontend-fullstack-e2e` Angular cell from a cascade of `ng build`
// failures (then a runtime 404) to a 10/10 green create → addLine → confirm →
// read-back round-trip.  Each `describe` below pins one fix so a regression in
// any of them fails a fast per-PR generator test rather than only the nightly
// full-stack matrix.
//
// The system mirrors `web/src/examples/sales-system-angular.ddd`: a `Money`
// value object on `Product`, an `Order` with a `contains lines: OrderLine[]`
// containment + an `addLine(productId, qty)` operation.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYS = (design: string | null) => `
system Sales {
  api SalesApi from Sales
  subdomain Sales {
    context Sales {
      valueobject Money { amount: decimal  currency: string }
      aggregate Customer with crudish {
        name: string
        derived display: string = name
      }
      aggregate Product with crudish {
        sku: string
        price: Money
        derived display: string = sku
      }
      aggregate Order with crudish {
        customerId: Customer id
        contains lines: OrderLine[]
        function isMutable(): bool = true
        operation addLine(productId: Product id, qty: int) {
          precondition isMutable()
          lines += OrderLine { productId: productId, quantity: qty }
        }
        entity OrderLine {
          productId: Product id
          quantity: int
        }
      }
      repository Customers for Customer { }
      repository Products for Product { }
      repository Orders for Order { }
    }
  }
  ui WebApp with scaffold(subdomains: [Sales]) { api Sales: SalesApi }
  storage db { type: postgres }
  resource st { for: Sales, kind: state, use: db }
  deployable api { platform: node contexts: [Sales] dataSources: [st] serves: SalesApi port: 3000 }
  deployable web { platform: angular targets: api ui: WebApp { Sales: api }${design ? ` design: ${design}` : ""} port: 3005 }
}
`;

async function files(design: string | null = null): Promise<Map<string, string>> {
  return generateSystemFiles(SYS(design));
}

function file(fs: Map<string, string>, suffix: string): string {
  const hit = [...fs.entries()].find(([p]) => p.endsWith(suffix));
  if (!hit) throw new Error(`no generated file ending in ${suffix}`);
  return hit[1];
}

describe("angular api-module — containment-part response typing", () => {
  it("emits a <Part>Response interface and types the containment field precisely", async () => {
    const api = file(await files(), "api/order.ts");
    // The containment part gets its own response interface (not `unknown`).
    expect(api).toContain("export interface OrderLineResponse {");
    expect(api).toMatch(/export interface OrderLineResponse \{[^}]*productId: string;[^}]*\}/s);
    expect(api).toMatch(/export interface OrderLineResponse \{[^}]*quantity: number;[^}]*\}/s);
    // The aggregate's `lines` field is typed as `OrderLineResponse[]`, not `unknown[]`.
    expect(api).toContain("lines: OrderLineResponse[];");
    expect(api).not.toContain("lines: unknown[];");
  });

  it("keeps request-side value objects `unknown` (request precision is separate)", async () => {
    const api = file(await files(), "api/product.ts");
    // Response-side VO is precise; request-side (create input) stays `unknown`.
    expect(api).toContain("export interface MoneyResponse {");
    expect(api).toMatch(/export interface CreateProductRequest \{[^}]*price: unknown;[^}]*\}/s);
  });
});

describe("angular api-module — operation REST path is snake-cased", () => {
  it("posts to the snake-cased op path (matches the Hono route), not camelCase", async () => {
    const api = file(await files(), "api/order.ts");
    // The Hono route emitter registers `POST /{id}/add_line`; the client must match.
    expect(api).toContain("`${API_BASE_URL}/orders/${id}/add_line`");
    expect(api).not.toContain("/orders/${id}/addLine`");
    // The TS method keeps its camelCase name.
    expect(api).toContain("addLine(id: string, input: AddLineOrderRequest)");
  });
});

describe.each([
  "angularMaterial",
  "primeng",
  "spartanNg",
])("angular containment table @for — %s", (design) => {
  it("tracks $index (the containment row has no id), never an undefined idx", async () => {
    const detail = file(await files(design), "pages/order-detail.component.ts");
    expect(detail).toContain("@for (row of");
    expect(detail).toContain("; track $index)");
    // The pre-fix bug: `track idx` referencing an undeclared template var.
    expect(detail).not.toContain("; track idx)");
  });
});

describe("angular form null-soundness — FK controls init a string", () => {
  it('inits an `X id` create-form control to "" so it types as FormControl<string>', async () => {
    const orderNew = file(await files(), "pages/order-new.component.ts");
    expect(orderNew).toContain('customerId: new FormControl("", { nonNullable: true })');
    expect(orderNew).not.toContain("customerId: new FormControl(null");
  });

  it('inits an `X id` operation-form control to "" (addLine productId)', async () => {
    const detail = file(await files(), "pages/order-detail.component.ts");
    expect(detail).toContain('productId: new FormControl("", { nonNullable: true })');
    expect(detail).not.toContain("productId: new FormControl(null");
  });
});

describe("angular value-object fieldset — nested FormGroup + sub-inputs", () => {
  it("declares a nested FormGroup for a value-object field (not a flat control)", async () => {
    const productNew = file(await files(), "pages/product-new.component.ts");
    expect(productNew).toContain(
      'price: new FormGroup({ amount: new FormControl(0, { nonNullable: true }), currency: new FormControl("", { nonNullable: true }) })',
    );
    // Not the pre-fix degenerate single control.
    expect(productNew).not.toContain("price: new FormControl(null");
  });

  it("renders a formGroupName fieldset whose sub-inputs carry nested testids", async () => {
    const productNew = file(await files(), "pages/product-new.component.ts");
    expect(productNew).toContain('formGroupName="price"');
    expect(productNew).toContain('data-testid="products-new-input-price"');
    // The shared page object fills `<container>-<sub>` (products-new-input-price-amount).
    expect(productNew).toContain('data-testid="products-new-input-price-amount"');
    expect(productNew).toContain('data-testid="products-new-input-price-currency"');
    expect(productNew).toContain('formControlName="amount"');
    expect(productNew).toContain('formControlName="currency"');
  });

  it("registers the FormGroup import for the value-object fieldset", async () => {
    const productNew = file(await files(), "pages/product-new.component.ts");
    expect(productNew).toMatch(/import \{[^}]*\bFormGroup\b[^}]*\} from "@angular\/forms"/);
  });
});
