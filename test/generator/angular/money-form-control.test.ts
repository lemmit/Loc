// Angular money form controls hold a decimal STRING, not a JS number.
//
// M-T1.24 seam 3 (numeric-types audit F6).  `controlInit` used to seed
// `new FormControl(0)` for `money` while the generated request interface types
// the field as `string` (`wireTsType`'s money case) — `getRawValue()` then fails
// `TS2345` under `ng build`, and suppressing it would POST a JSON number the
// backends reject.  The markup made it worse: money rendered behind
// `type="number"` (material/plain) or `p-inputnumber` (primeng), so every edit
// bound a number back into the control.
//
// Now: `new FormControl("0", { nonNullable: true })` → `FormControl<string>`,
// behind a TEXT input carrying `inputmode="decimal"` (numeric soft keyboard, no
// coercion).  The `int` sibling is the control field — it keeps `0` and
// `type="number"` / `p-inputnumber` in every pack.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SOURCE = (design: string) => `
  system Shop {
    subdomain Sales {
      context Catalog {
        aggregate Product {
          name: string
          quantity: int
          price: money
          total: money?
        }
        repository Products for Product { }
      }
    }
    api CatalogApi from Sales
    ui WebApp {
      api Sales: CatalogApi
      page ProductNew {
        route: "/"
        body: CreateForm { of: Product, testid: "products-new" }
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
      port: 3005
      design: ${design}
    }
  }
`;

async function formPage(design: string): Promise<string> {
  const all = await generateSystemFiles(SOURCE(design));
  return all.get("web/src/app/pages/product-new.component.ts")!;
}

describe.each([
  "angularMaterial",
  "primeng",
  "spartanNg",
])("angular money form control — %s", (design) => {
  it('seeds the money control with the string "0"', async () => {
    const page = await formPage(design);
    expect(page).toContain('price: new FormControl("0", { nonNullable: true })');
    expect(page).not.toContain("price: new FormControl(0,");
  });

  it("still seeds the int sibling with the number 0", async () => {
    const page = await formPage(design);
    expect(page).toContain("quantity: new FormControl(0, { nonNullable: true })");
  });

  it("keeps the request field typed as a string (what the seed must match)", async () => {
    const all = await generateSystemFiles(SOURCE(design));
    const api = all.get("web/src/api/product.ts")!;
    expect(api).toMatch(/price:\s*string/);
  });

  it("renders money as a text input with inputmode=decimal, never a numeric widget", async () => {
    const page = await formPage(design);
    const priceField = page.split("<").find((frag) => frag.includes('formControlName="price"'))!;
    expect(priceField).toContain('inputmode="decimal"');
    expect(priceField).not.toContain('type="number"');
    expect(page).not.toContain('<p-inputnumber styleClass="loom-input" formControlName="price"');
  });

  it("leaves the int sibling on the pack's numeric widget", async () => {
    const page = await formPage(design);
    if (design === "primeng") {
      expect(page).toContain('<p-inputnumber styleClass="loom-input" formControlName="quantity"');
    } else {
      const qty = page.split("<").find((frag) => frag.includes('formControlName="quantity"'))!;
      expect(qty).toContain('type="number"');
      expect(qty).not.toContain('inputmode="decimal"');
    }
  });
});
