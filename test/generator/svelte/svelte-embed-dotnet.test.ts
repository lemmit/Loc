import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Backend-host embedding (svelte-frontend-plan.md Slice 9): a fullstack
// dotnet deployable declaring `ui X { framework: svelte }` embeds a
// SvelteKit static SPA under ClientApp/ — same-origin /api fetches,
// wwwroot serving, SvelteKit `build/` output copied by the multi-stage
// Dockerfile.
// ---------------------------------------------------------------------------

const SRC = `
system EmbedShop {
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
        api Sales: SalesApi
    }
    deployable app {
        platform: dotnet
        contexts: [Orders]
        dataSources: [ordersState]
        serves: SalesApi
        ui WebApp { framework: svelte }
        port: 8080
    }
}
`;

describe("dotnet hosts a svelte ui (fullstack embed)", () => {
  it("emits the SvelteKit project under ClientApp/ with same-origin api config", async () => {
    const out = await generateSystemFiles(SRC);
    expect(out.has("app/ClientApp/svelte.config.js")).toBe(true);
    expect(out.has("app/ClientApp/src/routes/(app)/customers/+page.svelte")).toBe(true);
    expect(out.get("app/ClientApp/src/lib/api/config.ts")).toContain('?? "/api"');
    // Host-owned shell files are filtered (the .NET Dockerfile owns
    // the SPA build); the .gitignore covers the SvelteKit outputs.
    expect(out.has("app/ClientApp/Dockerfile")).toBe(false);
    expect(out.get("app/ClientApp/.gitignore")).toContain(".svelte-kit");
    // The host Dockerfile copies the SvelteKit `build/` output (not
    // the react `dist/`) into wwwroot.
    expect(out.get("app/Dockerfile")).toContain("COPY --from=spa-build /spa/build ./wwwroot");
    // The svelte default pack rides the embed.
    expect(out.get("app/ClientApp/package.json")).toContain('"@tanstack/svelte-query"');
  });

  it("honours the ui's own framework through the `ui:` sugar binding", async () => {
    // The validator reads the ui's declared framework through every
    // binding spelling; lowering must agree — a sugar-bound
    // `ui WebApp { framework: svelte }` declaration must not fall back
    // to the platform's react default (which would feed a svelte-format
    // pack to the React generator).
    const sugarSrc = SRC.replace(
      "ui WebApp with scaffold(subdomains: [Sales]) {",
      "ui WebApp with scaffold(subdomains: [Sales]) {\n        framework: svelte",
    ).replace("ui WebApp { framework: svelte }", "ui: WebApp");
    const out = await generateSystemFiles(sugarSrc);
    expect(out.has("app/ClientApp/svelte.config.js")).toBe(true);
    expect(out.has("app/ClientApp/src/routes/(app)/customers/+page.svelte")).toBe(true);
  });

  // Phoenix-hosted svelte is now supported (paths.base = "/app") and
  // covered by test/generator/phoenix/phoenix-embeds-svelte.test.ts.
});
