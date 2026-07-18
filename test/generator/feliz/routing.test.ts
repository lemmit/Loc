// Feliz multi-page routing — a >1-page ui emits a `Page` union + `parseUrl` +
// a `React.router` root over a combined Model (Feliz.Router).  Single-page uis
// stay byte-identical (no router).  The emitted F# is proven to compile via
// `dotnet fable` (SDK:8.0 container); this pins the routing projection so a
// regression surfaces in the fast suite before the docker gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

// Two pages: a Home counter (state + action) and a Products data page
// (QueryView read), plus a cross-page nav button.
const MULTI = `
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
    page Home {
      route: "/"
      state { count: int = 0 }
      action inc() { count := count + 1 }
      body: Stack {
        Heading { "Home", level: 1 },
        Text { "Clicks: " + count },
        Button { "+", onClick: inc },
        Button { "Products", to: "/products" }
      }
    }
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
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}
`;

async function appFs(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}
async function fsproj(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("App.fsproj"))![1];
}

describe("feliz multi-page routing", () => {
  it("emits a Page union + parseUrl from the pages' routes", async () => {
    const app = await appFs(MULTI);
    expect(app).toContain("open Feliz.Router");
    expect(app).toContain("type Page =\n  | Home\n  | Products");
    // parseUrl maps URL segments → the active Page; first page is the fallback.
    expect(app).toContain("let parseUrl (segments: string list) : Page =");
    expect(app).toContain("  | [] -> Home");
    expect(app).toContain('  | [ "products" ] -> Products');
    expect(app).toContain("  | _ -> Home");
  });

  it("builds a combined Model + Msg across all pages (with routing)", async () => {
    const app = await appFs(MULTI);
    // Combined Model: CurrentPage leads, then Home's state, then the read.
    expect(app).toContain("CurrentPage: Page");
    expect(app).toContain("Count: int");
    expect(app).toContain("AllProducts: Remote<Product list>");
    // Msg carries UrlChanged + the action + the read's Loaded.
    expect(app).toContain("| UrlChanged of string list");
    expect(app).toContain("| Inc");
    expect(app).toContain("| AllProductsLoaded of Result<Product list, string>");
    // init parses the URL; update re-parses on UrlChanged.
    expect(app).toContain("CurrentPage = parseUrl (Router.currentPath ())");
    expect(app).toContain(
      "| UrlChanged segments -> { model with CurrentPage = parseUrl segments }, Cmd.none",
    );
  });

  it("emits per-page view functions + a React.router root", async () => {
    const app = await appFs(MULTI);
    expect(app).toContain("let homeView (model: Model) (dispatch: Msg -> unit) =");
    expect(app).toContain("let productsView (model: Model) (dispatch: Msg -> unit) =");
    expect(app).toContain("let view (model: Model) (dispatch: Msg -> unit) =");
    expect(app).toContain("React.router [");
    // PATH-based routing (History API), not hash — the router runs in `pathMode`
    // and the initial page parses from `Router.currentPath ()` (asserted above),
    // so the generated SPA routes by `/products`, not `#/products`.
    expect(app).toContain("router.pathMode");
    expect(app).toContain("router.onUrlChanged (UrlChanged >> dispatch)");
    expect(app).toContain("match model.CurrentPage with");
    expect(app).toContain("      | Home -> homeView model dispatch");
    expect(app).toContain("      | Products -> productsView model dispatch");
  });

  it("wraps the router in a persistent daisyUI navbar over the top-level pages", async () => {
    const app = await appFs(MULTI);
    // A persistent shell: the navbar sits above the route-swapping router.
    // The bar is a real <nav> landmark with an accessible name (a11y contract).
    expect(app).toContain(
      'Html.nav [ prop.className "navbar bg-base-200 rounded-box mb-4"; prop.ariaLabel "Primary navigation"',
    );
    expect(app).toContain('Html.ul [ prop.className "menu menu-horizontal px-1"');
    // One menu item per top-level (static-route) page — the brand + both pages.
    expect(app).toContain('prop.href "/"; prop.text "Home"');
    expect(app).toContain('prop.href "/products"; prop.text "Products"');
    // The brand is the humanised ui name.
    expect(app).toContain(
      'prop.className "btn btn-ghost text-xl"; prop.href "/"; prop.text "Web App"',
    );
  });

  it("routed content is a <main> landmark reachable via a skip link", async () => {
    const app = await appFs(MULTI);
    // WCAG 2.4.1 Bypass Blocks — the skip link is the first focusable element,
    // visually hidden until focused, and jumps past the nav to the <main>.
    expect(app).toContain('prop.href "#main-content"; prop.text "Skip to content"');
    // The route-swapping router lives inside the <main id="main-content">.
    expect(app).toContain('Html.main [ prop.id "main-content"; prop.children [');
  });

  // Regression (main went red on feliz-build at d1ebf8a): the shell's three
  // top-level children — skip link, <nav>, <main> — are a newline-separated F#
  // element list, so F# keys each element by its first-token COLUMN. The navbar
  // is rendered at a 4-space base and re-indented to sit beside the 6-space skip
  // link + <main>; if the columns disagree, F# reads the skip link as a function
  // applied to the nav ("This value is not a function"). A substring `toContain`
  // is blind to indentation — this pins the columns are equal.
  it("the shell's skip-link / <nav> / <main> share one offside column", async () => {
    const app = await appFs(MULTI);
    const indent = (needle: string): number => {
      const line = app.split("\n").find((l) => l.includes(needle));
      expect(line, `line with ${needle}`).toBeDefined();
      return line!.length - line!.trimStart().length;
    };
    const skip = indent('prop.text "Skip to content"');
    const nav = indent('prop.ariaLabel "Primary navigation"');
    const main = indent('Html.main [ prop.id "main-content"');
    expect(nav).toBe(skip);
    expect(main).toBe(skip);
  });

  it("cross-page nav renders Router.navigate + fsproj pulls Feliz.Router", async () => {
    const app = await appFs(MULTI);
    // Button(to: "/products") → Router.navigatePath("products").
    expect(app).toContain('Router.navigatePath("products")');
    expect(app).not.toContain('navigate("/products")'); // the old broken form
    const proj = await fsproj(MULTI);
    expect(proj).toContain('Include="Feliz.Router"');
  });

  it("a single-page ui stays router-free (byte-preserved)", async () => {
    const app = await appFs(`
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
    expect(app).not.toContain("open Feliz.Router");
    expect(app).not.toContain("type Page =");
    expect(app).not.toContain("CurrentPage");
    expect(app).not.toContain("React.router");
    expect(app).toContain("let view (model: Model) (dispatch: Msg -> unit) =");
  });

  // Reachability — the multi-page system must PARSE + VALIDATE cleanly
  // (generator tests bypass validateLoomModel; experience_gathered.md §22).
  it("validates cleanly through validateLoomModel", async () => {
    const { errors } = await parseString(MULTI, { validate: true });
    expect(errors).toEqual([]);
  });
});
