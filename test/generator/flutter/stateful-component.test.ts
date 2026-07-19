// Phase 6 — stateful user components.  A `component Foo(p) { state {} action }`
// emits a Dart `StatefulWidget` + private `State` into `lib/components.dart`: the
// State holds an immutable `<Comp>Model` (built in `initState`), exposes each
// param as a `widget.<p>` getter, and wraps each action body in `setState`
// (a write is `state = state.copyWith(field: value)`, reusing the page path's
// `renderNotifierStmt`).  State is per-instance.  A `derived` binding or an
// async-effect (`match await`) action keeps the component deferred.  No Dart is
// compiled here; generated-flutter-build.yml owns the SDK gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
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
    component Counter(start: int) {
      state { count: int = start }
      action inc() { count := count + 1 }
      action bump(by: int) { count := count + by }
      body: Card { Stack {
        Text { "Count: " + count },
        Button { "+", onClick: inc }
      } }
    }
    page Home {
      route: "/"
      body: Stack { Heading { "Home", level: 1 }, Counter(start: 5) }
    }
  }
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}
`;

describe("flutter stateful user components", () => {
  it("emits a StatefulWidget + State holding an immutable Model built in initState", async () => {
    const files = await generateSystemFiles(SRC);
    const comp = [...files.entries()].find(([k]) => k.endsWith("lib/components.dart"));
    expect(comp, "no components.dart").toBeDefined();
    const src = comp![1];
    // Immutable state record + copyWith.
    expect(src).toContain("class CounterModel {");
    expect(src).toContain("CounterModel copyWith({int? count}) {");
    // The StatefulWidget carries the ctor param; the State builds the Model in
    // initState (where the `widget.start` getter is bound), NOT as a field init.
    expect(src).toContain("class Counter extends StatefulWidget {");
    expect(src).toContain("final int start;");
    expect(src).toContain("State<Counter> createState() => _CounterState();");
    expect(src).toContain("class _CounterState extends State<Counter> {");
    expect(src).toContain("late CounterModel state;");
    expect(src).toContain("int get start => widget.start;");
    expect(src).toContain("state = CounterModel(count: start);");
  });

  it("projects actions as setState methods reusing the copyWith write shape", async () => {
    const files = await generateSystemFiles(SRC);
    const comp = [...files.entries()].find(([k]) => k.endsWith("lib/components.dart"));
    const src = comp![1];
    // Named actions → State methods; a payload param types the signature.
    expect(src).toContain("void inc() {");
    expect(src).toContain("void bump(int by) {");
    expect(src).toMatch(
      /setState\(\(\) \{\s*state = state\.copyWith\(count: \(state\.count \+ 1\)\)/,
    );
    // The body reads state through the held Model + the button calls the method.
    expect(src).toContain("state.count");
    expect(src).toContain("inc();");
    // The invoking page resolves the component (no diagnostic fallback).
    const page = [...files.entries()].find(([k]) => k.endsWith("home_page.dart"));
    expect(page![1]).toContain("Counter(start: 5)");
    expect(page![1]).not.toContain("unknown layout component");
  });
});
