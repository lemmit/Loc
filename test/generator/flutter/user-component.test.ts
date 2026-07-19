// Phase 6 — user components.  A `component Foo(params) { body }` declaration
// emits a Dart `StatelessWidget` into `lib/components.dart` (one final field per
// param, the walked body as the `build` return); an invocation `Foo(a: x)`
// renders as a widget constructor call and the page imports `../components.dart`.
// Only USED, stateless, value-param, no-read components are emitted; stateful /
// extern / read-bearing components fall back to the diagnostic comment.  No Dart
// is compiled here; generated-flutter-build.yml owns the SDK gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system S {
  api A from D
  subdomain D { context C {
    aggregate Item { name: string  qty: int }
    repository Items for Item {}
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui App {
    framework: flutter
    api Shop: A
    component ItemRow(item: Item) { body: Card { Text { item.name } } }
    component Banner(label: string) { body: Text { label } }
    page Items {
      route: "/"
      body: Stack {
        Banner(label: "Catalog"),
        QueryView { of: Shop.Item.all, loading: Text { "…" }, error: Text { "e" }, empty: Text { "none" },
          data: rows => Stack { For { each: rows, p => ItemRow(item: p) } } }
      }
    }
  }
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}
`;

describe("flutter user components", () => {
  it("emits used components as StatelessWidgets + imports models for domain params", async () => {
    const files = await generateSystemFiles(SRC);
    const comp = [...files.entries()].find(([k]) => k.endsWith("lib/components.dart"));
    expect(comp, "no components.dart").toBeDefined();
    const src = comp![1];
    // Domain-param component → a StatelessWidget with a typed field + models import.
    expect(src).toContain("import 'models.dart';");
    expect(src).toContain("class ItemRow extends StatelessWidget {");
    expect(src).toContain("final Item item;");
    expect(src).toContain("Text('${item.name}')");
    // Scalar-param component.
    expect(src).toContain("class Banner extends StatelessWidget {");
    expect(src).toContain("final String label;");
  });

  it("renders invocations as widget calls + the page imports components.dart", async () => {
    const files = await generateSystemFiles(SRC);
    const page = [...files.entries()].find(([k]) => k.endsWith("items_page.dart"));
    expect(page, "no page").toBeDefined();
    const src = page![1];
    expect(src).toContain("import '../components.dart';");
    // Positional/named args map to the component's params.
    expect(src).toContain("Banner(label: 'Catalog')");
    expect(src).toContain("ItemRow(item: p)");
    // No "unknown component" fallback comment.
    expect(src).not.toContain("unknown layout component");
  });
});
