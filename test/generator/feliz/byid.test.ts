// Feliz byId / detail-page reads — a `QueryView(of: X.byId(id), single: true)` on
// a `:id`-param route projects to a `Remote<'T option>` Model field, a byId Api
// fetch, and a page-entry `Cmd` fired on navigation (init + UrlChanged).  The
// emitted F# is proven to compile via `dotnet fable` (SDK:8.0 container) + vite
// build; this pins the projection so a regression surfaces in the fast suite.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

// Two pages: a Products list + a ProductDetail (byId) on a `:id` route, plus a
// cross-page nav back to the list.
const DETAIL = `
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
      body: Stack {
        Heading { "Products", level: 1 },
        QueryView {
          of: Shop.Product.all,
          loading: Text { "Loading…" },
          error: Text { "Failed" },
          empty: Text { "None" },
          data: rows => Stack { For { each: rows, p => Card { p.name } } }
        }
      }
    }
    page ProductDetail {
      route: "/products/:id"
      body: Stack {
        Heading { "Product", level: 1 },
        QueryView {
          of: Shop.Product.byId(id),
          single: true,
          loading: Text { "Loading…" },
          error: Text { "Failed" },
          empty: Text { "Not found" },
          data: p => Card { p.name }
        },
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

describe("feliz byId detail-page reads", () => {
  it("projects a byId read to a Remote<'T option> Model field + Msg", async () => {
    const app = await appFs(DETAIL);
    expect(app).toContain("ProductById: Remote<Product option>");
    expect(app).toContain("| ProductByIdLoaded of Result<Product option, string>");
    // Both reads' fields coexist (list + single).
    expect(app).toContain("AllProducts: Remote<Product list>");
  });

  it("emits a byId Api fetch — (id: string), sprintf route, 404 → Ok None", async () => {
    const app = await appFs(DETAIL);
    expect(app).toContain("let productById (id: string) : Async<Result<Product option, string>> =");
    expect(app).toContain('let! (status, body) = Http.get (sprintf "/api/products/%s" id)');
    expect(app).toContain("match Decode.fromString (Decode.option Decoders.product) body with");
    expect(app).toContain("elif status = 404 then\n        return Ok None");
  });

  it("carries the route param on the Page case + binds it in parseUrl", async () => {
    const app = await appFs(DETAIL);
    expect(app).toContain("type Page =\n  | Products\n  | ProductDetail of string");
    expect(app).toContain('  | [ "products" ] -> Products');
    expect(app).toContain('  | [ "products"; id ] -> ProductDetail id');
  });

  it("fires the byId read on page entry via pageCmd (init + UrlChanged)", async () => {
    const app = await appFs(DETAIL);
    // pageCmd dispatcher — one arm per byId read, keyed by the hosting Page case.
    expect(app).toContain("let pageCmd (page: Page) : Cmd<Msg> =");
    expect(app).toContain(
      "  | ProductDetail id -> Cmd.OfAsync.perform Api.productById id ProductByIdLoaded",
    );
    expect(app).toContain("  | _ -> Cmd.none");
    // init binds `let page` and batches pageCmd alongside the list read.
    expect(app).toContain("let init () =\n  let page = parseUrl (Router.currentUrl ())");
    expect(app).toContain("      CurrentPage = page");
    expect(app).toContain("    pageCmd page");
    // UrlChanged re-parses, resets the byId field to Loading, and re-fires pageCmd.
    expect(app).toContain(
      "  | UrlChanged segments ->\n      let page = parseUrl segments\n" +
        "      { model with CurrentPage = page; ProductById = Loading }, pageCmd page",
    );
  });

  it("threads the route id into the detail view fn (renderRouteId un-stubbed)", async () => {
    const app = await appFs(DETAIL);
    expect(app).toContain(
      "let productDetailView (model: Model) (dispatch: Msg -> unit) (id: string) =",
    );
    // The root view passes the bound id to the detail view.
    expect(app).toContain("      | ProductDetail id -> productDetailView model dispatch id");
    // No unimplemented-seam sentinel leaked from `byId(id)`.
    expect(app).not.toContain("unsupported expr");
  });

  it("renders the single QueryView through View.remoteOne", async () => {
    const app = await appFs(DETAIL);
    expect(app).toContain("let remoteOne (r: Remote<'T option>)");
    expect(app).toContain("| Loaded (Some item) -> render item");
    expect(app).toContain("(View.remoteOne model.ProductById");
    // The list read still uses remoteList.
    expect(app).toContain("(View.remoteList model.AllProducts");
  });

  // A list-only (no byId) multi-page ui gets no pageCmd / remoteOne — the byId
  // machinery is strictly additive.
  it("a list-only ui emits no pageCmd or remoteOne", async () => {
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
          page Home { route: "/" body: Heading { "Home", level: 1 } }
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
    expect(app).not.toContain("pageCmd");
    expect(app).not.toContain("remoteOne");
    // The list-only routing stays on the inline-parse init form.
    expect(app).toContain("CurrentPage = parseUrl (Router.currentUrl ())");
  });

  // Reachability — the detail system must PARSE + VALIDATE cleanly
  // (generator tests bypass validateLoomModel; experience_gathered.md §22).
  it("validates cleanly through validateLoomModel", async () => {
    const { errors } = await parseString(DETAIL, { validate: true });
    expect(errors).toEqual([]);
  });
});
