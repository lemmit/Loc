import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Fullstack `platform: dotnet` hosting a `framework: feliz` ui — the Feliz arm
// of the .NET embed dispatch, at parity with the react/vue/svelte/angular arms.
//
// A single .NET deployable that BOTH serves the API AND embeds the Feliz
// (Fable/F#) SPA under ClientApp/, served from wwwroot/.  Feliz builds via
// `dotnet fable` + `vite build` (not npm-only), so the multi-stage Dockerfile's
// spa-build stage runs on a .NET-SDK+Node image (mcr.microsoft.com/dotnet/sdk +
// `dotnet tool restore`) instead of the `node:*-alpine` base the other four
// frameworks use.  Feliz's vite output is flat `dist/`, so the wwwroot COPY
// matches the react/vue arms.  Controllers stay under /api/*; Program.cs serves
// the bundle via UseStaticFiles + MapFallbackToFile.
// ---------------------------------------------------------------------------

const SRC = `
system EmbedFeliz {
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
    framework: feliz
    api Sales: SalesApi
  }
  deployable app {
    platform: dotnet
    contexts: [Orders]
    dataSources: [ordersState]
    serves: SalesApi
    ui: WebApp { Sales: app }
    port: 8080
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

describe("fullstack dotnet — embeds a Feliz SPA alongside the API", () => {
  it("emits the Feliz project under ClientApp/ (App.fsproj + vite + dotnet-tools)", async () => {
    const files = await generateSystemFiles(SRC);
    expect(files.has("app/Program.cs")).toBe(true);
    expect(files.has("app/ClientApp/App.fsproj")).toBe(true);
    expect(files.has("app/ClientApp/vite.config.js")).toBe(true);
    expect(files.has("app/ClientApp/.config/dotnet-tools.json")).toBe(true);
    expect(files.has("app/ClientApp/src/App.fs")).toBe(true);
    // The Fable tool manifest pins the `fable` dotnet tool the spa-build stage
    // restores.
    expect(files.get("app/ClientApp/.config/dotnet-tools.json")!).toContain("fable");
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

  it("builds the spa-build stage on the .NET SDK image (not node:*-alpine) and copies flat dist/ into wwwroot/", async () => {
    const files = await generateSystemFiles(SRC);
    const dockerfile = files.get("app/Dockerfile")!;
    // Feliz spa-build runs Fable — the .NET SDK image with Node layered on,
    // NOT the npm-only node:*-alpine base the vite arms use.
    expect(dockerfile).toMatch(/FROM mcr\.microsoft\.com\/dotnet\/sdk:8\.0 AS spa-build/);
    expect(dockerfile).not.toMatch(/FROM node:\d+-alpine AS spa-build/);
    expect(dockerfile).toContain("dotnet tool restore");
    // Flat vite dist/ (like react/vue) — not svelte build/ or angular dist/browser.
    expect(dockerfile).toContain("COPY --from=spa-build /spa/dist ./wwwroot");
  });

  it("drops host-owned shell files and gitignores the Feliz outputs", async () => {
    const files = await generateSystemFiles(SRC);
    expect(files.has("app/ClientApp/Dockerfile")).toBe(false);
    expect(files.get("app/ClientApp/.gitignore")).toContain("dist");
    expect([...files.keys()].some((p) => p.startsWith("app/ClientApp/e2e/"))).toBe(false);
  });
});

describe("fullstack dotnet — backend-only mode stays standalone (no Feliz leak)", () => {
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
