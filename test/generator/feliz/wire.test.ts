// Feliz wire layer — Thoth decoders + a Cmd-based Api module + the MVU
// RemoteData projection for `<param>.<agg>.all` reads
// (fable-elmish-frontend.md §2.3/§7.2, slice 7).  The emitted F# is proven to
// compile via `dotnet fable` (SDK:8.0 container); this pins the projection
// shape so a regression surfaces in the fast suite before the docker gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

// A data-driven page: one aggregate + repository behind an api, a QueryView
// list read whose `data:` branch iterates the rows via `For`.  The Counter has
// no aggregate — the wire layer needs a real read target.
const SHOP = `
system Shop {
  api ShopApi from Catalog

  subdomain Catalog {
    context Cat {
      aggregate Product with crudish {
        name: string
        price: money
      }
      repository Products for Product { }
    }
  }

  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }

  ui WebApp {
    api Shop: ShopApi
    page Products {
      route: "/"
      body: Stack {
        Heading { "Products", level: 1 },
        QueryView {
          of:      Shop.Product.all,
          loading: Text { "Loading…" },
          error:   Text { "Failed to load" },
          empty:   Text { "No products yet." },
          data:    rows => Stack {
            For { each: rows, p => Card { p.name,
              Text { p.price }
            } }
          }
        }
      }
    }
  }

  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}
`;

async function appFs(): Promise<string> {
  const files = await generateSystemFiles(SHOP);
  const entry = [...files.entries()].find(([p]) => p.endsWith("src/App.fs"));
  expect(entry).toBeDefined();
  return entry![1];
}

