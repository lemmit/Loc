import { describe, expect, it } from "vitest";
import { generateAngularForContexts } from "../../../src/generator/angular/index.js";
import { buildLoomModel } from "../../_helpers/ir.js";

// ---------------------------------------------------------------------------
// Angular generator — base-href consumption (`GenerateAngularOptions.basePath`).
//
// A fullstack host that serves the Angular bundle under a sub-path (the Phoenix
// vanilla embed mounts SPAs at `/app`, not root) passes `basePath: "/app"`.  The
// generator must then thread `baseHref: "/app/"` into BOTH the angular.json build
// option AND the `<base href>` tag in index.html, or the bundle's asset URLs and
// client-side deep links break — the analog of svelte's `kit.paths.base`.
//
// The root-mounted hosts (java/dotnet/python `ClientApp/`, `basePath` unset) must
// stay byte-identical: default `<base href="/">` + NO angular.json baseHref key.
// This test calls the generator twice on the SAME enriched model — once root,
// once `/app` — and proves (a) root output is unchanged, (b) `/app` carries the
// base-href, and (c) the ONLY files that differ are angular.json + index.html.
// ---------------------------------------------------------------------------

const SOURCE = `
  system Shop {
    subdomain Sales {
      context Orders {
        aggregate Customer with crudish {
          name: string
        }
      }
    }
    ui Web {
      page Customers {
        route: "/customers"
        title: "Customers"
        body: Stack { Heading { "Customers", level: 2 } }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 3000 }
    deployable web { platform: angular, targets: api, ui: Web, port: 3004 }
  }
`;

async function bothMounts() {
  const model = await buildLoomModel(SOURCE);
  const sys = model.systems[0];
  const deployable = sys.deployables.find((d) => d.platform === "angular")!;
  const contexts = model.contexts;
  const rootMount = generateAngularForContexts(contexts, sys, deployable, {});
  const appMount = generateAngularForContexts(contexts, sys, deployable, { basePath: "/app" });
  return { rootMount, appMount };
}

describe("angular generator — base-href consumption", () => {
  it("root-mount (basePath unset) omits the angular.json baseHref option and keeps <base href='/'>", async () => {
    const { rootMount } = await bothMounts();
    const angularJson = rootMount.get("angular.json")!;
    expect(angularJson).not.toContain('"baseHref"');
    const indexHtml = rootMount.get("src/index.html")!;
    expect(indexHtml).toContain('<base href="/" />');
  });

  it("/app-mount threads baseHref into angular.json AND index.html", async () => {
    const { appMount } = await bothMounts();
    const angularJson = appMount.get("angular.json")!;
    expect(angularJson).toContain('"baseHref": "/app/"');
    const indexHtml = appMount.get("src/index.html")!;
    expect(indexHtml).toContain('<base href="/app/" />');
  });

  it("basePath changes ONLY angular.json + index.html (no leakage into any other file)", async () => {
    const { rootMount, appMount } = await bothMounts();
    // Identical key sets.
    expect([...appMount.keys()].sort()).toEqual([...rootMount.keys()].sort());
    // Every other file is byte-identical between the two mounts.
    const differing = [...rootMount.keys()].filter((k) => rootMount.get(k) !== appMount.get(k));
    expect(differing.sort()).toEqual(["angular.json", "src/index.html"]);
  });
});
