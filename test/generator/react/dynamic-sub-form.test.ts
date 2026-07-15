// Dynamic sub-form rows — a `CreateForm { of: <Agg> }` whose aggregate has an
// `X[]` field of a value-object (e.g. `items: LineItem[]`) renders a repeatable
// row group via RHF `useFieldArray` instead of the disabled "arrays not yet
// supported" stub.  Shared VM (`prepareFormFieldVM` → `rowFields`) + each React
// pack's `field-input-array` template.  Proven to `tsc --noEmit` against a
// generated project for all four packs (mantine / shadcn / mui / chakra).
//
// The hoist appears in EVERY form template that owns a `useForm(...)` for an
// aggregate with an object array: the create form (`form-of-decls`), the
// operation-form modal (`form-op-module`), and the workflow form
// (`form-runs-decls`).  The op-form leg is the regression the third `it` guards
// — the row markup rendered `moreFields` without the matching hoist until the
// `fieldArrays` context was threaded through `renderFormOpWiring`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = (design: string) => `
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
  deployable web { platform: react targets: api ui: WebApp { Shop: api } port: 3005 design: ${design} }
}
`;

async function pageTsx(design: string): Promise<string> {
  const files = await generateSystemFiles(SRC(design));
  return files.get("web/src/pages/new_order.tsx")!;
}

// mantine / mui / chakra destructure `control` off `useForm` (object shorthand);
// shadcn keeps the whole `form` object undestructured and passes `form.control`.
const PACKS: { design: string; control: string }[] = [
  { design: "mantine", control: "control" },
  { design: "mui", control: "control" },
  { design: "chakra", control: "control" },
  { design: "shadcn", control: "control: form.control" },
];

describe.each(PACKS)("react dynamic sub-form rows — $design", ({ design, control }) => {
  it("hoists a useFieldArray for the object array + imports it", async () => {
    const tsx = await pageTsx(design);
    expect(tsx).toMatch(/import \{[^}]*\buseFieldArray\b[^}]*\} from "react-hook-form"/);
    expect(tsx).toContain(
      `const { fields: itemsFields, append: appendItems, remove: removeItems } = useFieldArray({ ${control}, name: "items" });`,
    );
  });

  it("renders repeatable rows with indexed-path registers", async () => {
    const tsx = await pageTsx(design);
    expect(tsx).toContain("itemsFields.map((field, index) => (");
    // Each sub-field registers at the runtime-indexed path; the numeric one
    // coerces via valueAsNumber (so `z.number()` validates the text input).
    // shadcn registers via `form.register`, the others via a destructured
    // `register` — both carry the same indexed path + valueAsNumber.
    const reg = design === "shadcn" ? "form.register" : "register";
    expect(tsx).toContain(`{...${reg}(\`items.\${index}.sku\`)}`);
    expect(tsx).toContain(`{...${reg}(\`items.\${index}.qty\`, { valueAsNumber: true })}`);
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
  deployable web { platform: react targets: api ui: W { Shop: api } port: 3005 design: ${design} }
}`;
    const files = await generateSystemFiles(scalar);
    const tsx = files.get("web/src/pages/new_widget.tsx")!;
    expect(tsx).not.toContain("useFieldArray");
  });
});

describe("react dynamic sub-form rows — operation form", () => {
  // Regression: an `OperationForm` whose op takes an `X[]` value-object param
  // renders the row markup (`moreFields.map`) but only wired up the matching
  // `useFieldArray` hoist once `fieldArrays` was threaded through the op-form
  // path.  Without the hoist the emitted page fails to compile (`moreFields`
  // is not defined).
  const OP_SRC = `
system Shop {
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      valueobject LineItem { sku: string  qty: int }
      aggregate Order {
        customer: string
        items: LineItem[]
        operation addItems(more: LineItem[]) { }
      }
      repository Orders for Order { }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp {
    api Shop: ShopApi
    page OrderDetail {
      route: "/orders/:id"
      body: QueryView {
        of: Shop.Order.byId(id), single: true,
        loading: Text { "…" }, error: Text { "err" }, empty: Text { "none" },
        data: o => Stack { Heading { o.customer, level: 1 }, OperationForm { of: Order, op: addItems } }
      }
    }
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
  deployable web { platform: react targets: api ui: WebApp { Shop: api } port: 3005 }
}
`;

  it("hoists useFieldArray for an array-of-VO op parameter", async () => {
    const files = await generateSystemFiles(OP_SRC);
    const tsx = files.get("web/src/pages/order_detail.tsx")!;
    expect(tsx).toContain(
      'const { fields: moreFields, append: appendMore, remove: removeMore } = useFieldArray({ control, name: "more" });',
    );
    expect(tsx).toContain("moreFields.map((field, index) => (");
    expect(tsx).toContain(`{...register(\`more.\${index}.qty\`, { valueAsNumber: true })}`);
  });
});
