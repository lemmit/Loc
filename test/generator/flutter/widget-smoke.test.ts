// Phase 4 — runtime e2e.  Every generated Flutter app ships a headless
// `flutter_test` widget smoke that boots the real `App` and asserts it renders,
// gated in CI by `flutter test`.  Proves the app RUNS, not just compiles.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Mobile {
  subdomain S { context Shop {
    aggregate Product { name: string }
    repository Products for Product {}
  } }
  ui App {
    framework: flutter
    page Home {
      route: "/"
      state { count: int = 0 }
      action inc() { count := count + 1 }
      body: Stack { Text { "Taps: " + count }, Button { "+", onClick: inc } }
    }
  }
  api A from S
  storage db { type: postgres }
  resource st { for: Shop, kind: state, use: db }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App port: 3006 }
}
`;

describe("flutter widget smoke test", () => {
  it("emits a flutter_test widget smoke that pumps App and finds a MaterialApp", async () => {
    const files = await generateSystemFiles(SRC);
    const t = [...files.entries()].find(([k]) => k.endsWith("test/widget_test.dart"));
    expect(t, "no test/widget_test.dart emitted").toBeDefined();
    const src = t![1];
    expect(src).toContain("import 'package:flutter_test/flutter_test.dart';");
    // Imports the emitted app entrypoint (package name derives from the deployable).
    expect(src).toContain("/main.dart';");
    expect(src).toContain("testWidgets(");
    expect(src).toContain("tester.pumpWidget(const App())");
    // A single pump (not pumpAndSettle) — reads never settle without a backend.
    expect(src).toContain("await tester.pump();");
    expect(src).not.toContain("pumpAndSettle");
    expect(src).toContain("find.byType(MaterialApp)");
  });
});
