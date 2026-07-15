// Svelte dynamic sub-form rows — a `CreateForm`/`OperationForm` whose aggregate
// has an `X[]` field of a value object (`items: LineItem[]`) renders a repeatable
// row group instead of the disabled "(arrays not yet supported)" stub.  Svelte's
// form runtime holds `form.values` in a Svelte 5 `$state` rune, so array fields
// are natively reactive: each row `bind:value`s `form.values.items[index].<sub>`
// (numeric sub-fields coerce in `oninput`), an Add button `.push`es a fresh row,
// a per-row Remove `.splice`s it out.  Proven to `svelte-check` + `vite build`
// for both the shadcnSvelte and flowbite packs.

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
  deployable web { platform: svelte targets: api ui: WebApp { Shop: api } port: 3005 design: ${design} }
}
`;

async function newPage(design: string): Promise<string> {
  const files = await generateSystemFiles(SUB(design));
  return [...files.entries()].find(([p]) => p.endsWith("orders/new/+page.svelte"))![1];
}

describe.each(["shadcnSvelte", "flowbite"])("svelte dynamic sub-form rows — %s", (design) => {
  it("renders an {#each} row group over the reactive array (no stub)", async () => {
    const page = await newPage(design);
    expect(page).toContain("{#each form.values.items as row, index}");
    expect(page).not.toContain("(arrays not yet supported in forms)");
  });

  it("binds each row sub-field to the indexed path; numeric coerces in oninput", async () => {
    const page = await newPage(design);
    // String sub-field: a two-way `bind:value` on the indexed path.
    expect(page).toContain("bind:value={form.values.items[index].sku }");
    // Numeric sub-field: an oninput that parses to an int at the indexed path.
    expect(page).toContain("form.values.items[index].qty = ");
    expect(page).toContain("parseInt(");
  });

  it("adds a fresh row via .push and removes one via .splice", async () => {
    const page = await newPage(design);
    expect(page).toContain('onclick={() => form.values.items.push({ sku: "", qty: 0 })}');
    expect(page).toContain("onclick={() => form.values.items.splice(index, 1)}");
    expect(page).toContain("Add Line Item");
  });
});
