// D-PHOENIX-SURFACE phase 6a — a Phoenix deployable whose hosted `ui`
// declares `framework: react` embeds a React SPA (generated under
// `assets/`) instead of emitting LiveView/HEEx pages.  This pins the
// emit dispatch only; the endpoint/router/Dockerfile serve-wiring that
// makes the bundle reachable from `priv/static` is phase 6b.
//
// Output-neutral guarantee: no shipped example pairs `platform: elixir`
// with a `framework: react` ui, so this branch never fires on real
// sources — these tests construct the embedded case explicitly.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const EMBED_REACT_SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order { name: string  derived display: string = name }
      repository Orders for Order {}
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  ui WebApp { framework: react }
  deployable app {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    hosts: WebApp
    port: 4000
  }
}
`;

const LIVEVIEW_SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order { name: string  derived display: string = name }
      repository Orders for Order {}
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  ui WebApp { framework: phoenixLiveView  page Home { route: "/" } }
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
  return (await generateSystems(await parseValid(src))).files;
}

const keys = (files: Map<string, string>) => [...files.keys()];

describe("Phoenix embeds React (D-PHOENIX-SURFACE phase 6a)", () => {
  it("emits the React project under assets/ when the hosted ui is framework: react", async () => {
    const files = await generate(EMBED_REACT_SRC);
    const ks = keys(files);
    // The React generator's source tree lands under the app's assets/.
    expect(
      ks.some((k) => k.includes("/assets/src/") && k.endsWith(".tsx")),
      ks.join("\n"),
    ).toBe(true);
    // Its package.json is there too (the embedded SPA's own Vite project).
    expect(ks.some((k) => k.endsWith("/assets/package.json"))).toBe(true);
  });

  it("does NOT emit LiveView pages or the HEEx sidebar in embedded-react mode", async () => {
    const files = await generate(EMBED_REACT_SRC);
    const ks = keys(files);
    expect(
      ks.some((k) => k.includes("_web/live/") && k.endsWith("_live.ex")),
      ks.join("\n"),
    ).toBe(false);
    expect(ks.some((k) => k.endsWith("_web/components/sidebar.ex"))).toBe(false);
  });

  it("still emits the Ash domain + /api controllers in embedded-react mode", async () => {
    const files = await generate(EMBED_REACT_SRC);
    const ks = keys(files);
    // The backend half is unchanged — the Ash resource is still emitted.
    expect(
      ks.some((k) => k.endsWith("/orders/order.ex")),
      ks.join("\n"),
    ).toBe(true);
  });

  it("the legacy liveview path is unchanged — LiveView pages emitted, no assets/ SPA", async () => {
    const files = await generate(LIVEVIEW_SRC);
    const ks = keys(files);
    expect(
      ks.some((k) => k.includes("_web/live/") && k.endsWith("_live.ex")),
      ks.join("\n"),
    ).toBe(true);
    // No embedded React source tree.
    expect(ks.some((k) => k.includes("/assets/src/") && k.endsWith(".tsx"))).toBe(false);
  });

  // --- Phase 6b: serve-wiring (endpoint / router / Dockerfile / controller) ---

  function get(files: Map<string, string>, suffix: string): string {
    const k = [...files.keys()].find((x) => x.endsWith(suffix));
    expect(k, `${suffix} not emitted`).toBeDefined();
    return files.get(k!)!;
  }

  it("endpoint serves the SPA from priv/static/app in embedded-react mode (6b)", async () => {
    const endpoint = get(await generate(EMBED_REACT_SRC), "_web/endpoint.ex");
    expect(endpoint).toContain('at: "/app"');
    expect(endpoint).toContain('"priv/static/app"');
  });

  it("router adds the /app SPA fallback catch-all in embedded-react mode (6b)", async () => {
    const router = get(await generate(EMBED_REACT_SRC), "_web/router.ex");
    expect(router).toContain('scope "/app"');
    expect(router).toContain('get "/*path", SpaController, :index');
  });

  it("emits the SpaController in embedded-react mode (6b)", async () => {
    const files = await generate(EMBED_REACT_SRC);
    const ctrl = get(files, "_web/controllers/spa_controller.ex");
    expect(ctrl).toContain("def index(conn");
    expect(ctrl).toContain("static/app/index.html");
  });

  it("Dockerfile gains the spa-build stage + copies dist to priv/static/app (6b)", async () => {
    const dockerfile = get(await generate(EMBED_REACT_SRC), "Dockerfile");
    expect(dockerfile).toContain("AS spa-build");
    expect(dockerfile).toContain("npm run build");
    expect(dockerfile).toContain("COPY --from=spa-build /spa/dist priv/static/app");
  });

  it("the embedded bundle builds with vite base /app/ + baked router basename (6b)", async () => {
    // Phoenix serves the bundle from /app, so the vite build must base
    // its asset URLs there (`index.html` → /app/assets/...) and the
    // react-router basename must default to /app — otherwise deep links
    // and asset loads 404.  Standalone/root-served react gets neither.
    const files = await generate(EMBED_REACT_SRC);
    const vite = get(files, "/assets/vite.config.ts");
    expect(vite).toContain('base: "/app/"');
    const main = get(files, "/assets/src/main.tsx");
    expect(main).toContain('?? "/app"');
  });

  it("the legacy liveview shell files carry NO SPA serve-wiring (6b output-neutral)", async () => {
    const files = await generate(LIVEVIEW_SRC);
    const endpoint = get(files, "_web/endpoint.ex");
    const router = get(files, "_web/router.ex");
    const dockerfile = get(files, "Dockerfile");
    expect(endpoint).not.toContain('at: "/app"');
    expect(router).not.toContain("SpaController");
    expect(dockerfile).not.toContain("spa-build");
    // And no SpaController file at all.
    expect([...files.keys()].some((k) => k.endsWith("spa_controller.ex"))).toBe(false);
  });
});
