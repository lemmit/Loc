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

  it("emits a create Api fn (encode + POST + decode the `{ id }` envelope)", async () => {
    const app = await appFs(CREATE);
    // The create endpoint returns the new record's id envelope (`{ id }`), NOT the
    // full aggregate — the Api fn returns the id `string` so the success handler
    // can route to the new record's detail page.
    expect(app).toContain(
      "let createProduct (form: ProductForm) : Async<Result<string, string>> =",
    );
    expect(app).toContain("let body = Encode.toString 0 (Encoders.productForm form)");
    expect(app).toContain("|> Http.method POST");
    expect(app).toContain("|> Http.content (BodyContent.Text body)");
    expect(app).toContain('|> Http.header (Headers.contentType "application/json")');
    expect(app).toContain("if response.statusCode = 200 || response.statusCode = 201 then");
    expect(app).toContain(
      'match Decode.fromString (Decode.field "id" Decode.string) response.responseText with',
    );
  });

  it("wires per-field Set Msgs + Submit + Created", async () => {
    const app = await appFs(CREATE);
    expect(app).toContain("| SetProductFormName of string");
    expect(app).toContain("| SetProductFormPrice of string");
    expect(app).toContain("| SubmitProductForm");
    // Created carries the new record's id (from the `{ id }` response).
    expect(app).toContain("| ProductCreated of Result<string, string>");
  });

  it("wires the update arms (setters, submit Cmd, created → detail navigate)", async () => {
    const app = await appFs(CREATE);
    expect(app).toContain(
      "  | SetProductFormName v -> { model with ProductForm = { model.ProductForm with name = v } }, Cmd.none",
    );
    expect(app).toContain(
      "  | SubmitProductForm -> model, Cmd.OfAsync.perform Api.createProduct model.ProductForm ProductCreated",
    );
    // On success, reset the form and route to the NEW record's detail page
    // (`/products/<id>`) using the id the create resolved.
    expect(app).toContain(
      '  | ProductCreated (Ok created) -> { model with ProductForm = emptyProductForm }, Cmd.navigatePath("products", created)',
    );
    expect(app).toContain("  | ProductCreated (Error _) -> model, Cmd.none");
  });

  it("the CreateForm renders typed inputs + a validity-guarded submit button", async () => {
    const app = await appFs(CREATE);
    // A `string` field → a plain text input.  The `data-testid` (the shared
    // page-object fill target, `<plural>-new-input-<field>`) leads the prop list;
    // the a11y aria-invalid/aria-describedby props follow the onBlur (asserted
    // below), so this is a PREFIX match up to and including the onBlur.
    expect(app).toContain(
      'Html.input [ prop.custom("data-testid", "products-new-input-name"); prop.className "input input-bordered w-full"; prop.placeholder "name"; prop.value model.ProductForm.name; prop.onChange (fun (v: string) -> dispatch (SetProductFormName v)); prop.onBlur (fun _ -> dispatch (TouchProductForm "name"))',
    );
    // A `money` field → a `type: number` input (browser-enforced numeric entry).
    expect(app).toContain(
      'Html.input [ prop.custom("data-testid", "products-new-input-price"); prop.className "input input-bordered w-full"; prop.type\'.number; prop.placeholder "price"; prop.value model.ProductForm.price; prop.onChange (fun (v: string) -> dispatch (SetProductFormPrice v)); prop.onBlur (fun _ -> dispatch (TouchProductForm "price"))',
    );
    // a11y: each validated input wires aria-invalid (touched && error) +
    // aria-describedby to its error element.
    expect(app).toContain('prop.ariaDescribedBy "ProductForm-name-error"');
    expect(app).toContain('prop.ariaDescribedBy "ProductForm-price-error"');
    // The submit is disabled until the form validates (both fields non-empty);
    // it carries the `<plural>-new-submit` testid the page object clicks.
    expect(app).toContain(
      'Html.button [ prop.custom("data-testid", "products-new-submit"); prop.className "btn btn-primary"; prop.disabled (not (Validation.productFormValid model.ProductForm)); prop.onClick (fun _ -> dispatch SubmitProductForm); prop.text "Create Product" ]',
    );
    // The form container carries the New-page root testid the page object waits for.
    expect(app).toContain('Html.div [ prop.custom("data-testid", "products-new"); prop.className');
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
      'Html.input [ prop.custom("data-testid", "products-new-input-inStock"); prop.className "checkbox"; prop.type\'.checkbox; prop.isChecked (model.ProductForm.inStock = "true"); prop.onChange (fun (v: bool) -> dispatch (SetProductFormInStock (if v then "true" else "false"))) ]',
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
    // (Prefix + tail: the a11y aria props sit between the onBlur and children.)
    expect(app).toContain(
      'Html.select [ prop.custom("data-testid", "orders-new-input-customer"); prop.className "select select-bordered w-full"; prop.value model.OrderForm.customer; prop.onChange (fun (v: string) -> dispatch (SetOrderFormCustomer v)); prop.onBlur (fun _ -> dispatch (TouchOrderForm "customer"))',
    );
    expect(app).toContain('prop.ariaDescribedBy "OrderForm-customer-error"');
    expect(app).toContain(
      'prop.children (Html.option [ prop.value ""; prop.text "" ] :: View.idOptions model.AllCustomers (fun x -> x.id) (fun x -> x.display)) ]',
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
    // Required enum → a select of all values, NO blank option.  (Prefix + tail:
    // the a11y aria props sit between the onBlur and children.)
    expect(app).toContain(
      'Html.select [ prop.custom("data-testid", "products-new-input-status"); prop.className "select select-bordered w-full"; prop.value model.ProductForm.status; prop.onChange (fun (v: string) -> dispatch (SetProductFormStatus v)); prop.onBlur (fun _ -> dispatch (TouchProductForm "status"))',
    );
    expect(app).toContain('prop.ariaDescribedBy "ProductForm-status-error"');
    expect(app).toContain(
      'prop.children [ Html.option [ prop.value "active"; prop.text "active" ]; Html.option [ prop.value "inactive"; prop.text "inactive" ]; Html.option [ prop.value "archived"; prop.text "archived" ] ] ]',
    );
    // Required enum defaults to its FIRST value (select always has a selection).
    expect(app).toContain('status = "active"');
    // Required enum guards the submit.
    expect(app).toContain("IsNullOrWhiteSpace form.status");
    // Optional enum → a LEADING blank option, starts "", encodes null, exempt.
    expect(app).toContain(
      'Html.select [ prop.custom("data-testid", "products-new-input-tier"); prop.className "select select-bordered w-full"; prop.value model.ProductForm.tier; prop.onChange (fun (v: string) -> dispatch (SetProductFormTier v)); prop.children [ Html.option [ prop.value ""; prop.text "" ]; Html.option [ prop.value "free"; prop.text "free" ]; Html.option [ prop.value "pro"; prop.text "pro" ] ] ]',
    );
    expect(app).toContain('tier = ""');
    expect(app).toContain(
      '"tier", (if form.tier = "" then Encode.nil else Encode.string form.tier)',
    );
    expect(app).not.toContain("IsNullOrWhiteSpace form.tier");
  });

  // A value-object field → FLATTENED into one input per scalar VO sub-field; the
  // encoder re-nests them under the object key. The form record stays flat/string.
  it("flattens a value-object field into per-sub-field inputs, re-nested in the encoder", async () => {
    const app = await appFs(`
      system Shop {
        api ShopApi from Sales
        subdomain Sales {
          context Cat {
            valueobject Address { street: string  city: string  zip: string? }
            aggregate Order with crudish { ref: string  address: Address }
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
    // Flat form record — one string field per VO sub-field.
    expect(app).toContain(
      "type OrderForm =\n  {\n    ref: string\n    addressStreet: string\n    addressCity: string\n    addressZip: string\n  }",
    );
    // Each VO sub-field renders its own input (bound to the flat field).
    expect(app).toContain('prop.placeholder "addressStreet"');
    expect(app).toContain('prop.placeholder "addressCity"');
    // The encoder RE-NESTS the flat fields under the object key.
    expect(app).toContain(
      '"address", Encode.object [\n        "street", Encode.string form.addressStreet\n        "city", Encode.string form.addressCity\n        "zip", (if form.addressZip = "" then Encode.nil else Encode.string form.addressZip)',
    );
    // Required VO sub-fields guard the submit; the optional `zip` is exempt.
    expect(app).toContain(
      "not (System.String.IsNullOrWhiteSpace form.addressStreet) && not (System.String.IsNullOrWhiteSpace form.addressCity)",
    );
    expect(app).not.toContain("IsNullOrWhiteSpace form.addressZip");
  });

  // A scalar-array `X[]` field → a comma-separated text input; the encoder splits
  // it into a JSON array (trim + drop blanks), encoding each element by its type.
  it("renders a scalar-array field as a comma-separated input encoded to a JSON array", async () => {
    const app = await appFs(`
      system Shop {
        api ShopApi from Sales
        subdomain Sales {
          context Cat {
            aggregate Order with crudish { ref: string  tags: string[]  counts: int[] }
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
    // The array field is a flat STRING in the form record (comma-separated).
    expect(app).toContain("tags: string");
    // A comma-separated text input with a format hint.
    expect(app).toContain('prop.placeholder "tags (comma-separated)"');
    // The encoder splits/trims/drops-blanks and encodes each element by type.
    expect(app).toContain(
      '"tags", Encode.list (form.tags.Split(\',\') |> Array.toList |> List.map (fun s -> s.Trim()) |> List.filter (fun s -> s <> "") |> List.map Encode.string)',
    );
    expect(app).toContain(
      '"counts", Encode.list (form.counts.Split(\',\') |> Array.toList |> List.map (fun s -> s.Trim()) |> List.filter (fun s -> s <> "") |> List.map (fun s -> Encode.int (int s)))',
    );
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
