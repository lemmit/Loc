// Vue dynamic sub-form rows — a `CreateForm`/`OperationForm` whose aggregate has
// an `X[]` field of a value object (`items: LineItem[]`) renders a repeatable
// row group instead of the disabled "(arrays not yet supported)" stub.  Vue's
// `useLoomForm` holds `values` in a local `reactive()` object (the current draft
// vee-validate validates against on submit), so array fields work natively:
// each row `v-model`s `form.values.items[index].<sub>` (numeric sub-fields coerce
// via `@update:model-value`), an Add button `.push`es a fresh row, and a per-row
// Remove `.splice`s it out.  Proven to `vue-tsc --noEmit` + `vite build` for both
// the vuetify and shadcnVue packs.

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
  deployable web { platform: vue targets: api ui: WebApp { Shop: api } port: 3005 design: ${design} }
}
`;

async function newVue(design: string): Promise<string> {
  const files = await generateSystemFiles(SUB(design));
  return [...files.entries()].find(([p]) => p.endsWith("pages/orders/new.vue"))![1];
}

describe.each(["vuetify", "shadcnVue"])("vue dynamic sub-form rows — %s", (design) => {
  it("renders a v-for row group over the reactive array (no stub)", async () => {
    const vue = await newVue(design);
    expect(vue).toContain('v-for="(row, index) in form.values.items"');
    // The disabled stub must be gone.
    expect(vue).not.toContain("(arrays not yet supported in forms)");
  });

  it("binds each row sub-field to the indexed path; numeric coerces", async () => {
    const vue = await newVue(design);
    // String sub-field: a plain v-model (vuetify) / model-value binding (shadcnVue).
    expect(vue).toContain("form.values.items[index].sku");
    // Numeric sub-field: an @update:model-value that truncates to an int.
    expect(vue).toContain(
      '@update:model-value="(v) => form.values.items[index].qty = Math.trunc(Number(v)) || 0"',
    );
  });

  it("adds a fresh row via .push and removes one via .splice", async () => {
    const vue = await newVue(design);
    // Add button pushes the default row (single-quoted attr — the JSON has "").
    expect(vue).toContain(`@click='form.values.items.push({ sku: "", qty: 0 })'`);
    expect(vue).toContain('@click="form.values.items.splice(index, 1)"');
    expect(vue).toContain("Add Line Item");
  });
});