describe("feliz wire layer", () => {
  it("emits a Thoth decoder per aggregate wire shape (off wireShape)", async () => {
    const app = await appFs();
    // Domain record — fields keep the exact wire names (lowercase), so a
    // page-body `p.name` member access lands on it with no casing seam.
    expect(app).toContain("type Product =");
    expect(app).toContain("    id: string");
    expect(app).toContain("    name: string");
    expect(app).toContain("    price: decimal");
    // Decoder — field-by-field, decode order mirrors the wire shape.
    expect(app).toContain("module Decoders =");
    expect(app).toContain("let product : Decoder<Product> =");
    expect(app).toContain('id = get.Required.Field "id" Decode.string');
    expect(app).toContain('price = get.Required.Field "price" Decode.decimal');
  });

  it("decodes an optional wire field as a single `T option` (no double-option)", async () => {
    // An optional read field must spell exactly one ` option` on the record and
    // pair `get.Optional.Field` with the BASE decoder — `get.Optional` already
    // yields `'T option`, so double-wrapping (`string option option`) is a
    // decoder/record type mismatch that breaks Fable compilation.
    const files = await generateSystemFiles(`
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
            route: "/"
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
    const app = [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
    // Record: a SINGLE ` option` (not `string option option`).
    expect(app).toContain("    note: string option");
    expect(app).toContain("    rank: int option");
    expect(app).not.toContain("option option");
    // Decoder: `get.Optional.Field` over the base decoder.
    expect(app).toContain('note = get.Optional.Field "note" Decode.string');
    expect(app).toContain('rank = get.Optional.Field "rank" Decode.int');
  });

  it("emits a mutually-recursive record group when a record references another", async () => {
    // A wire record with a value-object field (`address: Address`) references the
    // `Address` record — F# is order-sensitive, so the two must be one recursive
    // `type … and …` group and the decoder `let rec … and …` (with the sibling
    // decoder referenced UNqualified), else it fails `dotnet fable`.
    const files = await generateSystemFiles(`
      system Shop {
        api ShopApi from Sales
        subdomain Sales {
          context Cat {
            valueobject Address { street: string  city: string }
            aggregate Order with crudish { ref: string  address: Address }
            repository Orders for Order { }
          }
        }
        storage db { type: postgres }
        resource catState { for: Cat, kind: state, use: db }
        ui WebApp {
          api Shop: ShopApi
          page Orders {
            route: "/"
            body: QueryView {
              of: Shop.Order.all,
              loading: Text { "…" }, error: Text { "!" }, empty: Text { "0" },
              data: rows => Stack { For { each: rows, o => Card { o.ref } } }
            }
          }
        }
        deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
        deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
      }
    `);
    const app = [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
    // Records: one recursive `type … and …` group (Order references Address).
    expect(app).toContain("type Order =");
    expect(app).toContain("    address: Address");
    expect(app).toContain("and Address =");
    // Decoders: `let rec order … and address …`, sibling ref UNqualified.
    expect(app).toContain("  let rec order : Decoder<Order> =");
    expect(app).toContain('address = get.Required.Field "address" address');
    expect(app).toContain("  and address : Decoder<Address> =");
  });

  it("emits a Cmd-based Api module (Fable.SimpleHttp + Thoth → Result)", async () => {
    const app = await appFs();
    expect(app).toContain("open Fable.SimpleHttp");
    expect(app).toContain("open Thoth.Json");
    expect(app).toContain("module Api =");
    expect(app).toContain("let allProducts () : Async<Result<Product list, string>> =");
    expect(app).toContain('let! (status, body) = Http.get "/api/products"');
    expect(app).toContain(
      'match Decode.fromString (Decode.field "items" (Decode.list Decoders.product)) body with',
    );
  });

  it("projects the read to the MVU quadruple (Model / init Cmd / Msg / update)", async () => {
    const app = await appFs();
    // Model field holds the Remote envelope.
    expect(app).toContain("AllProducts: Remote<Product list>");
    // init starts Loading + fires the fetch Cmd.
    expect(app).toContain("AllProducts = Loading");
    expect(app).toContain("Cmd.OfAsync.perform Api.allProducts () AllProductsLoaded");
    // Msg carries the decoded Result.
    expect(app).toContain("| AllProductsLoaded of Result<Product list, string>");
    // update discriminates Ok → Loaded, Error → LoadError.
    expect(app).toContain(
      "| AllProductsLoaded (Ok data) -> { model with AllProducts = Loaded data }, Cmd.none",
    );
    expect(app).toContain(
      "| AllProductsLoaded (Error e) -> { model with AllProducts = LoadError e }, Cmd.none",
    );
  });

  it("renders QueryView through the offside-safe View.remoteList helper", async () => {
    const app = await appFs();
    // The Remote → element helper is emitted once…
    expect(app).toContain("module View =");
    expect(app).toContain("let remoteList (r: Remote<'T list>)");
    // …and QueryView is a CALL to it (four branches inline, data as a lambda).
    expect(app).toContain("View.remoteList model.AllProducts");
    expect(app).toContain('(Html.p [ Html.text "Loading…" ])');
    expect(app).toContain("(fun allProducts ->");
    // The `For` iterates the bound rows via `yield! … List.map`.
    expect(app).toContain("yield! allProducts |> List.map (fun p ->");
    // Member access resolves against the F# record field (no casing seam).
    expect(app).toContain("string (p.name)");
  });

  it("a read-free page emits no wire layer (Counter stays minimal)", async () => {
    const files = await generateSystemFiles(`
      system CounterApp {
        subdomain S { context C { } }
        ui WebApp {
          framework: feliz
          page Counter {
            route: "/"
            state { count: int = 0 }
            action inc() { count := count + 1 }
            body: Stack { Button { "+", onClick: inc } }
          }
        }
        deployable api { platform: node contexts: [C] port: 3000 }
        deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
      }
    `);
    const app = [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
    expect(app).not.toContain("open Thoth.Json");
    expect(app).not.toContain("module Api =");
    expect(app).not.toContain("type Remote<");
    // The fsproj stays minimal too (no Thoth / SimpleHttp refs).
    const fsproj = [...files.entries()].find(([p]) => p.endsWith("App.fsproj"))![1];
    expect(fsproj).not.toContain("Thoth.Json");
  });

  // Reachability — the data-driven system must PARSE + VALIDATE cleanly
  // (generator tests bypass validateLoomModel; experience_gathered.md §22).
  it("validates cleanly through validateLoomModel", async () => {
    const { errors } = await parseString(SHOP, { validate: true });
    expect(errors).toEqual([]);
  });
});
