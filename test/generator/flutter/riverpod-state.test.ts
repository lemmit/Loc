// Flutter Track D — Riverpod state/action projector.  Two tiers: the projector
// (`renderRiverpod`) driven directly off a lowered+enriched page IR (string
// assertions on the `<Page>State` / `<Page>Notifier` / provider triad), and the
// end-to-end `generate system` wiring (the page becomes a `ConsumerWidget`, the
// Riverpod dep + `ProviderScope` land in pubspec/main).  No Dart is compiled
// here — `generated-flutter-build.yml` owns the SDK compile gate; the local
// `flutter analyze` + `build web` gate was run by hand during development.

import { describe, expect, it } from "vitest";
import { renderRiverpod } from "../../../src/generator/flutter/riverpod-emit.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { allContexts } from "../../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

// A counter: one `int` state cell + a nullary action that increments it, plus a
// Text reading the cell and a Button whose `onClick` fires the action.
const SRC = `
system Counter {
  subdomain S {
    context Shop {
      aggregate Product { name: string }
      repository Products for Product { }
    }
  }
  ui MobileApp {
    framework: flutter
    page Counter {
      route: "/"
      state { count: int = 0 }
      action inc() { count := count + 1 }
      body: Stack {
        Text { "Count: " + count },
        Button { "+", onClick: inc }
      }
    }
  }
  api A from S
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: MobileApp port: 3006 }
}
`;

describe("flutter Riverpod projector", () => {
  it("projects state {} + action into a State class, Notifier, and provider", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const enriched = enrichLoomModel(lowerModel(model));
    const page = enriched.systems[0]!.uis[0]!.pages.find((p) => p.name === "Counter")!;
    const proj = renderRiverpod(page, allContexts(enriched));

    // Names derived from the page name.
    expect(proj.stateClass).toBe("CounterState");
    expect(proj.notifierClass).toBe("CounterNotifier");
    expect(proj.providerName).toBe("counterProvider");

    // Immutable state data class: const ctor + typed final field + copyWith.
    expect(proj.source).toContain("class CounterState {");
    expect(proj.source).toContain("const CounterState({required this.count});");
    expect(proj.source).toContain("final int count;");
    expect(proj.source).toContain("CounterState copyWith({int? count}) {");
    expect(proj.source).toContain("return CounterState(count: count ?? this.count);");

    // Notifier over the state class: build() returns the initial state (from the
    // `= 0` init), and the action lowers to a `state = state.copyWith(...)` write
    // whose RHS reads route through the state seam (`state.count`).
    expect(proj.source).toContain("class CounterNotifier extends Notifier<CounterState> {");
    expect(proj.source).toContain("CounterState build() {");
    expect(proj.source).toContain("return const CounterState(count: 0);");
    expect(proj.source).toContain("void inc() {");
    expect(proj.source).toContain("state = state.copyWith(count: (state.count + 1));");

    // Provider ties the Notifier to its state.
    expect(proj.source).toContain(
      "final counterProvider = NotifierProvider<CounterNotifier, CounterState>(CounterNotifier.new);",
    );
  });
});

describe("flutter Riverpod system wiring", () => {
  it("renders the stateful page as a ConsumerWidget bound to the provider", async () => {
    const files = await generateSystemFiles(SRC);
    const key = [...files.keys()].find((k) => k.endsWith("lib/pages/counter_page.dart"));
    expect(key, `no counter page in: ${[...files.keys()].join(", ")}`).toBeDefined();
    const src = files.get(key!)!;

    // ConsumerWidget + Riverpod import + the projected triad in the page file.
    expect(src).toContain("import 'package:flutter_riverpod/flutter_riverpod.dart';");
    expect(src).toContain("class CounterPage extends ConsumerWidget {");
    expect(src).toContain("Widget build(BuildContext context, WidgetRef ref) {");
    expect(src).toContain("class CounterState {");
    expect(src).toContain("class CounterNotifier extends Notifier<CounterState> {");

    // Build binds the watched state, the notifier, and a tear-off per referenced
    // action so the button's `onClick: inc` resolves to `inc()`.
    expect(src).toContain("final state = ref.watch(counterProvider);");
    expect(src).toContain("final notifier = ref.read(counterProvider.notifier);");
    expect(src).toContain("final inc = notifier.inc;");
    // The state read dereferences the projected record; the button fires the alias.
    expect(src).toContain("state.count");
    expect(src).toContain("() { inc(); }");
  });

  it("adds the flutter_riverpod dep and wraps the app root in ProviderScope", async () => {
    const files = await generateSystemFiles(SRC);
    const pubspec = files.get([...files.keys()].find((k) => k.endsWith("pubspec.yaml"))!)!;
    const main = files.get([...files.keys()].find((k) => k.endsWith("lib/main.dart"))!)!;

    expect(pubspec).toContain("flutter_riverpod:");
    expect(main).toContain("import 'package:flutter_riverpod/flutter_riverpod.dart';");
    expect(main).toContain("ProviderScope(child: MaterialApp(");
  });

  it("keeps display-only pages as plain StatelessWidgets", async () => {
    // A pure display page (no state/action) must stay on the StatelessWidget
    // fallback path — the ConsumerWidget projection is gated on real state use.
    const displaySrc = `
system Disp {
  subdomain S { context Shop { aggregate Product { name: string } repository Products for Product { } } }
  ui App {
    framework: flutter
    page Home { route: "/" body: Stack { Heading { "Hi", level: 1 } } }
  }
  api A from S
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App port: 3006 }
}`;
    const dispFiles = await generateSystemFiles(displaySrc);
    const home = dispFiles.get(
      [...dispFiles.keys()].find((k) => k.endsWith("lib/pages/home_page.dart"))!,
    )!;
    expect(home).toContain("class HomePage extends StatelessWidget");
    expect(home).not.toContain("ConsumerWidget");
  });
});
