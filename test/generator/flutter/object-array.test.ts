// Phase 6 — array-of-value-object form inputs.  A form field that is an array of
// a value object (`lines: LineItem[]`, `LineItem { sku: string  qty: int }`)
// renders as a repeatable add/remove row list where each row is a group of
// `TextFormField`s over the VO's scalar sub-fields (a
// `List<List<TextEditingController>>` in state); each row submits a `{sub: value,
// …}` map.  Only when EVERY sub-field is text/numeric; a bool/enum/datetime/
// nested sub-field defers the whole array.  No Dart is compiled here.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system S {
  api A from D
  subdomain D { context C {
    valueobject LineItem { sku: string  qty: int }
    aggregate Order {
      ref: string
      lines: LineItem[]
    }
    repository Orders for Order {}
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui App {
    framework: flutter
    api Shop: A
    page NewOrder { route: "/orders/new"  body: Stack { Heading { "New", level: 1 }, CreateForm { of: Order } } }
  }
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}
`;

describe("flutter array-of-value-object inputs", () => {
  it("renders each row as a group of controllers over the VO sub-fields", async () => {
    const files = await generateSystemFiles(SRC);
    const forms = [...files.entries()].find(([k]) => k.endsWith("lib/forms.dart"));
    expect(forms, "no forms.dart").toBeDefined();
    const src = forms![1];
    // Rows = a list of controller lists; disposed row-by-row.
    expect(src).toContain("final List<List<TextEditingController>> _linesRows = [];");
    expect(src).toContain("for (final row in _linesRows) { for (final c in row) c.dispose(); }");
    // Add appends a row with one controller per sub-field; remove disposes them.
    expect(src).toContain("_linesRows.add([TextEditingController(), TextEditingController()])");
    expect(src).toContain(
      "final removed = _linesRows.removeAt(entry.key); for (final c in removed) c.dispose();",
    );
    // Each sub-field is a labelled cell over its positional controller.
    expect(src).toContain("controller: row[0]");
    expect(src).toContain("labelText: 'Sku'");
    expect(src).toContain("controller: row[1]");
    expect(src).toContain("keyboardType: TextInputType.number");
  });

  it("submits one {sub: value} map per row, parsing numeric sub-fields", async () => {
    const files = await generateSystemFiles(SRC);
    const src = [...files.entries()].find(([k]) => k.endsWith("lib/forms.dart"))![1];
    expect(src).toContain(
      "'lines': _linesRows.map((row) => <String, dynamic>{'sku': row[0].text, 'qty': int.tryParse(row[1].text)}).toList(),",
    );
  });
});
