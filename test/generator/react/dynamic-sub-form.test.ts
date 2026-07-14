// Dynamic sub-form rows — a `CreateForm { of: <Agg> }` whose aggregate has an
// `X[]` field of a value-object (e.g. `items: LineItem[]`) renders a repeatable
// row group via RHF `useFieldArray` instead of the disabled "arrays not yet
// supported" stub.  Shared VM (`prepareFormFieldVM` → `rowFields`) + the mantine
// `field-input-array` template.  Proven to `tsc --noEmit` against a generated
// project.  Reference implementation for the cross-frontend rollout; the other
// packs / frontends keep the stub until their stage lands.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Shop {
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      valueobject LineItem { sku: string  qty: int }
      aggregate Order with crudish {
        customer: string
        items: LineItem[]
      }
      repository Orders for Order { }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp {
    api Shop: ShopApi
    page NewOrder {
      route: "/new"
      body: Stack { Heading { "New order", level: 1 }, CreateForm { of: Order } }
    }
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
  deployable web { platform: react targets: api ui: WebApp { Shop: api } port: 3005 }
}
`;

async function pageTsx(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  return files.get("web/src/pages/new_order.tsx")!;
}

describe("react dynamic sub-form rows (array-of-value-object)", () => {
  it("hoists a useFieldArray for the object array + imports it", async () => {
    const tsx = await pageTsx();
    expect(tsx).toMatch(/import \{[^}]*\buseFieldArray\b[^}]*\} from "react-hook-form"/);
    expect(tsx).toContain(
      'const { fields: itemsFields, append: appendItems, remove: removeItems } = useFieldArray({ control, name: "items" });',
    );
  });

  it("renders repeatable rows with indexed-path registers", async () => {
    const tsx = await pageTsx();
    expect(tsx).toContain("itemsFields.map((field, index) => (");
    // Each sub-field registers at the runtime-indexed path; the numeric one
    // coerces via valueAsNumber (so `z.number()` validates the text input).
    expect(tsx).toContain("{...register(`items.${index}.sku`)}");
    expect(tsx).toContain("{...register(`items.${index}.qty`, { valueAsNumber: true })}");
    // Add / remove controls.
    expect(tsx).toContain("onClick={() => removeItems(index)}");
    expect(tsx).toContain('onClick={() => appendItems({ sku: "", qty: 0 })}');
    expect(tsx).toContain("Add Line Item");
    // The disabled stub is gone.
    expect(tsx).not.toContain("(arrays not yet supported in forms)");
  });

  it("leaves a scalar-only create form byte-identical (no field-array wiring)", async () => {
    // A form with no object array must not gain a useFieldArray hoist.
    const scalar = `
system S {
  api A from Sub
  subdomain Sub { context C {
    aggregate Widget with crudish { name: string  size: int }
    repository Widgets for Widget { }
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui W { api Shop: A
    page NewWidget { route: "/new"  body: Stack { Heading { "New", level: 1 }, CreateForm { of: Widget } } }
  }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: react targets: api ui: W { Shop: api } port: 3005 }
}`;
    const files = await generateSystemFiles(scalar);
    const tsx = files.get("web/src/pages/new_widget.tsx")!;
    expect(tsx).not.toContain("useFieldArray");
  });
});
