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
        Text { \`Clicks: {count}\` },
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
    expect(app).toContain("| AllProductsLoaded of Result<Product list * PageMeta, string>");
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
    // The landmark's accessible name is pack-chrome — translated through the
    // generated `I18n` module once the app has any extractable string (M-T1.11).
    expect(app).toContain(
      'Html.nav [ prop.className "navbar bg-base-200 rounded-box mb-4"; prop.ariaLabel (I18n.t "chrome.primaryNav" "Primary navigation")',
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
    expect(app).toContain(
      'prop.href "#main-content"; prop.text (I18n.t "chrome.skipToContent" "Skip to content")',
    );
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
    // Needles that occur ONLY in the shell — the i18n catalog also carries the
    // two chrome KEYS, at its own (deeper) indentation.
    const skip = indent('prop.href "#main-content"');
    const nav = indent('Html.nav [ prop.className "navbar');
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

  // A SINGLE page that NAVIGATES — the gap between the two conditions that used
  // to decide this.  `routed` is false (one page, no `:param`) and there is no
  // form, but `Button { to: }` still reaches `Router.navigatePath` through the
  // `renderNavigateExpr` seam.  The open was therefore missing and `dotnet
  // fable` failed outright:
  //
  //   ./src/App.fs(84,80): error FSHARP: The value, namespace, type or module
  //   'Router' is not defined.
  //
  // Neither this nor the counter case above is "single page ⇒ no router" — the
  // question is whether the BODY navigates.
  const SINGLE_PAGE_NAV = `
    system S {
      subdomain S { context C { } }
      ui WebApp {
        framework: feliz
        page Home {
          route: "/"
          body: Stack { Button { "New", to: "/new" } }
        }
      }
      deployable api { platform: node contexts: [C] port: 3000 }
      deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
    }
  `;

  it("a navigating Button opens Feliz.Router even on a single formless page", async () => {
    const app = await appFs(SINGLE_PAGE_NAV);
    expect(app).toContain("Router.navigatePath");
    expect(app).toContain("open Feliz.Router");
    // Still not ROUTED — no Page union / React.router root. Only the open.
    expect(app).not.toContain("type Page =");
    expect(app).not.toContain("React.router");
  });

  it("and the fsproj references the package that open needs", async () => {
    // The two used to be independent predicates over the model, free to
    // disagree; the fsproj now reads the emitted App.fs. A missing reference for
    // code that is emitted is a build failure, not a cosmetic drift.
    expect(await fsproj(SINGLE_PAGE_NAV)).toContain('Include="Feliz.Router"');
  });

  // Reachability — the multi-page system must PARSE + VALIDATE cleanly
  // (generator tests bypass validateLoomModel; experience_gathered.md §22).
  it("validates cleanly through validateLoomModel", async () => {
    const { errors } = await parseString(MULTI, { validate: true });
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A14 — NAMED route params (not just the magic `id`).
//
// `routePattern` bound only the FIRST `:param` of a route and renamed it to
// `id`, and `renderPageView` threaded an EMPTY `paramNames` set into the walk.
// So a page with `route: "/greet/:who"`:
//
//   • bound a local `id` nothing in the body referred to, and
//   • rendered every `who` reference as `/* unresolved: who */ undefined` —
//     a JS comment plus an unbound name, spliced into F# source that cannot
//     compile.  A second `:param` was matched as `_` and dropped outright.
//
// Each `:param` now binds under its own name, the `Page` case carries one field
// per param, and the view fn takes them as arguments.  The scaffold's `/:id`
// detail pages are unaffected (their param IS named `id`), which is the
// byte-identity claim below.
// ---------------------------------------------------------------------------
const NAMED_PARAM = `
system Greeter {
  api GreetApi from Sub
  subdomain Sub {
    context C {
      aggregate Note with crudish { text: string }
      repository Notes for Note { }
    }
  }
  storage db { type: postgres }
  resource cState { for: C, kind: state, use: db }
  ui WebApp {
    api Api: GreetApi
    page Home { route: "/" body: Stack { Heading { "Home", level: 1 } } }
    page Greet(who: string) {
      route: "/greet/:who"
      body: Stack {
        Heading { "Greeting", level: 1 },
        Text { who },
        Anchor { "Again", to: "/greet/" + who }
      }
    }
  }
  deployable api { platform: node contexts: [C] dataSources: [cState] serves: GreetApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Api: api } port: 3005 }
}
`;

/** Two named params on one route — the case that used to lose the second one
 *  entirely (matched `_`, never bound, never passed to the view). */
const TWO_PARAMS = NAMED_PARAM.replace(
  'page Greet(who: string) {\n      route: "/greet/:who"',
  'page Greet(who: string, mood: string) {\n      route: "/greet/:who/:mood"',
).replace("Text { who },", "Text { who }, Text { mood },");

describe("feliz named route params", () => {
  it("binds the param under ITS OWN name — pattern, case, and view fn", async () => {
    const app = await appFs(NAMED_PARAM);
    expect(app).toContain("  | Greet of string");
    expect(app).toContain('  | [ "greet"; who ] -> Greet who');
    expect(app).toContain("let greetView (model: Model) (dispatch: Msg -> unit) (who: string) =");
    expect(app).toContain("| Greet who -> greetView model dispatch who");
  });

  it("resolves body references to the param (no unresolved-name sentinel)", async () => {
    const app = await appFs(NAMED_PARAM);
    // The walk now knows `who` is in scope, so it renders as the bare local…
    expect(app).toContain('prop.href ("/greet/" + who)');
    // …and NOT as the give-up placeholder, which is not even valid F#.
    expect(app).not.toContain("unresolved: who");
    expect(app).not.toContain("undefined");
  });

  it("binds EVERY param of a multi-param route", async () => {
    const app = await appFs(TWO_PARAMS);
    expect(app).toContain("  | Greet of string * string");
    expect(app).toContain('  | [ "greet"; who; mood ] -> Greet (who, mood)');
    expect(app).toContain(
      "let greetView (model: Model) (dispatch: Msg -> unit) (who: string) (mood: string) =",
    );
    expect(app).toContain("| Greet (who, mood) -> greetView model dispatch who mood");
    expect(app).not.toContain("unresolved: mood");
  });

  it("leaves the scaffold's `/:id` detail route byte-identical", async () => {
    // The magic route `id` is just a route param that happens to be named `id`,
    // so the general binding must reproduce exactly what the special case did.
    const app = await appFs(MULTI.replace('route: "/products"', 'route: "/products/:id"'));
    expect(app).toContain("  | Products of string");
    expect(app).toContain('  | [ "products"; id ] -> Products id');
    expect(app).toContain("let productsView (model: Model) (dispatch: Msg -> unit) (id: string) =");
    expect(app).toContain("| Products id -> productsView model dispatch id");
  });
});
