// Topology A — a standalone React frontend consuming an API-only
// Phoenix backend (cross-origin).  The Phoenix deployable mounts no
// `ui:`, so it degrades to domain + JSON `/api` controllers + OpenAPI
// (see liveview-emit.ts's `if (!deployable.uiName) return …`).  Two
// wiring facts this guards:
//
//   1. React's generated client must target `<origin>/api` — the scope
//      the Phoenix router actually serves on — not the bare origin
//      (which is correct for a Hono/standalone-.NET target).  Driven by
//      the target's `PlatformSurface.apiBasePath`, not a hardcoded
//      platform-string check.
//   2. The Phoenix backend must emit a CORS plug (+ `:cors_plug` dep)
//      so the cross-origin browser call is allowed — mirroring the Hono
//      backend's `app.use("*", cors())`.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseValid } from "../_helpers/parse.js";

// React → Phoenix (API-only): the backend mounts no `ui:`.
const SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order {
        name: string
      }
      repository Orders for Order {}
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  api SalesApi from Sales
  ui WebApp {
    api Sales: SalesApi
  }
  deployable api {
    platform: phoenixLiveView
    contexts: [Orders]
    dataSources: [ordersState]
    serves: SalesApi
    port: 4000
  }
  deployable web {
    platform: react
    targets: api
    ui: WebApp { Sales: api }
    port: 3001
  }
}
`;

// Control: React → Hono (root-mounted API).  Same shape, different
// target platform, so the base path stays the bare origin.
const SRC_HONO = SRC.replace("platform: phoenixLiveView", "platform: hono");

async function gen(src: string): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(src))).files;
}

function find(files: Map<string, string>, pred: (k: string) => boolean, label: string): string {
  const key = [...files.keys()].find(pred);
  expect(key, `${label} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("React frontend targeting an API-only Phoenix backend", () => {
  it('bakes the /api base path into the React client (Phoenix serves under scope "/api")', async () => {
    const files = await gen(SRC);
    const config = find(files, (k) => k.endsWith("web/src/api/config.ts"), "react api/config.ts");
    expect(config).toMatch(/http:\/\/localhost:4000\/api/);
  });

  it("threads the /api base path into the docker-compose VITE_API_BASE_URL", async () => {
    const files = await gen(SRC);
    const compose = files.get("docker-compose.yml")!;
    const webBlock = compose.match(/\n {2}web:[\s\S]*?(?=\n {2}\w[\w_]*:|$)/)![0];
    expect(webBlock).toMatch(/VITE_API_BASE_URL:\s*"http:\/\/localhost:4000\/api"/);
  });

  it('a Hono target keeps the bare origin (apiBasePath is "") — no /api suffix', async () => {
    const files = await gen(SRC_HONO);
    const config = find(files, (k) => k.endsWith("web/src/api/config.ts"), "react api/config.ts");
    expect(config).toMatch(/http:\/\/localhost:4000"/);
    expect(config).not.toMatch(/localhost:4000\/api/);
  });

  it("the API-only Phoenix backend emits a CORS plug + :cors_plug dep for the cross-origin call", async () => {
    const files = await gen(SRC);
    const endpoint = find(files, (k) => k.endsWith("_web/endpoint.ex"), "endpoint.ex");
    expect(endpoint).toMatch(/plug CORSPlug/);
    const mix = files.get("api/mix.exs")!;
    expect(mix).toMatch(/:cors_plug/);
  });

  it("the API-only Phoenix backend serves JSON but emits no LiveView pages (no ui: mount)", async () => {
    const files = await gen(SRC);
    const keys = [...files.keys()];
    // JSON controller under /api is present…
    expect(keys.some((k) => k.includes("/controllers/orders_controller.ex"))).toBe(true);
    // …but no LiveView page modules, since no `ui:` is bound here.
    expect(keys.some((k) => k.includes("_web/live/") && k.endsWith("_live.ex"))).toBe(false);
  });
});
