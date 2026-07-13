// Feliz create forms — a `CreateForm(of: X)` projects to Elmish form state: a
// string-typed `<Agg>Form` record in the Model, one `Set` Msg per field, a
// `Submit` trigger that POSTs the Thoth-encoded body, and a `<Agg>Created`
// result that resets + navigates.  The emitted F# is proven to compile via
// `dotnet fable` (SDK:8.0) + vite build; this pins the projection.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

// A list page + a "new" page hosting a CreateForm.
const CREATE = `
system Shop {
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product with crudish { name: string  price: money }
      repository Products for Product { }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp {
    api Shop: ShopApi
    page Products {
      route: "/products"
      body: QueryView {
        of: Shop.Product.all,
        loading: Text { "…" }, error: Text { "!" }, empty: Text { "0" },
        data: rows => Stack { For { each: rows, p => Card { p.name } } }
      }
    }
    page ProductNew {
      route: "/products/new"
      body: Stack {
        Heading { "New Product", level: 1 },
        CreateForm { of: Product },
        Button { "Cancel", to: "/products" }
      }
    }
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}
`;

async function appFs(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz create forms", () => {
  it("emits a string-typed form record + empty value", async () => {
    const app = await appFs(CREATE);
    expect(app).toContain("type ProductForm =\n  {\n    name: string\n    price: string\n  }");
    expect(app).toContain("let emptyProductForm : ProductForm =");
    // The Model carries the in-progress form.
    expect(app).toContain("ProductForm: ProductForm");
  });

  it("emits Thoth encoders lifting string fields to wire types", async () => {
    const app = await appFs(CREATE);
    expect(app).toContain("module Encoders =");
    expect(app).toContain("let productForm (form: ProductForm) : JsonValue =");
    expect(app).toContain('"name", Encode.string form.name');
    // money/decimal lifts the string with `decimal`.
    expect(app).toContain('"price", Encode.decimal (decimal form.price)');
  });

  it("emits a create Api fn (encode + POST + decode response)", async () => {
    const app = await appFs(CREATE);
    expect(app).toContain(
      "let createProduct (form: ProductForm) : Async<Result<Product, string>> =",
    );
    expect(app).toContain("let body = Encode.toString 0 (Encoders.productForm form)");
    expect(app).toContain("|> Http.method POST");
    expect(app).toContain("|> Http.content (BodyContent.Text body)");
    expect(app).toContain('|> Http.header (Headers.contentType "application/json")');
    expect(app).toContain("if response.statusCode = 200 || response.statusCode = 201 then");
    expect(app).toContain("match Decode.fromString Decoders.product response.responseText with");
  });

  it("wires per-field Set Msgs + Submit + Created", async () => {
    const app = await appFs(CREATE);
    expect(app).toContain("| SetProductFormName of string");
    expect(app).toContain("| SetProductFormPrice of string");
    expect(app).toContain("| SubmitProductForm");
    expect(app).toContain("| ProductCreated of Result<Product, string>");
  });

  it("wires the update arms (setters, submit Cmd, created navigate)", async () => {
    const app = await appFs(CREATE);
    expect(app).toContain(
      "  | SetProductFormName v -> { model with ProductForm = { model.ProductForm with name = v } }, Cmd.none",
    );
    expect(app).toContain(
      "  | SubmitProductForm -> model, Cmd.OfAsync.perform Api.createProduct model.ProductForm ProductCreated",
    );
    expect(app).toContain(
      '  | ProductCreated (Ok _) -> { model with ProductForm = emptyProductForm }, Cmd.navigate("products")',
    );
    expect(app).toContain("  | ProductCreated (Error _) -> model, Cmd.none");
  });

  it("the CreateForm renders typed inputs + a validity-guarded submit button", async () => {
    const app = await appFs(CREATE);
    // A `string` field → a plain text input.
    expect(app).toContain(
      'Html.input [ prop.placeholder "name"; prop.value model.ProductForm.name; prop.onChange (fun (v: string) -> dispatch (SetProductFormName v)) ]',
    );
    // A `money` field → a `type: number` input (browser-enforced numeric entry).
    expect(app).toContain(
      'Html.input [ prop.type\'.number; prop.placeholder "price"; prop.value model.ProductForm.price; prop.onChange (fun (v: string) -> dispatch (SetProductFormPrice v)) ]',
    );
    // The submit is disabled until the form validates (both fields non-empty).
    expect(app).toContain(
      'Html.button [ prop.disabled (not (Validation.productFormValid model.ProductForm)); prop.onClick (fun _ -> dispatch SubmitProductForm); prop.text "Create Product" ]',
    );
    // No React/RHF sentinel leaked from the shared CreateForm default path.
    expect(app).not.toContain("useForm");
    expect(app).not.toContain("zodResolver");
  });

  it("emits a Validation module — every field must be non-empty to submit", async () => {
    const app = await appFs(CREATE);
    expect(app).toContain("module Validation =");
    expect(app).toContain("  let productFormValid (form: ProductForm) : bool =");
    expect(app).toContain(
      "    not (System.String.IsNullOrWhiteSpace form.name) && not (System.String.IsNullOrWhiteSpace form.price)",
    );
  });

  // A `bool` create field → a checkbox widget (not a text input): `isChecked`
  // reads the "true" string state, and the bool `onChange` writes it back.
  it("renders a bool field as a checkbox bound to the string state", async () => {
    const app = await appFs(`
      system Shop {
        api ShopApi from Catalog
        subdomain Catalog {
          context Cat {
            aggregate Product with crudish { name: string  inStock: bool }
            repository Products for Product { }
          }
        }
        storage db { type: postgres }
        resource catState { for: Cat, kind: state, use: db }
        ui WebApp {
          api Shop: ShopApi
          page ProductNew {
            route: "/products/new"
            body: Stack { CreateForm { of: Product } }
          }
        }
        deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
        deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
      }
    `);
    expect(app).toContain(
      'Html.input [ prop.type\'.checkbox; prop.isChecked (model.ProductForm.inStock = "true"); prop.onChange (fun (v: bool) -> dispatch (SetProductFormInStock (if v then "true" else "false"))) ]',
    );
    // The checkbox is EXCLUDED from validation — a bool is never "unfilled"
    // (unchecked = a legitimate false), so only the required text field guards.
    expect(app).toContain(
      "  let productFormValid (form: ProductForm) : bool =\n    not (System.String.IsNullOrWhiteSpace form.name)",
    );
    expect(app).not.toContain("form.inStock)");
  });

  // A read-only ui (no CreateForm) emits no form machinery — creates are additive.
  it("a read-only ui emits no form/encoder machinery", async () => {
    const app = await appFs(`
      system Shop {
        api ShopApi from Catalog
        subdomain Catalog {
          context Cat {
            aggregate Product with crudish { name: string  price: money }
            repository Products for Product { }
          }
        }
        storage db { type: postgres }
        resource catState { for: Cat, kind: state, use: db }
        ui WebApp {
          api Shop: ShopApi
          page Products {
            route: "/products"
            body: QueryView {
              of: Shop.Product.all,
              loading: Text { "…" }, error: Text { "!" }, empty: Text { "0" },
              data: rows => Stack { For { each: rows, p => Card { p.name } } }
            }
          }
        }
        deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
        deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
      }
    `);
    expect(app).not.toContain("module Encoders");
    expect(app).not.toContain("ProductForm");
    expect(app).not.toContain("Http.method POST");
  });

  // Reachability — the create system must PARSE + VALIDATE cleanly
  // (generator tests bypass validateLoomModel; experience_gathered.md §22).
  it("validates cleanly through validateLoomModel", async () => {
    const { errors } = await parseString(CREATE, { validate: true });
    expect(errors).toEqual([]);
  });
});
