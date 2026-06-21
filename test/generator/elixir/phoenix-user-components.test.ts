// Phoenix user-component rendering: each `ui.component`
// becomes a HEEx function component in a shared `Components.UiComponents`
// module, and page bodies invoke them fully-qualified (no import wiring).
// Display-only components for now — Form/Action inside a component need
// handler hoisting to the host LiveView (deferred).

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
        derived display: string = name
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
    page Home {
      route: "/"
      body: Greeting(label: "Hello")
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-pcomp-"));
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

describe("Phoenix user-component rendering", () => {
  it("emits a UiComponents module with one function component per ui.component", async () => {
    const files = await build();
    const mod = files.get("phoenix_app/lib/phoenix_app_web/components/ui_components.ex");
    expect(mod, "ui_components.ex is generated").toBeDefined();
    expect(mod!).toMatch(/defmodule PhoenixAppWeb\.Components\.UiComponents do/);
    expect(mod!).toMatch(/use PhoenixAppWeb, :html/);
    // `label: string` → a typed attr; the body walks with the param in
    // scope so refs resolve to `@label`.
    expect(mod!).toMatch(/attr :label, :string, required: true/);
    expect(mod!).toMatch(/def greeting\(assigns\) do/);
    expect(mod!).toMatch(/@label/);
  });

  it("invokes the component fully-qualified from the page LiveView", async () => {
    const files = await build();
    const live = files.get("phoenix_app/lib/phoenix_app_web/live/home_live.ex");
    expect(live, "home_live.ex is generated").toBeDefined();
    expect(live!).toMatch(/<PhoenixAppWeb\.Components\.UiComponents\.greeting label=\{[^}]*\} \/>/);
  });
});
