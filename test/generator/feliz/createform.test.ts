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

  // A foreign-key `X id` field → a `<select>` populated from the target's `.all`
  // (an implicit read wired into the page), each option labelled by the target's
  // `display` derived field. A `View.idOptions` helper maps the Remote list.
  it("renders a foreign-key id field as a select populated from the target list", async () => {
    const app = await appFs(`
      system Shop {
        api ShopApi from Sales
        subdomain Sales {
          context Cat {
            aggregate Customer with crudish { name: string  derived display: string = name }
            repository Customers for Customer { }
            aggregate Order with crudish { ref: string  customer: Customer id }
            repository Orders for Order { }
          }
        }
        storage db { type: postgres }
        resource catState { for: Cat, kind: state, use: db }
        ui WebApp {
          api Shop: ShopApi
          page Orders {
            route: "/orders"
            body: QueryView {
              of: Shop.Order.all,
              loading: Text { "…" }, error: Text { "!" }, empty: Text { "0" },
              data: rows => Stack { For { each: rows, o => Card { o.ref } } }
            }
          }
          page OrderNew {
            route: "/orders/new"
            body: Stack { CreateForm { of: Order } }
          }
        }
        deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
        deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
      }
    `);
    // The FK field renders a select over the target list, blank-first, labelled
    // by the target's `display` derived; the option value is the target `id`.
    expect(app).toContain(
      'Html.select [ prop.value model.OrderForm.customer; prop.onChange (fun (v: string) -> dispatch (SetOrderFormCustomer v)); prop.children (Html.option [ prop.value ""; prop.text "" ] :: View.idOptions model.AllCustomers (fun x -> x.id) (fun x -> x.display)) ]',
    );
    // The `View.idOptions` helper is emitted.
    expect(app).toContain(
      "  let idOptions (r: Remote<'T list>) (idOf: 'T -> string) (labelOf: 'T -> string) : ReactElement list =",
    );
    // The target's `.all` is an IMPLICIT read wired into the MVU loop.
    expect(app).toContain("AllCustomers: Remote<Customer list>");
    expect(app).toContain("let allCustomers () : Async<Result<Customer list, string>> =");
    expect(app).toContain("Cmd.OfAsync.perform Api.allCustomers () AllCustomersLoaded");
    // A required FK guards the submit (must pick a customer).
    expect(app).toContain("IsNullOrWhiteSpace form.customer");
  });

  // Optional scalar create-input fields are RENDERED (previously dropped), but
  // encode empty → null and are exempt from the submit guard.
  it("renders optional scalar fields — empty encodes to null, exempt from validation", async () => {
    const app = await appFs(`
      system Shop {
        api ShopApi from Catalog
        subdomain Catalog {
          context Cat {
            aggregate Product with crudish { name: string  note: string?  rank: int? }
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
            body: Stack { CreateForm { of: Product } }
          }
        }
        deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
        deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
      }
    `);
    // The optional fields ARE in the form record + rendered as inputs.
    expect(app).toContain("note: string");
    expect(app).toContain('prop.placeholder "note"');
    expect(app).toContain('prop.type\'.number; prop.placeholder "rank"');
    // Empty optional folds to null; a filled value encodes as its base type.
    expect(app).toContain(
      '"note", (if form.note = "" then Encode.nil else Encode.string form.note)',
    );
    expect(app).toContain(
      '"rank", (if form.rank = "" then Encode.nil else Encode.int (int form.rank))',
    );
    // Only the REQUIRED `name` guards the submit — optionals are exempt.
    expect(app).toContain(
      "  let productFormValid (form: ProductForm) : bool =\n    not (System.String.IsNullOrWhiteSpace form.name)",
    );
    expect(app).not.toContain("IsNullOrWhiteSpace form.note");
    expect(app).not.toContain("IsNullOrWhiteSpace form.rank");
  });

  // An enum create field → a `<select>` of its values (not a free-text input):
  // a REQUIRED enum defaults to its first value + guards the submit; an OPTIONAL
  // enum leads with a blank option, starts "", encodes null, and is exempt.
  it("renders an enum field as a select bound to its values", async () => {
    const app = await appFs(`
      system Shop {
        api ShopApi from Catalog
        subdomain Catalog {
          context Cat {
            enum Status { active inactive archived }
            enum Tier { free pro }
            aggregate Product with crudish { name: string  status: Status  tier: Tier? }
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
            body: Stack { CreateForm { of: Product } }
          }
        }
        deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
        deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
      }
    `);
    // Required enum → a select of all values, NO blank option.
    expect(app).toContain(
      'Html.select [ prop.value model.ProductForm.status; prop.onChange (fun (v: string) -> dispatch (SetProductFormStatus v)); prop.children [ Html.option [ prop.value "active"; prop.text "active" ]; Html.option [ prop.value "inactive"; prop.text "inactive" ]; Html.option [ prop.value "archived"; prop.text "archived" ] ] ]',
    );
    // Required enum defaults to its FIRST value (select always has a selection).
    expect(app).toContain('status = "active"');
    // Required enum guards the submit.
    expect(app).toContain("IsNullOrWhiteSpace form.status");
    // Optional enum → a LEADING blank option, starts "", encodes null, exempt.
    expect(app).toContain(
      'Html.select [ prop.value model.ProductForm.tier; prop.onChange (fun (v: string) -> dispatch (SetProductFormTier v)); prop.children [ Html.option [ prop.value ""; prop.text "" ]; Html.option [ prop.value "free"; prop.text "free" ]; Html.option [ prop.value "pro"; prop.text "pro" ] ] ]',
    );
    expect(app).toContain('tier = ""');
    expect(app).toContain(
      '"tier", (if form.tier = "" then Encode.nil else Encode.string form.tier)',
    );
    expect(app).not.toContain("IsNullOrWhiteSpace form.tier");
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
