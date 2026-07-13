// Feliz mutations (v1: delete) — a `DestroyForm(of: X)` on a detail page emits a
// delete button that DISPATCHES `Delete<Agg> id`; the mutation `Cmd` + navigate-
// on-success live in `update`, over a `DELETE /api/<agg>/<id>` Api fn.  The
// emitted F# is proven to compile via `dotnet fable` (SDK:8.0) + vite build.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

// A detail page with a byId read + a DestroyForm (the canonical delete surface).
const DELETE = `
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
    page ProductDetail {
      route: "/products/:id"
      body: Stack {
        Heading { "Product", level: 1 },
        QueryView {
          of: Shop.Product.byId(id),
          single: true,
          loading: Text { "Loading…" }, error: Text { "Failed" }, empty: Text { "Not found" },
          data: p => Card { p.name }
        },
        DestroyForm { of: Product },
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

describe("feliz delete mutations", () => {
  it("emits a DELETE Api fn (Http.request DELETE, 2xx → Ok ())", async () => {
    const app = await appFs(DELETE);
    expect(app).toContain("let deleteProduct (id: string) : Async<Result<unit, string>> =");
    expect(app).toContain('Http.request (sprintf "/api/products/%s" id)');
    expect(app).toContain("|> Http.method DELETE");
    expect(app).toContain("|> Http.send");
    expect(app).toContain(
      "if response.statusCode = 200 || response.statusCode = 204 then\n        return Ok ()",
    );
  });

  it("adds the mutation Msg cases (trigger + result)", async () => {
    const app = await appFs(DELETE);
    expect(app).toContain("| DeleteProduct of string");
    expect(app).toContain("| ProductDeleted of Result<unit, string>");
  });

  it("wires the delete update arms (fire Cmd, navigate on success)", async () => {
    const app = await appFs(DELETE);
    expect(app).toContain(
      "  | DeleteProduct id -> model, Cmd.OfAsync.perform Api.deleteProduct id ProductDeleted",
    );
    expect(app).toContain('  | ProductDeleted (Ok ()) -> model, Cmd.navigate("products")');
    expect(app).toContain("  | ProductDeleted (Error _) -> model, Cmd.none");
  });

  it("the DestroyForm renders a button that dispatches Delete<Agg> id", async () => {
    const app = await appFs(DELETE);
    expect(app).toContain(
      'Html.button [ prop.onClick (fun _ -> dispatch (DeleteProduct id)); prop.text "Delete Product" ]',
    );
    // No React/RHF sentinel leaked from the shared DestroyForm default path.
    expect(app).not.toContain("window.confirm");
    expect(app).not.toContain("mutateAsync");
  });

  // A read-only ui (no DestroyForm) emits no delete machinery — mutations are
  // strictly additive.
  it("a read-only ui emits no delete Api/Msg", async () => {
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
    expect(app).not.toContain("deleteProduct");
    expect(app).not.toContain("DeleteProduct");
    expect(app).not.toContain("Http.method DELETE");
  });

  // Reachability — the delete system must PARSE + VALIDATE cleanly
  // (generator tests bypass validateLoomModel; experience_gathered.md §22).
  it("validates cleanly through validateLoomModel", async () => {
    const { errors } = await parseString(DELETE, { validate: true });
    expect(errors).toEqual([]);
  });
});
