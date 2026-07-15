import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Angular CreateForm `X id` field → Select (cross-aggregate reference).  When a
// form field's type is a cross-aggregate `Customer id` whose target carries a
// `derived display`, the Angular `fieldInput` seam renders a Select populated
// from the target's `useAll<X>()` collection (parity with React/Vue/Svelte's
// `field-input-id-select`) instead of a plain text input.  The page-shell hoists
// `readonly customerAll = useAllCustomers();` + imports the factory, and each
// option carries `data-testid="<ns>-input-<name>-option-<id>"`.  The flavour
// forks per pack: angularMaterial → `<mat-select>`, primeng → `<p-select>`,
// spartanNg/default → a plain `<select>`.  A target with NO `derived display`
// falls back to the plain text `<input>` (the user types the raw id).
// (ng build-verified separately.)
// ---------------------------------------------------------------------------

/** `Customer` carries a `derived display` → its `Customer id` form field becomes
 *  a Select.  `${design}` injects the per-pack `design:` slot (empty = the
 *  default angularMaterial pack). */
const SOURCE = (design: string | null) => `
  system Smoke {
    api SalesApi from Sales
    subdomain Sales {
      context Orders {
        aggregate Customer with crudish {
          name: string
          derived display: string = name
        }
        aggregate Order with crudish {
          customerId: Customer id
          note: string
        }
        repository Orders for Order { }
        repository Customers for Customer { }
      }
    }
    ui WebApp {
      api Sales: SalesApi
      page OrderNew {
        route: "/"
        body: CreateForm { of: Order, testid: "orders-new" }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api {
      platform: node
      contexts: [Orders]
      dataSources: [ordersState]
      serves: SalesApi
      port: 8080
    }
    deployable web {
      platform: angular
      targets: api
      ui: WebApp { Sales: api }
      port: 3004
      ${design ? `design: ${design}` : ""}
    }
  }
`;

async function formPage(design: string | null): Promise<string> {
  const all = await generateSystemFiles(SOURCE(design));
  return all.get("web/src/app/pages/order-new.component.ts")!;
}

describe("angular generator — CreateForm `X id` field renders a Select", () => {
  it("angularMaterial: renders a <mat-select> with the useAll<X> @for loop + per-option testid", async () => {
    const page = await formPage(null);
    expect(page).toContain(
      '<mat-select formControlName="customerId" data-testid="orders-new-input-customerId">',
    );
    expect(page).toContain("@for (__o of customerAll.data()?.items ?? []; track __o.id) {");
    expect(page).toContain(
      `<mat-option [value]="__o.id" [attr.data-testid]="'orders-new-input-customerId-option-' + __o.id">{{ __o.display }}</mat-option>`,
    );
    // The id field is a Select, not the text fallback.
    expect(page).not.toContain('<input matInput formControlName="customerId"');
  });

  it("angularMaterial: hoists the useAll<X> query as a class field + imports the factory", async () => {
    const page = await formPage(null);
    expect(page).toContain('import { useAllCustomers } from "../../api/customer";');
    expect(page).toContain("readonly customerAll = useAllCustomers();");
  });

  it("primeng: renders a <p-select> driven by the useAll<X> options + item template testid", async () => {
    const page = await formPage("primeng");
    expect(page).toContain(
      '<p-select [options]="customerAll.data()?.items ?? []" optionLabel="display" optionValue="id" styleClass="loom-input" formControlName="customerId" data-testid="orders-new-input-customerId">',
    );
    expect(page).toContain(
      `<span [attr.data-testid]="'orders-new-input-customerId-option-' + __o.id">{{ __o.display }}</span>`,
    );
    // Same hoist + import on the non-default pack.
    expect(page).toContain('import { useAllCustomers } from "../../api/customer";');
    expect(page).toContain("readonly customerAll = useAllCustomers();");
  });

  it("spartanNg: renders a plain <select> with the useAll<X> @for loop + per-option testid", async () => {
    const page = await formPage("spartanNg");
    expect(page).toContain(
      '<select class="loom-input" formControlName="customerId" data-testid="orders-new-input-customerId">',
    );
    expect(page).toContain("@for (__o of customerAll.data()?.items ?? []; track __o.id) {");
    expect(page).toContain(
      `<option [value]="__o.id" [attr.data-testid]="'orders-new-input-customerId-option-' + __o.id">{{ __o.display }}</option>`,
    );
    expect(page).toContain("readonly customerAll = useAllCustomers();");
  });
});

// ---------------------------------------------------------------------------
// Fallback: an `X id` field whose target has NO `derived display` keeps the
// plain text input (the user types the raw id) — no Select, no `useAll<X>`
// hoist/import.  Gated exactly like the `form-fields-vm.ts` Select gate.
// ---------------------------------------------------------------------------

const NO_DISPLAY_SOURCE = `
  system Smoke {
    api SalesApi from Sales
    subdomain Sales {
      context Orders {
        aggregate Customer with crudish {
          name: string
        }
        aggregate Order with crudish {
          customerId: Customer id
          note: string
        }
        repository Orders for Order { }
        repository Customers for Customer { }
      }
    }
    ui WebApp {
      api Sales: SalesApi
      page OrderNew {
        route: "/"
        body: CreateForm { of: Order, testid: "orders-new" }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api {
      platform: node
      contexts: [Orders]
      dataSources: [ordersState]
      serves: SalesApi
      port: 8080
    }
    deployable web {
      platform: angular
      targets: api
      ui: WebApp { Sales: api }
      port: 3004
    }
  }
`;

describe("angular generator — `X id` field with no derived display falls back to text", () => {
  it("renders a plain <input> and emits no Select / useAll<X> hoist", async () => {
    const all = await generateSystemFiles(NO_DISPLAY_SOURCE);
    const page = all.get("web/src/app/pages/order-new.component.ts")!;
    expect(page).toContain(
      '<input matInput formControlName="customerId" data-testid="orders-new-input-customerId">',
    );
    expect(page).not.toContain('<mat-select formControlName="customerId"');
    expect(page).not.toContain("useAllCustomers");
    expect(page).not.toContain("customerAll");
  });
});
