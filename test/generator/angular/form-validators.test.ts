import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Angular generator — invariant-derived client-side form validation.
//
// The aggregate's wire-translatable `invariant`s fold into per-field
// `Validators.*` on the typed Reactive `FormControl` — the Angular twin of the
// zod native chain the other JSX frontends emit on `Create<Agg>Request`.  The
// classification runs through the SAME shared `takeSingleFieldChain` gate, so
// Angular admits a constraint iff React/Vue/Svelte do.
// ---------------------------------------------------------------------------

const SOURCE = `
  system Shop {
    subdomain Sales {
      context Catalog {
        aggregate Product {
          sku: string
          name: string
          quantity: int
          price: decimal
          invariant sku.matches("^[A-Z0-9-]+$")
          invariant name.length >= 2 && name.length <= 120
          invariant quantity >= 1
          invariant price >= 0
        }
        repository Products for Product { }
      }
    }
    ui WebApp {
      api Sales: CatalogApi
      page ProductNew {
        route: "/"
        body: CreateForm { of: Product, testid: "products-new" }
      }
    }
    storage primary { type: postgres }
    resource productsState { for: Products, kind: state, use: primary }
    deployable api {
      platform: node
      contexts: [Catalog]
      dataSources: [productsState]
      serves: CatalogApi
      port: 8080
    }
    deployable web {
      platform: angular
      targets: api
      ui: WebApp { Sales: api }
      port: 3005
    }
  }
`;

async function formPage(): Promise<string> {
  const all = await generateSystemFiles(SOURCE);
  return all.get("web/src/app/pages/product-new.component.ts")!;
}

describe("angular generator — invariant-derived form Validators", () => {
  it("folds single-field invariants into Validators on each FormControl", async () => {
    const page = await formPage();
    // regex → Validators.pattern
    expect(page).toContain(
      'sku: new FormControl("", { nonNullable: true, validators: [Validators.pattern(/^[A-Z0-9-]+$/)] })',
    );
    // length range → minLength + maxLength
    expect(page).toContain(
      'name: new FormControl("", { nonNullable: true, validators: [Validators.minLength(2), Validators.maxLength(120)] })',
    );
    // int >= 1 → Validators.min(1)
    expect(page).toContain(
      "quantity: new FormControl(0, { nonNullable: true, validators: [Validators.min(1)] })",
    );
    // decimal >= 0 → Validators.min(0)
    expect(page).toContain(
      "price: new FormControl(0, { nonNullable: true, validators: [Validators.min(0)] })",
    );
  });

  it("imports Validators from @angular/forms", async () => {
    const page = await formPage();
    expect(page).toContain(
      'import { FormControl, FormGroup, ReactiveFormsModule, Validators } from "@angular/forms";',
    );
  });

  it("marks all fields touched on a blocked submit so errors reveal", async () => {
    const page = await formPage();
    expect(page).toContain(
      "if (this.productForm.invalid) { this.productForm.markAllAsTouched(); return; }",
    );
  });

  it("renders an inline error per validated field, gated on touched", async () => {
    const page = await formPage();
    expect(page).toContain(
      '@if (productForm.controls.sku.invalid && productForm.controls.sku.touched) {<p class="loom-error" data-testid="products-new-error-sku">Sku is invalid</p>}',
    );
    expect(page).toContain('data-testid="products-new-error-quantity"');
  });
});

// ---------------------------------------------------------------------------
// Operation forms fold the same source as the zod `<Op>Request`: the
// aggregate's invariants + the op's preconditions, gated to the op's params.
// ---------------------------------------------------------------------------

const OP_SOURCE = `
  system Shop {
    subdomain Sales {
      context Catalog {
        aggregate Product {
          name: string
          quantity: int
          operation restock(amount: int) {
            precondition amount >= 1
            quantity := quantity + amount
          }
        }
        repository Products for Product { }
      }
    }
    api CatalogApi from Sales
    ui WebApp {
      api Sales: CatalogApi
      page ProductRestock {
        route: "/products/:id/restock"
        body: OperationForm(of: Product, op: restock)
      }
    }
    storage primary { type: postgres }
    resource productsState { for: Catalog, kind: state, use: primary }
    deployable api {
      platform: node
      contexts: [Catalog]
      dataSources: [productsState]
      serves: CatalogApi
      port: 8080
    }
    deployable web {
      platform: angular
      targets: api
      ui: WebApp { Sales: api }
      port: 3006
    }
  }
`;

describe("angular generator — operation-form Validators", () => {
  it("folds the op precondition into a Validators.min on the param control", async () => {
    const all = await generateSystemFiles(OP_SOURCE);
    const page = all.get("web/src/app/pages/product-restock.component.ts")!;
    expect(page).toContain(
      "amount: new FormControl(0, { nonNullable: true, validators: [Validators.min(1)] })",
    );
    expect(page).toContain("import { FormControl, FormGroup, ReactiveFormsModule, Validators }");
    expect(page).toContain(
      "if (this.restockProductForm.invalid) { this.restockProductForm.markAllAsTouched(); return; }",
    );
    expect(page).toContain('data-testid="products-op-restock-error-amount"');
  });
});
