// Phoenix `Action`: `Action { <instance>.<op>, then? }` inside a
// (stateless) function component emits a `<.button phx-click=…>` whose
// handler is hoisted to every host page's LiveView — load the instance
// via the Ash code interface, invoke the action, flash + navigate.

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
        operation confirm() { }
      }
      repository Customers for Customer { }
    }
  }

  api SalesApi from Sales

  ui SalesAdmin {
    api Sales: SalesApi
    component CustomerPanel(customer: Customer) {
      body: Toolbar { Action { customer.confirm, then: navigate(Home) } }
    }
    page Detail {
      route: "/customers/:id"
      body: QueryView {
        of: Sales.Customer.byId(id),
        single: true,
        loading: Loader {},
        empty: Empty { "Not found" },
        data: c => CustomerPanel(customer: c)}
    }
    page Home { route: "/" body: Text { "home" } }
  }

  deployable phoenixApp {
    platform: elixir
    contexts: [Sales]
    serves: SalesApi
    ui: SalesAdmin { Sales: phoenixApp }
    port: 4000
  }
}
`;

async function build(): Promise<Map<string, string>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-paction-"));
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

describe("Phoenix Action — instance-qualified operation button", () => {
  it("renders a phx-click button in the component, keyed by the instance id", async () => {
    const files = await build();
    const mod = files.get("phoenix_app/lib/phoenix_app_web/components/ui_components.ex")!;
    expect(mod).toMatch(
      /<\.button phx-click="confirm_customer" phx-value-id=\{@customer\.id\}>Confirm<\/\.button>/,
    );
  });

  it("hoists the handle_event into the host page's LiveView", async () => {
    const files = await build();
    const live = files.get("phoenix_app/lib/phoenix_app_web/live/detail_live.ex")!;
    expect(live).toMatch(/def handle_event\("confirm_customer", %\{"id" => id\}, socket\) do/);
    expect(live).toMatch(/record = PhoenixApp\.Sales\.get_customer!\(id\)/);
    expect(live).toMatch(/PhoenixApp\.Sales\.confirm_customer!\(record\)/);
    expect(live).toMatch(/put_flash\(:info, "Confirm succeeded"\)/);
    // then: navigate(Home) → push_navigate to Home's route.
    expect(live).toMatch(/push_navigate\(to: ~p"\/home"\)/);
  });
});
