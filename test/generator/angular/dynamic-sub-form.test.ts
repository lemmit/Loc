// Angular dynamic sub-form rows — a `CreateForm`/`OperationForm` whose aggregate
// has an `X[]` field of a value object (`items: LineItem[]`) renders as a typed
// Reactive `FormArray` of nested `FormGroup`s (one per row) instead of a
// degenerate single text control.  The row sub-field inputs REUSE the pack's
// `fieldInput` (their `formControlName="<sub>"` resolves against the enclosing
// `[formGroupName]="$index"`), so every style (angularMaterial / primeng /
// spartanNg) gets row rendering for free.  Proven to `ng build` for all three.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SUB = (design: string) => `
system Shop {
  api ShopApi from Sales
  subdomain Sales {
    context Ordering {
      valueobject LineItem { sku: string  qty: int }
      aggregate Order with crudish {
        reference: string
        items: LineItem[]
      }
      repository Orders for Order { }
    }
  }
  storage db { type: postgres }
  resource ordState { for: Ordering, kind: state, use: db }
  ui WebApp with scaffold(subdomains: [Sales]) { api Shop: ShopApi }
  deployable api { platform: node contexts: [Ordering] dataSources: [ordState] serves: ShopApi port: 3000 }
  deployable web { platform: angular targets: api ui: WebApp { Shop: api } port: 3005 design: ${design} }
}
`;

async function newComponent(design: string): Promise<string> {
  const files = await generateSystemFiles(SUB(design));
  return [...files.entries()].find(([p]) => p.endsWith("pages/order-new.component.ts"))![1];
}

describe.each([
  "angularMaterial",
  "primeng",
  "spartanNg",
])("angular dynamic sub-form rows — %s", (design) => {
  it("declares a FormArray control + typed getter and add/remove methods", async () => {
    const c = await newComponent(design);
    expect(c).toMatch(/import \{[^}]*\bFormArray\b[^}]*\} from "@angular\/forms"/);
    expect(c).toContain("items: new FormArray<FormGroup>([])");
    expect(c).toContain(
      'get itemsArray(): FormArray { return this.orderForm.get("items") as FormArray; }',
    );
    expect(c).toContain(
      'addItems(): void { this.itemsArray.push(new FormGroup({ sku: new FormControl("", { nonNullable: true }), qty: new FormControl(0, { nonNullable: true }) })); }',
    );
    expect(c).toContain("removeItems(i: number): void { this.itemsArray.removeAt(i); }");
  });

  it("renders a formArrayName block with @for rows bound to formGroupName", async () => {
    const c = await newComponent(design);
    expect(c).toContain('formArrayName="items"');
    expect(c).toContain("@for (__row of itemsArray.controls; track $index)");
    expect(c).toContain('[formGroupName]="$index"');
    // The reused row sub-field inputs bind by control name.
    expect(c).toContain('formControlName="sku"');
    expect(c).toContain('formControlName="qty"');
    // Add / per-row Remove wire the component methods.
    expect(c).toContain('(click)="removeItems($index)"');
    expect(c).toContain('(click)="addItems()"');
    expect(c).toContain("Add Line Item");
  });
});
