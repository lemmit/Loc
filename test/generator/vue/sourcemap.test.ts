import { describe, expect, it } from "vitest";
import type { OriginRef } from "../../../src/ir/types/origin.js";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Vue frontend recording bracket (M8, source-map-debug-kickoff.md).  Mirrors
// the react generator's sourcemap test: a scaffolded page must land in
// `.loom/sourcemap.json` under the deployable slug with the disambiguated
// `${ui.name}.<area>.<page>` construct id and a macro origin.
// ---------------------------------------------------------------------------

const SOURCE = `
  system Shop {
    subdomain Sales {
      context Orders {
        aggregate Widget {
          name: string
        }
        repository Widgets for Widget { }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    api SalesApi from Sales
    ui WebApp with scaffold(subdomains: [Sales]) { }
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], serves: SalesApi, port: 3000 }
    deployable web { platform: vue, targets: api, ui: WebApp, port: 3003 }
  }
`;

describe("vue generator — sourcemap recording", () => {
  it("records the scaffolded list page under the deployable slug with a macro origin", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as {
      files: Record<string, { construct?: string; origin: OriginRef }[]>;
    };

    const path = "web/src/pages/widgets/list.vue";
    const regions = map.files[path];
    expect(regions, `no region recorded for ${path}`).toBeDefined();
    expect(regions!.length).toBeGreaterThan(0);
    const region = regions![0]!;
    expect(region.construct).toBe("WebApp.widgets.List");
    expect(region.origin.kind).toBe("macro");
  });

  it("off by default — no sourcemap artifact, page content unaffected", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model).files;
    expect(files.has(".loom/sourcemap.json")).toBe(false);
    expect(files.has("web/src/pages/widgets/list.vue")).toBe(true);
  });
});
