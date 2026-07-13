// Phoenix extern component rendering (extern-component-escape-hatch.md):
// a `component X(…) extern from "<path>"` is a hand-written Phoenix
// LiveComponent the user owns, embedded via the built-in `<.live_component
// module={<Module>} …>` — Elixir binds by MODULE (derived from the path), so
// no import/alias is wired and NO function is emitted into UiComponents.  A
// non-extern component alongside it still emits its UiComponents function.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

const SOURCE = `system MiniLiveView {
  subdomain Sales {
    context Sales {
      aggregate Customer {
        name: string
        email: string
      }
      repository Customers for Customer { }
    }
  }

  api SalesApi from Sales

  ui SalesAdmin {
    component Greeting(label: string) {
      body: Stack { Heading { label, level: 2 }, Text { "Welcome" } }
    }
    component OrderChart(caption: string) extern from "widgets/order_chart"
    page Home {
      route: "/"
      body: Stack {
        Greeting(label: "Hello"),
        OrderChart(caption: "Q3")
      }
    }
  }

  deployable phoenixApp {
    platform: elixir,
    contexts: [Sales],
    serves: SalesApi,
    ui: SalesAdmin,
    port: 4000
  }
}
`;

async function build(): Promise<Map<string, string>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-pextern-"));
  const file = path.join(dir, "mini.ddd");
  fs.writeFileSync(file, SOURCE);
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(file));
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errors.length > 0) {
    throw new Error("Validation errors:\n" + errors.map((e) => `  ${e.message}`).join("\n"));
  }
  return generateSystems(doc.parseResult.value as Model).files;
}

describe("Phoenix extern component rendering", () => {
  it("embeds an extern component via <.live_component module={...} id=...>", async () => {
    const files = await build();
    const live = files.get("phoenix_app/lib/phoenix_app_web/live/home_live.ex")!;
    expect(live, "home_live.ex is generated").toBeDefined();
    // Module derived from the `from "widgets/order_chart"` path (PascalCased
    // segments); id defaults to the snake component name.
    expect(live).toContain('<.live_component module={Widgets.OrderChart} id="order_chart"');
    expect(live).toMatch(
      /<\.live_component module=\{Widgets\.OrderChart\} id="order_chart" caption=\{[^}]*\} \/>/,
    );
  });

  it("emits NO UiComponents function for the extern component", async () => {
    const files = await build();
    const mod = files.get("phoenix_app/lib/phoenix_app_web/components/ui_components.ex")!;
    // The non-extern Greeting still emits its function component…
    expect(mod).toMatch(/def greeting\(assigns\) do/);
    // …but the extern OrderChart has no generated body.
    expect(mod).not.toContain("order_chart");
  });

  it("omits UiComponents entirely when every component is extern", async () => {
    const externOnly = `system MiniLiveView {
  subdomain Sales {
    context Sales {
      aggregate Customer { name: string }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  ui SalesAdmin {
    component OrderChart(caption: string) extern from "widgets/order_chart"
    page Home { route: "/" body: OrderChart(caption: "Q3") }
  }
  deployable phoenixApp {
    platform: elixir, contexts: [Sales], serves: SalesApi, ui: SalesAdmin, port: 4000
  }
}
`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-pextern2-"));
    const file = path.join(dir, "mini.ddd");
    fs.writeFileSync(file, externOnly);
    const services = createDddServices(NodeFileSystem);
    const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
      URI.file(file),
    );
    await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
    if (errors.length > 0) {
      throw new Error("Validation errors:\n" + errors.map((e) => `  ${e.message}`).join("\n"));
    }
    const files2 = generateSystems(doc.parseResult.value as Model).files;
    expect(files2.has("phoenix_app/lib/phoenix_app_web/components/ui_components.ex")).toBe(false);
    const live = files2.get("phoenix_app/lib/phoenix_app_web/live/home_live.ex")!;
    expect(live).toContain("<.live_component module={Widgets.OrderChart}");
  });
});
