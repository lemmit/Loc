import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// The INSTANCE-QUALIFIED `OperationForm { data.<op> }` on Flutter
// (ledger `flutter-modal-instance-operationform`).
//
// `scaffoldOperations` emits the ops row INSIDE the Detail page's QueryView
// `data:` lambda, so each Modal's child is `OperationForm { data.<op> }`, not
// `OperationForm { of: <Agg>, op: <op> }`.  Flutter's `renderModal` matched only
// the by-name shape and otherwise emitted
//     const SizedBox.shrink() /* Modal: OperationForm child must name of: … */
// as the SOLE child of the ops `Wrap` — i.e. EVERY write action on EVERY
// scaffolded Flutter app was missing, with no diagnostic.
//
// Both halves have to land together: the target resolves the shape through
// `ctx.paramTypes`, and `forms-emit.ts`'s collector has to EMIT the widget the
// page now names, or `lib/forms.dart` is missing the class.
// ---------------------------------------------------------------------------

const SRC = `
system Fm {
  subdomain S { context C {
    enum St { Draft, Done }
    aggregate Task {
      title: string
      status: St
      function isOpen(): bool = status == Draft
      operation finish() { precondition isOpen() status := Done }
      operation rename(newTitle: string) { precondition isOpen() title := newTitle }
    }
    repository Tasks for Task { }
  } }
  ui App with scaffold(subdomains: [S]) { }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
  deployable web { platform: flutter targets: api ui: App port: 3001 }
}
`;

describe("flutter scaffolded Detail operations row", () => {
  it("renders the op dialogs and emits their form widgets", async () => {
    const files = await generateSystemFiles(SRC);
    const detail = [...files.entries()].find(([k]) =>
      k.endsWith("pages/task_detail_page.dart"),
    )![1];

    // The whole-row drop marker is gone.
    expect(detail).not.toContain("Modal: OperationForm child must name of:");
    expect(detail).not.toContain("is not an in-scope aggregate instance");

    // Both public operations render a real dialog over the generated form.
    for (const widget of ["FinishTaskForm(id: id)", "RenameTaskForm(id: id)"]) {
      expect(detail).toContain(widget);
    }
    expect(detail).toContain("showDialog(context: context,");

    // …and `lib/forms.dart` actually declares them — the collector half.  A
    // rendered reference with no class is a Dart compile error, which is why
    // both halves ship in one change.
    const forms = [...files.entries()].find(([k]) => k.endsWith("lib/forms.dart"))![1];
    expect(forms).toContain("class FinishTaskForm extends StatefulWidget {");
    expect(forms).toContain("class RenameTaskForm extends StatefulWidget {");
  });
});
