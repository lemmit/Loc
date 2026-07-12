import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Backend-host embedding, java flavour: a fullstack java deployable
// hosting a `ui X { framework: svelte }` declaration embeds a SvelteKit
// static SPA under ClientApp/ — same-origin /api fetches, /app/ui
// serving, the SvelteKit `build/` output copied by the multi-stage
// Dockerfile.  Mirrors test/generator/svelte/svelte-embed-dotnet.test.ts.
// ---------------------------------------------------------------------------

const SRC = `
system EmbedShopJava {
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
        framework: svelte
        api Sales: SalesApi
    }
    deployable app {
        platform: java
        contexts: [Orders]
        dataSources: [ordersState]
        serves: SalesApi
        ui: WebApp
        port: 8081
    }
}
`;

describe("java hosts a svelte ui (fullstack embed)", () => {
  it("emits the SvelteKit project under ClientApp/ with same-origin api config", async () => {
    const out = await generateSystemFiles(SRC);
    expect(out.has("app/ClientApp/svelte.config.js")).toBe(true);
    expect(out.has("app/ClientApp/src/routes/(app)/customers/+page.svelte")).toBe(true);
    expect(out.get("app/ClientApp/src/lib/api/config.ts")).toContain('?? "/api"');
    // Host-owned shell files are filtered (the java Dockerfile owns
    // the SPA build); the .gitignore covers the SvelteKit outputs.
    expect(out.has("app/ClientApp/Dockerfile")).toBe(false);
    expect(out.get("app/ClientApp/.gitignore")).toContain(".svelte-kit");
    // The host Dockerfile copies the SvelteKit `build/` output (not
    // the react `dist/`) into the serving dir.
    expect(out.get("app/Dockerfile")).toContain("COPY --from=spa-build /spa/build /app/ui");
    expect(out.get("app/.dockerignore")).toContain("ClientApp/build/");
    expect(out.get("app/.dockerignore")).toContain("ClientApp/.svelte-kit/");
    // The svelte default pack rides the embed.
    expect(out.get("app/ClientApp/package.json")).toContain('"@tanstack/svelte-query"');
  });

  it("a react ui keeps the dist/ copy untouched", async () => {
    const reactSrc = SRC.replace("framework: svelte", "framework: react");
    const out = await generateSystemFiles(reactSrc);
    expect(out.get("app/Dockerfile")).toContain("COPY --from=spa-build /spa/dist /app/ui");
    expect(out.has("app/ClientApp/svelte.config.js")).toBe(false);
  });
});
