import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Embedded-SPA host on the vanilla (plain Ecto/Phoenix) foundation —
// mission M-T6.1 (docs/new-plan/T6-backend-parity.md), phase 6 of
// docs/old/plans/phoenix-surface-generator-wiring.md.
//
// A `platform: elixir` deployable that `hosts:` a `framework: react|vue|svelte`
// ui is a JSON-API backend that ALSO serves a client-side SPA.  Before this
// mission the combination silently emitted a UI-less project (LiveView skipped,
// nothing emitted in its place).  Now the orchestrator:
//   - emits the SPA project under `assets/` (Phoenix's JS home) with
//     `apiBaseUrl: "/api"` (same-origin) + `basePath: "/app"` (served sub-path);
//   - serves it at `/app` via the endpoint `Plug.Static`;
//   - adds the `/app/*` client-side deep-link fallback + `/` → `/app` redirect
//     through a `SpaController`;
//   - packages it via the Dockerfile's `spa-build` stage → `priv/static/app`.
//
// The non-hosting JSON-API-only deployable stays byte-identical (no SPA tree,
// no `SpaController`, no `:spa` pipeline, single-stage Dockerfile).
// ---------------------------------------------------------------------------

const EMBED_SOURCE = `
system Shop {
  subdomain Catalog {
    context Catalog {
      aggregate Product {
        name: string
        price: decimal
        invariant name.length > 0
      }
      repository Products for Product { }
    }
  }
  api CatalogApi from Catalog
  ui Storefront {
    framework: react
    page Products {
      route: "/products"
      title: "Products"
      body: Stack { Heading { "Products", level: 2 } }
    }
  }
  storage primary { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: primary }
  deployable phoenixApp {
    platform: elixir
    contexts: [Catalog]
    dataSources: [catalogState]
    serves: CatalogApi
    hosts: Storefront
    port: 4000
    design: mantine
  }
}
`;

// Same system, minus the ui + `hosts:` — the plain JSON-API-only backend.
const PLAIN_SOURCE = `
system Shop {
  subdomain Catalog {
    context Catalog {
      aggregate Product {
        name: string
        price: decimal
        invariant name.length > 0
      }
      repository Products for Product { }
    }
  }
  api CatalogApi from Catalog
  storage primary { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: primary }
  deployable phoenixApp {
    platform: elixir
    contexts: [Catalog]
    dataSources: [catalogState]
    serves: CatalogApi
    port: 4000
  }
}
`;

// Same system, hosting a `framework: angular` ui instead.  Angular has the
// deeper base-href requirement: served under `/app`, its bundle must build with
// `baseHref: "/app/"` (angular.json build option) + `<base href="/app/">` in
// index.html, or its asset URLs and client-side deep links break — the analog
// of svelte's `kit.paths.base`.  `ng build` nests the browser artefacts under
// `dist/browser/`, so the Dockerfile copies `/spa/dist/browser`.
const ANGULAR_EMBED_SOURCE = `
system Shop {
  subdomain Catalog {
    context Catalog {
      aggregate Product {
        name: string
        price: decimal
        invariant name.length > 0
      }
      repository Products for Product { }
    }
  }
  api CatalogApi from Catalog
  ui Storefront {
    framework: angular
    page Products {
      route: "/products"
      title: "Products"
      body: Stack { Heading { "Products", level: 2 } }
    }
  }
  storage primary { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: primary }
  deployable phoenixApp {
    platform: elixir
    contexts: [Catalog]
    dataSources: [catalogState]
    serves: CatalogApi
    hosts: Storefront
    port: 4000
    design: angularMaterial
  }
}
`;

// Same system, hosting a `framework: feliz` (Fable/Feliz/Elmish F#) ui.  Feliz
// is NOT a node-only Vite SPA: it builds F# → JS via `dotnet fable` then bundles
// via `vite build`, so its Dockerfile spa-build stage needs a .NET-SDK+Node base
// image (`mcr.microsoft.com/dotnet/sdk` + `dotnet tool restore`), not the
// node-only stage the React/Vue/Svelte/Angular embeds use.  Its vite output is
// flat `dist/` (like React/Vue), and `basePath: "/app"` threads into vite `base`.
const FELIZ_EMBED_SOURCE = `
system Shop {
  subdomain Catalog {
    context Catalog {
      aggregate Product {
        name: string
        price: decimal
        invariant name.length > 0
      }
      repository Products for Product { }
    }
  }
  api CatalogApi from Catalog
  ui Storefront {
    framework: feliz
    page Products {
      route: "/products"
      title: "Products"
      body: Stack { Heading { "Products", level: 2 } }
    }
  }
  storage primary { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: primary }
  deployable phoenixApp {
    platform: elixir
    contexts: [Catalog]
    dataSources: [catalogState]
    serves: CatalogApi
    hosts: Storefront
    port: 4000
  }
}
`;

