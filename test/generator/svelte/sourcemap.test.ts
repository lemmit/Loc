import { describe, expect, it } from "vitest";
import type { OriginRef } from "../../../src/ir/types/origin.js";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Svelte frontend recording bracket (M8, source-map-debug-kickoff.md).
// Mirrors the react/vue generator sourcemap tests: a scaffolded page must
// land in `.loom/sourcemap.json` under the deployable slug with the
// disambiguated `${ui.name}.<area>.<page>` construct id and a macro origin.
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
    ui WebApp with scaffold(subdomains: [Sales]) {
      component StatusPill(label: string) {
        body: Stack { Badge { label } }
      }
    }
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], serves: SalesApi, port: 3000 }
    deployable web { platform: svelte, targets: api, ui: WebApp, port: 3002 }
  }
`;

describe("svelte generator — sourcemap recording", () => {
  it("records the scaffolded list page under the deployable slug with a macro origin", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const raw = files.get(".loom/sourcemap.json")!;
    const map = JSON.parse(raw) as {
      files: Record<string, { construct?: string; origin: OriginRef }[]>;
    };

    const path = "web/src/routes/(app)/widgets/+page.svelte";
    const regions = map.files[path];
    expect(regions, `no region recorded for ${path}`).toBeDefined();
    expect(regions!.length).toBeGreaterThan(0);
    const region = regions![0]!;
    expect(region.construct).toBe("WebApp.widgets.List");
    expect(region.origin.kind).toBe("macro");
  });

  // ComponentIR.origin (stamped in lowerComponent, M8) — hand-written ui
  // components carry a `source` origin, unlike the scaffolded pages' macro
  // origin; this frontend's own component recording site has no other gate.
  it("records a user-declared component file with a source origin and ui-scoped construct", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;
    const map = JSON.parse(files.get(".loom/sourcemap.json")!) as {
      files: Record<string, { construct?: string; origin: OriginRef }[]>;
    };

    const path = "web/src/lib/components/StatusPill.svelte";
    expect(files.has(path), `${path} not emitted`).toBe(true);
    const regions = map.files[path];
    expect(regions, `no region recorded for ${path}`).toBeDefined();
    const region = regions![0]!;
    expect(region.construct).toBe("WebApp.StatusPill");
    expect(region.origin.kind).toBe("source");
  });

  it("off by default — no sourcemap artifact, page content unaffected", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model).files;
    expect(files.has(".loom/sourcemap.json")).toBe(false);
    expect(files.has("web/src/routes/(app)/widgets/+page.svelte")).toBe(true);
  });
});
