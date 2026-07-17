// Feliz operation forms — an `OperationForm(of: X, op: Y)` on a detail page
// projects to Elmish form state (op params) + an id-qualified POST to
// `/api/<agg>/<id>/<op>` (204 → unit) + a `<Op><Agg>Done` result that navigates.
// Reuses the create-form machinery; the delta is the id-qualified endpoint, the
// curried Api fn, and the submit Msg carrying the route id.  Proven via
// `dotnet fable` (SDK:8.0) + vite build.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

// A detail page hosting an OperationForm for a custom `rename` operation.
const OPFORM = `
system Shop {
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product with crudish {
        name: string
        price: money
        operation rename(newName: string) { name := newName }
      }
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
    page ProductDetail {
      route: "/products/:id"
      body: Stack {
        Heading { "Product", level: 1 },
        OperationForm { of: Product, op: rename },
        Button { "Back", to: "/products" }
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

describe("feliz operation forms", () => {
  it("emits an op-param form record + encoder", async () => {
    const app = await appFs(OPFORM);
    expect(app).toContain("type RenameProductForm =\n  {\n    newName: string\n  }");
    expect(app).toContain("let emptyRenameProductForm : RenameProductForm =");
    expect(app).toContain("let renameProductForm (form: RenameProductForm) : JsonValue =");
    expect(app).toContain('"newName", Encode.string form.newName');
    expect(app).toContain("RenameProductForm: RenameProductForm");
  });

  it("emits a curried id-qualified operation Api fn (POST /<id>/<op>, 204 → unit)", async () => {
    const app = await appFs(OPFORM);
    expect(app).toContain(
      "let renameProduct (id: string) (form: RenameProductForm) : Async<Result<unit, string>> =",
    );
    expect(app).toContain('Http.request (sprintf "/api/products/%s/rename" id)');
    expect(app).toContain("|> Http.method POST");
    expect(app).toContain("if response.statusCode = 200 || response.statusCode = 204 then");
    expect(app).toContain("return Ok ()");
  });

  it("wires per-param Set Msgs + Submit (carrying id) + Done", async () => {
    const app = await appFs(OPFORM);
    expect(app).toContain("| SetRenameProductFormNewName of string");
    expect(app).toContain("| SubmitRenameProductForm of string");
    expect(app).toContain("| RenameProductDone of Result<unit, string>");
  });

  it("wires the update arms (setter, curried submit Cmd, done navigate)", async () => {
    const app = await appFs(OPFORM);
    expect(app).toContain(
      "  | SetRenameProductFormNewName v -> { model with RenameProductForm = { model.RenameProductForm with newName = v } }, Cmd.none",
    );
    // The curried `Api.renameProduct id` partial-app is the Cmd's async fn.
    expect(app).toContain(
      "  | SubmitRenameProductForm id -> model, Cmd.OfAsync.perform (Api.renameProduct id) model.RenameProductForm RenameProductDone",
    );
    expect(app).toContain(
      '  | RenameProductDone (Ok ()) -> { model with RenameProductForm = emptyRenameProductForm }, Cmd.navigate("products")',
    );
    expect(app).toContain("  | RenameProductDone (Error _) -> model, Cmd.none");
  });

  it("the OperationForm renders inputs + a submit dispatching Submit… id", async () => {
    const app = await appFs(OPFORM);
    expect(app).toContain(
      'Html.input [ prop.custom("data-testid", "products-op-rename-input-newName"); prop.className "input input-bordered w-full"; prop.placeholder "newName"; prop.value model.RenameProductForm.newName; prop.onChange (fun (v: string) -> dispatch (SetRenameProductFormNewName v)); prop.onBlur (fun _ -> dispatch (TouchRenameProductForm "newName"))',
    );
    // The submit carries the route id (instance-qualified op) + a validity guard,
    // plus the `<plural>-op-<op>-submit` testid the op page-object method clicks.
    expect(app).toContain(
      'Html.button [ prop.custom("data-testid", "products-op-rename-submit"); prop.className "btn btn-primary"; prop.disabled (not (Validation.renameProductFormValid model.RenameProductForm)); prop.onClick (fun _ -> dispatch (SubmitRenameProductForm id)); prop.text "Rename Product" ]',
    );
    // The form container carries `<plural>-op-<op>-form` (waited for after the
    // trigger click, detached after submit).
    expect(app).toContain('prop.custom("data-testid", "products-op-rename-form")');
    // The op form's field is validated too (shares the Validation module).
    expect(app).toContain("  let renameProductFormValid (form: RenameProductForm) : bool =");
    expect(app).not.toContain("useForm");
    expect(app).not.toContain("mutateAsync");
  });

  // Reachability — the op-form system must PARSE + VALIDATE cleanly
  // (generator tests bypass validateLoomModel; experience_gathered.md §22).
  it("validates cleanly through validateLoomModel", async () => {
    const { errors } = await parseString(OPFORM, { validate: true });
    expect(errors).toEqual([]);
  });
});
