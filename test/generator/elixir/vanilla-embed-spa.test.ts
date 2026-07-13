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
