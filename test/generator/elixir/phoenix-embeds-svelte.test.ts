// Phoenix embeds a SvelteKit SPA (item 4b — phoenix paths.base hosting).
//
// A `platform: elixir` deployable hosting a `framework: svelte` ui
// embeds the SvelteKit project under `assets/` and serves the built
// bundle from `/app` (Plug.Static + SpaController), exactly like the
// react/vue embeds — but the SvelteKit build sets `kit.paths.base =
// "/app"` so its asset URLs + base-aware links resolve under the prefix
// rather than 404-ing at root.  Mirrors phoenix-embeds-react.test.ts.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const EMBED_SVELTE_SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order { name: string  derived display: string = name }
      repository Orders for Order {}
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  ui WebApp { framework: svelte }
  deployable app {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    hosts: WebApp
    port: 4000
  }
}
`;

async function generate(src: string): Promise<Map<string, string>> {
  const model = await parseValid(src);
  return generateSystems(model).files;
}

function get(files: Map<string, string>, suffix: string): string {
  const k = [...files.keys()].find((x) => x.endsWith(suffix));
  expect(k, `${suffix} not emitted`).toBeDefined();
  return files.get(k!)!;
}

describe("Phoenix embeds a SvelteKit SPA (item 4b)", () => {
  it("emits the SvelteKit project under assets/ and suppresses LiveView pages", async () => {
    const files = await generate(EMBED_SVELTE_SRC);
    const ks = [...files.keys()];
    expect(ks.some((k) => k.endsWith("/assets/svelte.config.js"))).toBe(true);
    expect(ks.some((k) => k.endsWith("/assets/package.json"))).toBe(true);
    // No LiveView pages or HEEx sidebar in embedded mode.
    expect(ks.some((k) => k.includes("_web/live/") && k.endsWith("_live.ex"))).toBe(false);
    expect(ks.some((k) => k.endsWith("_web/components/sidebar.ex"))).toBe(false);
    // The Ash JSON API is still emitted (the SPA calls it at /api).
    expect(ks.some((k) => k.includes("_web/controllers/") && k.includes("controller"))).toBe(true);
  });

  it("svelte.config builds with paths.base /app so the bundle resolves under the prefix", async () => {
    const cfg = get(await generate(EMBED_SVELTE_SRC), "/assets/svelte.config.js");
    expect(cfg).toContain('paths: { base: "/app" }');
  });

  it("same-origin api config — the SPA fetches /api", async () => {
    const cfg = get(await generate(EMBED_SVELTE_SRC), "/assets/src/lib/api/config.ts");
    expect(cfg).toContain('?? "/api"');
  });

  it("reuses the /app serve-wiring (endpoint + router + SpaController)", async () => {
    const files = await generate(EMBED_SVELTE_SRC);
    expect(get(files, "_web/endpoint.ex")).toContain('at: "/app"');
    expect(get(files, "_web/router.ex")).toContain('get "/*path", SpaController, :index');
    expect(get(files, "_web/controllers/spa_controller.ex")).toContain("static/app/index.html");
  });

  it("Dockerfile copies the SvelteKit build/ output (not vite dist/) to priv/static/app", async () => {
    const dockerfile = get(await generate(EMBED_SVELTE_SRC), "Dockerfile");
    expect(dockerfile).toContain("AS spa-build");
    expect(dockerfile).toContain("npm run build");
    expect(dockerfile).toContain("COPY --from=spa-build /spa/build priv/static/app");
  });

  it("assets/.gitignore covers the SvelteKit outputs", async () => {
    const gi = get(await generate(EMBED_SVELTE_SRC), "/assets/.gitignore");
    expect(gi).toContain("build");
    expect(gi).toContain(".svelte-kit");
  });
});
