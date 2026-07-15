// Feliz dynamic sub-form rows — a `CreateForm`/`OperationForm` whose aggregate
// (or op param) has an `X[]` field of a value object (`items: LineItem[]`)
// projects to a repeatable MVU sub-form: a string-typed `<VO>Row` record held as
// a `list` in the form state, an `Add`/`Remove of int` pair, one indexed
// `Set … of int * string` per row sub-field, a nested `Encode.list` of
// `Encode.object` rows, and a `List.mapi`-driven row view.  The emitted F# is
// proven to `dotnet fable`-compile (SDK:8.0); this pins the projection.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// A scaffolded system (list/detail reads pull in the `Order` wire type + its
// `Decoders`, mirroring real usage) whose aggregate has an array-of-VO field.
// Scaffold gives a `CreateForm` (New page) AND an update `OperationForm`.
const SUB = `
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
  ui WebApp with scaffold(subdomains: [Sales]) {
    api Shop: ShopApi
  }
  deployable api { platform: node contexts: [Ordering] dataSources: [ordState] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}
`;

async function appFs(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz dynamic sub-form rows (array-of-value-object)", () => {
  it("emits a string-typed row record + empty binding, and a list field on the form", async () => {
    const app = await appFs(SUB);
    expect(app).toContain("type LineItemRow =\n  {\n    sku: string\n    qty: string\n  }");
    expect(app).toContain(
      'let emptyLineItemRow : LineItemRow =\n  {\n    sku = ""\n    qty = ""\n  }',
    );
    // The create form record holds the rows as a list, initialised empty.
    expect(app).toContain("items: LineItemRow list");
    expect(app).toContain("items = []");
  });

  it("wires Add / Remove / indexed setter Msgs for the row group", async () => {
    const app = await appFs(SUB);
    expect(app).toContain("  | AddOrderFormItems");
    expect(app).toContain("  | RemoveOrderFormItems of int");
    expect(app).toContain("  | SetOrderFormItemsSku of int * string");
    expect(app).toContain("  | SetOrderFormItemsQty of int * string");
  });

  it("projects the update arms — append, index-filter remove, mapi set", async () => {
    const app = await appFs(SUB);
    expect(app).toContain(
      "  | AddOrderFormItems -> { model with OrderForm = { model.OrderForm with items = model.OrderForm.items @ [ emptyLineItemRow ] } }, Cmd.none",
    );
    expect(app).toContain(
      "  | RemoveOrderFormItems i -> { model with OrderForm = { model.OrderForm with items = model.OrderForm.items |> List.indexed |> List.filter (fun (j, _) -> j <> i) |> List.map snd } }, Cmd.none",
    );
    expect(app).toContain(
      "  | SetOrderFormItemsQty (i, v) -> { model with OrderForm = { model.OrderForm with items = model.OrderForm.items |> List.mapi (fun j row -> if j = i then { row with qty = v } else row) } }, Cmd.none",
    );
  });

  it("encodes the rows as a JSON array of row objects (qty lifted to int)", async () => {
    const app = await appFs(SUB);
    expect(app).toContain(
      '"items", Encode.list (form.items |> List.map (fun row -> Encode.object [',
    );
    expect(app).toContain('"sku", Encode.string row.sku');
    expect(app).toContain('"qty", Encode.int (int row.qty)');
  });

  it("renders repeatable rows via List.mapi with an Add and per-row Remove", async () => {
    const app = await appFs(SUB);
    // The row list splices in via `yield!` (F# implicit-yield alongside yield!).
    expect(app).toContain("yield! (model.OrderForm.items |> List.mapi (fun i row ->");
    // Each row sub-field binds to `row.<field>` and dispatches the INDEXED setter.
    expect(app).toContain(
      "prop.value row.sku; prop.onChange (fun (v: string) -> dispatch (SetOrderFormItemsSku (i, v)))",
    );
    // Numeric sub-field carries the number input type.
    expect(app).toContain('prop.type\'.number; prop.placeholder "qty"; prop.value row.qty');
    // Add / per-row Remove controls.
    expect(app).toContain("dispatch (RemoveOrderFormItems i)");
    expect(app).toContain('dispatch AddOrderFormItems); prop.text "Add Line Item"');
  });

  it("also drives the scaffolded update OperationForm (its own indexed Msgs)", async () => {
    const app = await appFs(SUB);
    // The crudish update op form gets the SAME row machinery under its form type.
    expect(app).toContain("  | AddUpdateOrderFormItems");
    expect(app).toContain("  | SetUpdateOrderFormItemsSku of int * string");
    expect(app).toContain(
      "UpdateOrderForm with items = model.UpdateOrderForm.items @ [ emptyLineItemRow ]",
    );
  });

  it("does not fall back to the comma-separated scalar-array stub", async () => {
    const app = await appFs(SUB);
    // The array-of-VO path must NOT reuse the scalar-array comma input.
    expect(app).not.toContain("items (comma-separated)");
  });
});
