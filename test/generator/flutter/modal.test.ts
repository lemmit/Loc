// Phase 5c — Modal (`showDialog`).  `Modal { trigger: Button("…"),
// OperationForm(of: X, op: y) }` renders as an `ElevatedButton` whose
// `onPressed` opens an `AlertDialog` wrapping the generated op-form widget
// (`OpXForm(id: id)`); the op-form pops its own route on success, dismissing the
// dialog.  The nested op-form widget is emitted into `lib/forms.dart` by the
// page-body form scan.  No Dart is compiled here; `generated-flutter-build.yml`
// owns the SDK compile gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Ops {
  api A from S
  subdomain S { context C {
    aggregate Order {
      note: string
      derived display: string = note
      operation addNote(text: string) { note := text }
    }
    repository Orders for Order {}
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui App {
    framework: flutter
    api Shop: A
    page OrderDetail {
      route: "/orders/:id"
      body: Stack {
        Heading { "Order", level: 1 },
        Modal { OperationForm { of: Order, op: addNote }, trigger: Button { "Add note" }, title: "Add note" }
      }
    }
  }
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}
`;

describe("flutter Modal (op-form dialog)", () => {
  it("emits a trigger button that opens an AlertDialog over the op-form widget", async () => {
    const files = await generateSystemFiles(SRC);
    const page = [...files.entries()].find(([k]) => k.endsWith("order_detail_page.dart"));
    expect(page, "no detail page").toBeDefined();
    const src = page![1];
    // Trigger button opens a dialog…
    expect(src).toContain("showDialog(context: context,");
    expect(src).toContain("AlertDialog(title: Text('Add Note')");
    // …wrapping the generated op-form widget (addressed by the route id).
    expect(src).toContain("AddNoteOrderForm(id: id)");
    // The button carries the trigger's label.
    expect(src).toContain("child: Text('Add note'))");
  });

  it("emits the op-form widget the dialog references into forms.dart", async () => {
    const files = await generateSystemFiles(SRC);
    const forms = [...files.entries()].find(([k]) => k.endsWith("lib/forms.dart"));
    expect(forms, "no forms.dart").toBeDefined();
    expect(forms![1]).toContain("class AddNoteOrderForm extends StatefulWidget");
  });
});