function endsWith(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla Phoenix embedded-SPA host (M-T6.1)", () => {
  it("emits the React SPA project under assets/ served at /app on the same-origin /api", async () => {
    const files = await generateSystemFiles(EMBED_SOURCE);
    const keys = [...files.keys()];
    // The SPA project lands under the Phoenix deployable's `assets/` dir.
    expect(keys.some((k) => k.endsWith("/assets/package.json"))).toBe(true);
    expect(keys.some((k) => k.endsWith("/assets/src/App.tsx"))).toBe(true);
    // Same-origin API base + `/app` served sub-path (vite base `/app/`).
    const apiConfig = endsWith(files, "/assets/src/api/config.ts");
    expect(apiConfig).toContain('"/api"');
    const vite = endsWith(files, "/assets/vite.config.ts");
    expect(vite).toContain('base: "/app/"');
  });

  it("emits the SpaController (root redirect + deep-link fallback)", async () => {
    const files = await generateSystemFiles(EMBED_SOURCE);
    const spa = endsWith(files, "/controllers/spa_controller.ex");
    expect(spa).toContain("defmodule PhoenixAppWeb.SpaController");
    expect(spa).toContain('redirect(conn, to: "/app")');
    expect(spa).toContain(
      'send_file(200, Application.app_dir(:phoenix_app, "priv/static/app/index.html"))',
    );
  });

  it("serves the SPA from priv/static/app at /app via Plug.Static", async () => {
    const files = await generateSystemFiles(EMBED_SOURCE);
    const endpoint = endsWith(files, "_web/endpoint.ex");
    expect(endpoint).toContain('at: "/app"');
    expect(endpoint).toContain('from: {:phoenix_app, "priv/static/app"}');
  });

  it("routes /, /app and /app/* through the SpaController via an :spa pipeline", async () => {
    const files = await generateSystemFiles(EMBED_SOURCE);
    const router = endsWith(files, "_web/router.ex");
    expect(router).toContain("pipeline :spa do");
    expect(router).toContain('get "/", SpaController, :redirect_to_app');
    expect(router).toContain('get "/app", SpaController, :index');
    expect(router).toContain('get "/app/*path", SpaController, :index');
  });

  it("packages the SPA via a multi-stage Dockerfile (spa-build → priv/static/app)", async () => {
    const files = await generateSystemFiles(EMBED_SOURCE);
    const dockerfile = endsWith(files, "phoenix_app/Dockerfile");
    expect(dockerfile).toContain("AS spa-build");
    expect(dockerfile).toContain("COPY assets/package.json");
    expect(dockerfile).toContain("COPY --from=spa-build /spa/dist priv/static/app");
  });

  it("emits no LiveView pages for a hosted-SPA deployable", async () => {
    const files = await generateSystemFiles(EMBED_SOURCE);
    const keys = [...files.keys()];
    expect(keys.some((k) => k.includes("_live") || k.endsWith("_live.ex"))).toBe(false);
    expect(keys.some((k) => k.endsWith("/nav.ex"))).toBe(false);
  });

  it("emits the Angular SPA under assets/ with base-href /app/ (angular.json + index.html)", async () => {
    const files = await generateSystemFiles(ANGULAR_EMBED_SOURCE);
    const keys = [...files.keys()];
    // The Angular project lands under the Phoenix deployable's `assets/` dir.
    expect(keys.some((k) => k.endsWith("/assets/package.json"))).toBe(true);
    expect(keys.some((k) => k.endsWith("/assets/angular.json"))).toBe(true);
    expect(keys.some((k) => k.endsWith("/assets/src/main.ts"))).toBe(true);
    // Same-origin API base.
    const apiConfig = endsWith(files, "/assets/src/api/config.ts");
    expect(apiConfig).toContain('"/api"');
    // Base-href threaded into BOTH the angular.json build option and the
    // `<base>` tag so `/app`-mounted asset URLs + deep links resolve.
    const angularJson = endsWith(files, "/assets/angular.json");
    expect(angularJson).toContain('"baseHref": "/app/"');
    const indexHtml = endsWith(files, "/assets/src/index.html");
    expect(indexHtml).toContain('<base href="/app/" />');
  });

  it("packages the Angular SPA (dist/browser → priv/static/app) and wires the SpaController", async () => {
    const files = await generateSystemFiles(ANGULAR_EMBED_SOURCE);
    // `ng build` nests under `dist/browser/`, so the Dockerfile copies that.
    const dockerfile = endsWith(files, "phoenix_app/Dockerfile");
    expect(dockerfile).toContain("AS spa-build");
    expect(dockerfile).toContain("COPY --from=spa-build /spa/dist/browser priv/static/app");
    // Same framework-agnostic /app serving wiring as the React arm.
    const spa = endsWith(files, "/controllers/spa_controller.ex");
    expect(spa).toContain("defmodule PhoenixAppWeb.SpaController");
    const endpoint = endsWith(files, "_web/endpoint.ex");
    expect(endpoint).toContain('at: "/app"');
    expect(endpoint).toContain('from: {:phoenix_app, "priv/static/app"}');
    const router = endsWith(files, "_web/router.ex");
    expect(router).toContain('get "/app/*path", SpaController, :index');
    // No LiveView pages for a hosted-SPA deployable.
    expect([...files.keys()].some((k) => k.includes("_live") || k.endsWith("_live.ex"))).toBe(
      false,
    );
  });

  it("emits the Feliz SPA under assets/ with vite base /app/ (App.fsproj + dotnet-tools)", async () => {
    const files = await generateSystemFiles(FELIZ_EMBED_SOURCE);
    const keys = [...files.keys()];
    // The Feliz project lands under the Phoenix deployable's `assets/` dir —
    // the F# project file + Fable tool manifest, not a package.json-only tree.
    expect(keys.some((k) => k.endsWith("/assets/App.fsproj"))).toBe(true);
    expect(keys.some((k) => k.endsWith("/assets/.config/dotnet-tools.json"))).toBe(true);
    expect(keys.some((k) => k.endsWith("/assets/src/App.fs"))).toBe(true);
    expect(keys.some((k) => k.endsWith("/assets/package.json"))).toBe(true);
    // `basePath: "/app"` threads into vite `base` so `/app`-mounted asset URLs
    // resolve (Feliz's vite config, not a `.ts` one — the F# host emits `.js`).
    const vite = endsWith(files, "/assets/vite.config.js");
    expect(vite).toContain('base: "/app/"');
  });

  it("packages the Feliz SPA via a .NET-SDK+Node spa-build stage (dotnet fable → dist)", async () => {
    const files = await generateSystemFiles(FELIZ_EMBED_SOURCE);
    const dockerfile = endsWith(files, "phoenix_app/Dockerfile");
    // Feliz builds via `dotnet fable` + `vite build`, so the spa-build stage
    // uses a .NET-SDK+Node base image (NOT the node-only vite stage) and runs
    // `dotnet tool restore` before the npm build.
    expect(dockerfile).toContain("AS spa-build");
    expect(dockerfile).toContain("mcr.microsoft.com/dotnet/sdk");
    expect(dockerfile).toContain("dotnet tool restore");
    expect(dockerfile).not.toContain("node:24-alpine AS spa-build");
    // Flat `dist/` output copied into priv/static/app (same as React/Vue).
    expect(dockerfile).toContain("COPY --from=spa-build /spa/dist priv/static/app");
    // Same framework-agnostic /app serving wiring as the React/Angular arms.
    const spa = endsWith(files, "/controllers/spa_controller.ex");
    expect(spa).toContain("defmodule PhoenixAppWeb.SpaController");
    const endpoint = endsWith(files, "_web/endpoint.ex");
    expect(endpoint).toContain('at: "/app"');
    expect(endpoint).toContain('from: {:phoenix_app, "priv/static/app"}');
    const router = endsWith(files, "_web/router.ex");
    expect(router).toContain('get "/app/*path", SpaController, :index');
    // No LiveView pages for a hosted-SPA deployable.
    expect([...files.keys()].some((k) => k.includes("_live") || k.endsWith("_live.ex"))).toBe(
      false,
    );
  });

  it("leaves the plain JSON-API-only deployable byte-identical (no SPA wiring)", async () => {
    const files = await generateSystemFiles(PLAIN_SOURCE);
    const keys = [...files.keys()];
    expect(keys.some((k) => k.includes("/assets/"))).toBe(false);
    expect(keys.some((k) => k.endsWith("/controllers/spa_controller.ex"))).toBe(false);
    const router = endsWith(files, "_web/router.ex");
    expect(router).not.toContain("pipeline :spa");
    expect(router).not.toContain("SpaController");
    const endpoint = endsWith(files, "_web/endpoint.ex");
    expect(endpoint).not.toContain('at: "/app"');
    const dockerfile = endsWith(files, "phoenix_app/Dockerfile");
    expect(dockerfile).not.toContain("AS spa-build");
  });
});
