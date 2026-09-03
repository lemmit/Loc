// Phase 6 — user components.  A `component Foo(params) { body }` declaration
// emits a Dart `StatelessWidget` into `lib/components.dart` (one final field per
// param, the walked body as the `build` return); an invocation `Foo(a: x)`
// renders as a widget constructor call and the page imports `../components.dart`.
// Only USED, stateless, value-param, no-read components are emitted; stateful /
// extern / read-bearing components fall back to the diagnostic comment.  No Dart
// is compiled here; generated-flutter-build.yml owns the SDK gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles, generateSystemFilesUnchecked } from "../../_helpers/generate.js";

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
    const files = await generateSystemFilesUnchecked(
      READS,
      "the READS ui deliberately pairs a SUPPORTED read component with the route-id-bearing `OneOrder`, which loom.user-component-deferred-target now reports; emitting from it is how these tests prove the deferral is PER COMPONENT, not per ui",
    );
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
    const files = await generateSystemFilesUnchecked(
      READS,
      "the READS ui deliberately pairs a SUPPORTED read component with the route-id-bearing `OneOrder`, which loom.user-component-deferred-target now reports; emitting from it is how these tests prove the deferral is PER COMPONENT, not per ui",
    );
    const reads = [...files.entries()].find(([k]) => k.endsWith("lib/reads.dart"));
    expect(reads, "no reads.dart for a component-only read").toBeDefined();
    expect(reads![1]).toContain("orderAllProvider");
  });

  it("the call site renders the widget instead of the give-up comment", async () => {
    const files = await generateSystemFilesUnchecked(
      READS,
      "the READS ui deliberately pairs a SUPPORTED read component with the route-id-bearing `OneOrder`, which loom.user-component-deferred-target now reports; emitting from it is how these tests prove the deferral is PER COMPONENT, not per ui",
    );
    const page = [...files.entries()].find(([k]) => k.endsWith("home_page.dart"))![1];
    expect(page).toContain("import '../components.dart';");
    expect(page).toContain("RecentOrders(title: 'Recent')");
    expect(page).not.toContain("unknown layout component: RecentOrders");
  });

  it("a byId read in a component stays deferred — a component binds no route id", async () => {
    // `byId(id)` renders the bare local `id`, which only a page shell binds from
    // its route arguments.  Deferral keeps that honest rather than emitting Dart
    // that names nothing.
    const files = await generateSystemFilesUnchecked(
      READS,
      "the READS ui deliberately pairs a SUPPORTED read component with the route-id-bearing `OneOrder`, which loom.user-component-deferred-target now reports; emitting from it is how these tests prove the deferral is PER COMPONENT, not per ui",
    );
    const comp = [...files.entries()].find(([k]) => k.endsWith("lib/components.dart"))?.[1] ?? "";
    expect(comp).not.toContain("class OneOrder");
    const page = [...files.entries()].find(([k]) => k.endsWith("home_page.dart"))![1];
    expect(page).toContain("unknown layout component: OneOrder");
  });
});

// ---------------------------------------------------------------------------
// `derived`-bearing components.  A `derived total: T = expr` is a pure function
// of the params (and, on a stateful component, of `state`), yet the whole
// component used to be dropped: the walker rendered a derived read as
// `state.<name>` — a field the `<Comp>Model` data class never declares — so
// `candidates()` filtered every `derived`-bearing component out and each call
// site became `const SizedBox.shrink() /* unknown layout component: … */`.
// Valid Dart, missing UI, no diagnostic.
//
// The fix pairs the `renderDerivedRead` walker seam (bare name on Flutter) with
// a Dart GETTER on the class whose scope the expression's names live in: the
// widget for the stateless / consumer shapes, the `State` for a stateful one.
// ---------------------------------------------------------------------------
const DERIVED = `
system S {
  api A from D
  subdomain D { context C {
    aggregate Item { name: string }
    repository Items for Item {}
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui App {
    framework: flutter
    api Shop: A
    component TierBadge(score: int) {
      derived tier: string = score > 90 ? "gold" : "silver"
      derived shout: string = tier.toUpper()
      body: Stack { Text { tier }, Text { shout } }
    }
    component Tally(step: int) {
      state { n: int = 0 }
      derived doubled: int = n * 2
      action bump() { n := n + step }
      body: Stack { Text { string(doubled) }, Button(label: "+", onClick: bump) }
    }
    page Home { route: "/" body: Stack { TierBadge(score: 95), Tally(step: 2) } }
  }
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}
`;

describe("flutter derived-bearing user components", () => {
  it("emits a stateless derived component with one getter per binding", async () => {
    const files = await generateSystemFiles(DERIVED);
    const src = [...files.entries()].find(([k]) => k.endsWith("lib/components.dart"))?.[1] ?? "";
    expect(src, "no components.dart — the derived component was dropped whole").not.toBe("");
    expect(src).toContain("class TierBadge extends StatelessWidget {");
    // The getter is typed from the binding's declared type and reads the param
    // as the widget's own final field.
    expect(src).toContain("String get tier => ((score > 90) ? 'gold' : 'silver');");
    // A later derived reads an earlier one BARE (a getter on the same class),
    // not `state.tier` — the seam under test.
    expect(src).toContain("String get shout => (tier.toUpperCase());");
    // …and the body reads them bare too.
    expect(src).toContain("Text('${tier}')");
    expect(src).not.toContain("state.tier");
  });

  it("puts a stateful component's derived getter on the State, beside `state`", async () => {
    const files = await generateSystemFiles(DERIVED);
    const src = [...files.entries()].find(([k]) => k.endsWith("lib/components.dart"))![1];
    // The getter lands in `_TallyState` (which owns `state` and the param
    // getters), NOT on the widget class — `state.n` only resolves there.
    const stateClass = src.slice(src.indexOf("class _TallyState"));
    expect(stateClass).toContain("int get doubled => (state.n * 2);");
    expect(
      src.slice(src.indexOf("class Tally extends"), src.indexOf("class _TallyState")),
    ).not.toContain("get doubled");
  });

  it("the call sites render the widgets instead of the give-up comment", async () => {
    const files = await generateSystemFiles(DERIVED);
    const page = [...files.entries()].find(([k]) => k.endsWith("home_page.dart"))![1];
    expect(page).toContain("TierBadge(score: 95)");
    expect(page).toContain("Tally(step: 2)");
    expect(page).not.toContain("unknown layout component");
  });
});
