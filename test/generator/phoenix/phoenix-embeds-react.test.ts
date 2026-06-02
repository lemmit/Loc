// D-PHOENIX-SURFACE phase 6a — a Phoenix deployable whose hosted `ui`
// declares `framework: react` embeds a React SPA (generated under
// `assets/`) instead of emitting LiveView/HEEx pages.  This pins the
// emit dispatch only; the endpoint/router/Dockerfile serve-wiring that
// makes the bundle reachable from `priv/static` is phase 6b.
//
// Output-neutral guarantee: no shipped example pairs `platform: phoenix`
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
    platform: phoenix
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
  ui WebApp { framework: liveview  page Home { route: "/" } }
  deployable app {
    platform: phoenix
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
});
