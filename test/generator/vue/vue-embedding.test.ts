import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Backend-host embedding for Vue (vue-frontend-plan.md Slice 8) — a
// dotnet / java / phoenix deployable whose hosted `ui` declares
// `framework: vue` embeds the Vue SPA exactly where it embeds the
// React one (`ClientApp/` on dotnet/java, `assets/` on phoenix),
// calling the host's same-origin `/api` surface.  `vue` is a
// STATIC_BUNDLE_FRAMEWORK, so the serving wiring is identical.
// ---------------------------------------------------------------------------

const src = (platform: string, extra = "") => `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order { name: string  derived display: string = name }
      repository Orders for Order {}
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  ui WebApp { framework: vue  page Home { route: "/" } }
  deployable app {
    platform: ${platform}
    contexts: [Orders]
    dataSources: [ordersState]
    hosts: WebApp
    port: 8080${extra}
  }
}
`;

async function files(source: string): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(source))).files;
}

describe("vue embedding on backend hosts", () => {
  it("dotnet host embeds the Vue SPA under ClientApp/ with same-origin /api", async () => {
    const out = await files(src("dotnet"));
    expect(out.has("app/ClientApp/src/App.vue")).toBe(true);
    expect(out.has("app/ClientApp/src/main.ts")).toBe(true);
    expect(out.has("app/ClientApp/src/router.ts")).toBe(true);
    const config = out.get("app/ClientApp/src/api/config.ts")!;
    expect(config).toContain('?? "/api"');
    // The vuetify default rides the embedded-vue design lowering.
    const pkg = JSON.parse(out.get("app/ClientApp/package.json")!) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.vuetify).toBeTruthy();
    // The host owns the project-root surfaces.
    expect(out.has("app/ClientApp/Dockerfile")).toBe(false);
  });

  it("java host embeds the Vue SPA under ClientApp/", async () => {
    const out = await files(src("java"));
    expect(out.has("app/ClientApp/src/App.vue")).toBe(true);
    expect(out.get("app/ClientApp/src/api/config.ts")).toContain('?? "/api"');
  });

  it("phoenix host embeds the Vue SPA under assets/", async () => {
    // Pin foundation: ash — the elixir SPA-embed path is exercised on the Ash
    // foundation (post D-VANILLA-DEFAULT the bare default is vanilla LiveView).
    const out = await files(src("elixir { foundation: ash }"));
    expect(out.has("app/assets/src/App.vue")).toBe(true);
    expect(out.get("app/assets/src/api/config.ts")).toContain('?? "/api"');
    // No LiveView page modules for the vue ui.
    const liveFiles = [...out.keys()].filter((p) => p.includes("_live.ex"));
    expect(liveFiles).toEqual([]);
  });
});
