import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Fullstack `platform: dotnet` hosting a `framework: angular` ui — the Angular
// arm of the .NET embed dispatch, at parity with the react/vue/svelte arms.
//
// A single .NET deployable that BOTH serves the API AND embeds the Angular SPA
// under ClientApp/ served from wwwroot/.  Angular's `ng build`
// (@angular/build:application) nests the browser bundle under `dist/browser/`,
// so the multi-stage Dockerfile's COPY differs from the vite `dist/` (react /
// vue) and SvelteKit `build/` arms — the same non-flat build-output quirk as
// svelte.  Controllers stay under /api/*; Program.cs serves the bundle via
// UseStaticFiles + MapFallbackToFile.
// ---------------------------------------------------------------------------

const SRC = `
system EmbedAngular {
  subdomain Sales {
    context Orders {
      aggregate Customer with crudish {
        name: string
        derived display: string = name
      }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }
  ui WebApp with scaffold(subdomains: [Sales]) {
    framework: angular
    api Sales: SalesApi
  }
  deployable app {
    platform: dotnet
    contexts: [Orders]
    dataSources: [ordersState]
    serves: SalesApi
    ui: WebApp
    port: 8080
    design: angularMaterial
  }
}
`;

const BACKEND_ONLY = `system BackendOnly {
  subdomain Sales {
    context Orders {
      aggregate Customer with crudish {
        name: string
        derived display: string = name
      }
      repository Customers for Customer { }
    }
  }
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }
  deployable app {
    platform: dotnet
    contexts: [Orders]
    dataSources: [ordersState]
    port: 8080
  }
}
`;

describe("fullstack dotnet — embeds an Angular SPA alongside the API", () => {
  it("emits the Angular project under ClientApp/ (no more tsconfig-node crash)", async () => {
    const files = await generateSystemFiles(SRC);
    expect(files.has("app/Program.cs")).toBe(true);
    expect(files.has("app/ClientApp/package.json")).toBe(true);
    expect(files.has("app/ClientApp/angular.json")).toBe(true);
    expect(files.has("app/ClientApp/src/main.ts")).toBe(true);
  });

  it("threads apiBaseUrl: '/api' into the SPA's api config", async () => {
    const files = await generateSystemFiles(SRC);
    const config = files.get("app/ClientApp/src/api/config.ts")!;
    expect(config).toContain("/api");
  });

  it("serves the SPA via UseStaticFiles + MapFallbackToFile in Program.cs", async () => {
    const files = await generateSystemFiles(SRC);
    const program = files.get("app/Program.cs")!;
    expect(program).toMatch(/app\.UseStaticFiles\(\);/);
    expect(program).toMatch(/app\.MapFallbackToFile\("index\.html"\);/);
  });

  it("keeps controller routes under /api/", async () => {
    const files = await generateSystemFiles(SRC);
    const controller = files.get("app/Api/CustomersController.cs")!;
    expect(controller).toMatch(/\[Route\("api\/customers"\)\]/);
  });

  it("copies the Angular dist/browser bundle into wwwroot/ (not vite dist/ or svelte build/)", async () => {
    const files = await generateSystemFiles(SRC);
    const dockerfile = files.get("app/Dockerfile")!;
    expect(dockerfile).toMatch(/FROM node:24-alpine AS spa-build/);
    expect(dockerfile).toContain("COPY --from=spa-build /spa/dist/browser ./wwwroot");
  });

  it("drops host-owned shell files and gitignores the Angular outputs", async () => {
    const files = await generateSystemFiles(SRC);
    expect(files.has("app/ClientApp/Dockerfile")).toBe(false);
    expect(files.has("app/ClientApp/.dockerignore")).toBe(false);
    expect(files.get("app/ClientApp/.gitignore")).toContain(".angular");
    expect([...files.keys()].some((p) => p.startsWith("app/ClientApp/e2e/"))).toBe(false);
  });
});

describe("fullstack dotnet — backend-only mode stays standalone (no Angular leak)", () => {
  it("does NOT emit ClientApp/ or the SPA static-files block when 'ui:' is absent", async () => {
    const files = await generateSystemFiles(BACKEND_ONLY);
    expect([...files.keys()].some((p) => p.startsWith("app/ClientApp/"))).toBe(false);
    const program = files.get("app/Program.cs")!;
    expect(program).not.toMatch(/MapFallbackToFile/);
    const dockerfile = files.get("app/Dockerfile")!;
    expect(dockerfile).not.toMatch(/spa-build/);
    expect(dockerfile).not.toMatch(/wwwroot/);
  });
});
