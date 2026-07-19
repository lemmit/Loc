// Phase 5d — WorkflowForm.  `WorkflowForm(runs: <wf>)` renders as a
// self-contained `StatefulWidget` (like CreateForm) that POSTs the workflow
// params as a JSON body to the command route `/workflows/<wf>`.  The page
// references `const <Wf>WorkflowForm()` and imports `../forms.dart`.  No Dart is
// compiled here; `generated-flutter-build.yml` owns the SDK compile gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Ops {
  api A from S
  subdomain S { context C {
    aggregate Order { name: string  total: int }
    repository Orders for Order {}
    workflow placeOrder transactional {
      create(customer: string, amount: int) {
        let o = Order.create({ name: customer, total: amount })
      }
    }
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui App {
    framework: flutter
    api Shop: A
    page NewOrder { route: "/orders/new"  body: Stack { Heading { "Place order", level: 1 }, WorkflowForm { runs: placeOrder } } }
  }
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}
`;

describe("flutter WorkflowForm", () => {
  it("emits a workflow-form widget posting to /workflows/<wf>", async () => {
    const files = await generateSystemFiles(SRC);
    const forms = [...files.entries()].find(([k]) => k.endsWith("lib/forms.dart"));
    expect(forms, "no forms.dart").toBeDefined();
    const src = forms![1];
    expect(src).toContain("class PlaceOrderWorkflowForm extends StatefulWidget");
    // POSTs the params to the workflow command route.
    expect(src).toContain("http.post(apiUri('/workflows/place_order')");
    // Both scalar params become controller-backed inputs.
    expect(src).toContain("_customerController");
    expect(src).toContain("_amountController");
    // Submit label is "Run <Workflow>".
    expect(src).toContain("Run Place Order");
  });

  it("references the workflow-form widget from the hosting page + imports forms", async () => {
    const files = await generateSystemFiles(SRC);
    const page = [...files.entries()].find(([k]) => k.endsWith("new_order_page.dart"));
    expect(page, "no page").toBeDefined();
    const src = page![1];
    expect(src).toContain("const PlaceOrderWorkflowForm()");
    expect(src).toContain("import '../forms.dart';");
  });
});
