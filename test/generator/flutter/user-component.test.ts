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

// ---------------------------------------------------------------------------
// READ-BEARING components.  Until this shipped, a component whose body issued an
// api read was dropped WHOLE — `lib/components.dart` was not emitted at all and
// every call site became `const SizedBox.shrink() /* unknown layout component:
// … */`.  Valid Dart, missing UI.
//
// The fix is the shape a read-bearing PAGE already takes: a Riverpod
// `ConsumerWidget` whose `build` receives the `WidgetRef` and hoists
// `ref.watch(<var>Provider…)` through the same `renderApiHoisting` seam.
// `collectFlutterReads` scans component bodies too, so the provider it watches
// is in `reads.dart`.
// ---------------------------------------------------------------------------
const READS = `
system S {
  api A from D
  subdomain D { context C {
    aggregate Order { name: string }
    repository Orders for Order {}
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui App {
    framework: flutter
    api Shop: A
    component RecentOrders(title: string) {
      body: Stack {
        Heading { title, level: 2 },
        QueryView { of: Shop.Order.all, loading: Loader {}, error: Alert { "e" }, empty: Empty { "none" },
          data: rows => Stack { For { each: rows, o => Text { o.name } } } }
      }
    }
    component OneOrder() {
      body: QueryView { of: Shop.Order.byId(id), single: true, loading: Loader {}, error: Alert { "e" },
        empty: Empty { "none" }, data: o => Text { o.name } }
    }
    page Home { route: "/" body: Stack { RecentOrders(title: "Recent"), OneOrder() } }
  }
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}
`;

describe("flutter read-bearing user components", () => {
  it("emits a read component as a ConsumerWidget that watches its own provider", async () => {
    const files = await generateSystemFiles(READS);
    const comp = [...files.entries()].find(([k]) => k.endsWith("lib/components.dart"));
    expect(comp, "no components.dart — the read component was dropped whole").toBeDefined();
    const src = comp![1];
    expect(src).toContain("class RecentOrders extends ConsumerWidget {");
    expect(src).toContain("Widget build(BuildContext context, WidgetRef ref) {");
    // The data wiring: the hoisted watch, plus the two imports it needs.
    expect(src).toContain("ref.watch(orderAllProvider");
    expect(src).toContain("import 'package:flutter_riverpod/flutter_riverpod.dart';");
    expect(src).toContain("import 'reads.dart';");
    // Declared props still ride constructor fields.
    expect(src).toContain("final String title;");
  });

  it("the provider the component watches is emitted in reads.dart", async () => {
    const files = await generateSystemFiles(READS);
    const reads = [...files.entries()].find(([k]) => k.endsWith("lib/reads.dart"));
    expect(reads, "no reads.dart for a component-only read").toBeDefined();
    expect(reads![1]).toContain("orderAllProvider");
  });

  it("the call site renders the widget instead of the give-up comment", async () => {
    const files = await generateSystemFiles(READS);
    const page = [...files.entries()].find(([k]) => k.endsWith("home_page.dart"))![1];
    expect(page).toContain("import '../components.dart';");
    expect(page).toContain("RecentOrders(title: 'Recent')");
    expect(page).not.toContain("unknown layout component: RecentOrders");
  });

  it("a byId read in a component stays deferred — a component binds no route id", async () => {
    // `byId(id)` renders the bare local `id`, which only a page shell binds from
    // its route arguments.  Deferral keeps that honest rather than emitting Dart
    // that names nothing.
    const files = await generateSystemFiles(READS);
    const comp = [...files.entries()].find(([k]) => k.endsWith("lib/components.dart"))?.[1] ?? "";
    expect(comp).not.toContain("class OneOrder");
    const page = [...files.entries()].find(([k]) => k.endsWith("home_page.dart"))![1];
    expect(page).toContain("unknown layout component: OneOrder");
  });
});
