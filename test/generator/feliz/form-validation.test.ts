// Feliz per-field form validation — the Elmish analogue of react-hook-form's
// per-field `errors.<f>.message` shown on blur.  Alongside the whole-form
// submit-gate (`<form>Valid` → button disabled), each required field carries a
// touched onBlur + an inline error revealed once the field is blurred.  The
// emitted F# is proven to compile via `dotnet fable`; this pins the wiring.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const APP = `
system Shop {
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product with crudish { name: string  price: money  note: string? }
      repository Products for Product { }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp {
    api Shop: ShopApi
    page ProductNew { route: "/products/new"  body: CreateForm { of: Product } }
    page Home { route: "/"  body: Text { "home" } }
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}
`;

async function appFs(): Promise<string> {
  const files = await generateSystemFiles(APP);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz per-field form validation", () => {
  it("wires the touched-set state (Model / init / Msg / update)", async () => {
    const app = await appFs();
    expect(app).toContain("ProductFormTouched: Set<string>");
    expect(app).toContain("ProductFormTouched = Set.empty");
    expect(app).toContain("| TouchProductForm of string");
    expect(app).toContain(
      "| TouchProductForm field -> { model with ProductFormTouched = Set.add field model.ProductFormTouched }, Cmd.none",
    );
  });

  it("emits a per-field error fn alongside the whole-form validity guard", async () => {
    const app = await appFs();
    // The submit-gate predicate stays.
    expect(app).toContain("let productFormValid (form: ProductForm) : bool =");
    // Plus a per-field error function returning a message option.
    expect(app).toContain("let productFormNameError (form: ProductForm) : string option =");
    expect(app).toContain(
      'if System.String.IsNullOrWhiteSpace form.name then Some "Required" else None',
    );
  });

  it("renders the inline error under a required field, gated on touched", async () => {
    const app = await appFs();
    // The input marks the field touched on blur.
    expect(app).toContain('prop.onBlur (fun _ -> dispatch (TouchProductForm "name"))');
    // The error only shows once the field is in the touched set.
    expect(app).toContain(
      '(match (if Set.contains "name" model.ProductFormTouched then Validation.productFormNameError model.ProductForm else None) with Some e -> Html.p [ prop.className "text-error text-sm mt-1"; prop.text e ] | None -> Html.none)',
    );
  });

  it("leaves an optional field free of touched/error wiring", async () => {
    const app = await appFs();
    // `note` is optional → no onBlur, no error element, no touched entry.
    expect(app).not.toContain('TouchProductForm "note"');
    expect(app).not.toContain("productFormNoteError");
  });
});
