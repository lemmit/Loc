import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// M-T6.1 (D-PHOENIX-SURFACE phase 6) — a plain-Ecto Phoenix deployable that
// `hosts:` a `framework: react|vue|svelte` ui is a JSON-API backend that ALSO
// serves that SPA.  The orchestrator emits the domain + `/api` controllers
// (no LiveView pages), generates the SPA under `assets/` (same-origin `/api`,
// base-href `/app`), and wires the three serve seams: endpoint `Plug.Static`
// for `priv/static/app`, a router `/app` `SpaController` catch-all, and the
// multi-stage Dockerfile `spa-build` stage.  Before this wiring the scaffolding
// existed but was dead, so the combination silently emitted a UI-less project.
// ---------------------------------------------------------------------------

function ui(framework: string): string {
  return `
system EmbedPhoenix {
  subdomain Catalog {
    context Catalog {
      aggregate Product with crudish {
        name: string
        derived display: string = name
      }
      repository Products for Product { }
    }
  }
  api CatalogApi from Catalog
  ui Storefront with scaffold(subdomains: [Catalog]) {
    framework: ${framework}
    api Catalog: CatalogApi
  }
  storage primary { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: primary }
  deployable app {
    platform: elixir
    contexts: [Catalog]
    dataSources: [catalogState]
    serves: CatalogApi
    hosts: Storefront
    port: 4000
  }
}
`;
}

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("phoenix hosts a react SPA (D-PHOENIX-SURFACE phase 6)", () => {
  it("emits the React project under assets/ with same-origin /api + base-href /app", async () => {
    const out = await generateSystemFiles(ui("react"));
    // The SPA source lands under assets/ (the Dockerfile spa-build stage
    // COPYs from there), not the dotnet/java ClientApp/ prefix.
    expect([...out.keys()].some((k) => k.endsWith("app/assets/package.json"))).toBe(true);
    expect([...out.keys()].some((k) => k.endsWith("app/assets/src/main.tsx"))).toBe(true);
    // Same-origin API + base-href /app (vite base + router basename).
    expect(file(out, "app/assets/src/api/config.ts")).toContain('"/api"');
    expect(file(out, "app/assets/vite.config.ts")).toContain('base: "/app/"');
    expect(file(out, "app/assets/src/main.tsx")).toContain('"/app"');
    // React → dist/ .gitignore; host-owned shell files dropped.
    expect(file(out, "app/assets/.gitignore")).toContain("dist");
    expect([...out.keys()].some((k) => k.endsWith("app/assets/Dockerfile"))).toBe(false);
    expect([...out.keys()].some((k) => k.endsWith("app/assets/.dockerignore"))).toBe(false);
  });

  it("wires the endpoint Plug.Static, router SpaController catch-all, and Dockerfile stage", async () => {
    const out = await generateSystemFiles(ui("react"));
    const endpoint = file(out, "_web/endpoint.ex");
    expect(endpoint).toContain("plug Plug.Static");
    expect(endpoint).toContain("only: ~w(app)");
    const router = file(out, "_web/router.ex");
    expect(router).toContain('scope "/app"');
    expect(router).toContain('get "/", SpaController, :index');
    expect(router).toContain('get "/*path", SpaController, :index');
    const spa = file(out, "_web/controllers/spa_controller.ex");
    expect(spa).toContain("defmodule");
    expect(spa).toContain("SpaController");
    expect(spa).toContain('"static/app/index.html"');
    const dockerfile = file(out, "app/Dockerfile");
    expect(dockerfile).toContain("AS spa-build");
    expect(dockerfile).toContain("RUN npm run build");
    expect(dockerfile).toContain("COPY --from=spa-build /spa/dist priv/static/app");
  });

  it("emits NO LiveView pages, socket, or live_session (the SPA owns the UI)", async () => {
    const out = await generateSystemFiles(ui("react"));
    expect(file(out, "_web/endpoint.ex")).not.toContain('socket "/live"');
    expect(file(out, "_web/router.ex")).not.toContain("live_session");
    // No HEEx LiveView page modules were emitted for the hosted aggregate.
    expect([...out.keys()].some((k) => /_web\/live\/.*\.ex$/.test(k))).toBe(false);
  });

  it("dispatches on the ui framework — svelte hosts copy build/ not dist/", async () => {
    const out = await generateSystemFiles(ui("svelte"));
    expect([...out.keys()].some((k) => k.endsWith("app/assets/svelte.config.js"))).toBe(true);
    expect(file(out, "app/Dockerfile")).toContain(
      "COPY --from=spa-build /spa/build priv/static/app",
    );
    expect(file(out, "app/assets/.gitignore")).toContain(".svelte-kit");
  });

  it("dispatches on the ui framework — vue hosts emit a vue project", async () => {
    const out = await generateSystemFiles(ui("vue"));
    expect([...out.keys()].some((k) => k.endsWith("app/assets/src/main.ts"))).toBe(true);
    expect(file(out, "app/assets/vite.config.ts")).toContain('base: "/app/"');
    expect(file(out, "app/Dockerfile")).toContain(
      "COPY --from=spa-build /spa/dist priv/static/app",
    );
  });
});
