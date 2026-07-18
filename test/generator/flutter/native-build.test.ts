// Phase 3 — native mobile surface.  The generated Flutter project is always
// native-capable: it emits a Makefile + README documenting `flutter build apk`
// / `flutter build ipa` (prepared via `flutter create --platforms=…`), on top
// of the web build the compose stack serves.  No new grammar knob — web-vs-
// native is a build target, both always available.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Mobile {
  subdomain S { context Shop {
    aggregate Product { name: string }
    repository Products for Product {}
  } }
  ui App { framework: flutter  page Home { route: "/"  body: Stack { Heading { "Shop", level: 1 } } } }
  api A from S
  storage db { type: postgres }
  resource st { for: Shop, kind: state, use: db }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App port: 3006 }
}
`;

describe("flutter native build surface", () => {
  it("emits a Makefile with web/apk/ipa targets over one Dart source", async () => {
    const files = await generateSystemFiles(SRC);
    const mk = [...files.entries()].find(([k]) => k.endsWith("app/Makefile"));
    expect(mk, "no Makefile emitted").toBeDefined();
    const src = mk![1];
    // The native folders are prepared on demand, not vendored.
    expect(src).toContain("flutter create --platforms=android,ios .");
    // Every surface builds from the same source.
    expect(src).toContain("flutter build web --release");
    expect(src).toContain("flutter build apk --release");
    expect(src).toContain("flutter build ipa --release");
    // apk/ipa depend on the prepare target.
    expect(src).toMatch(/apk:\s*prepare/);
    expect(src).toMatch(/ipa:\s*prepare/);
    // API base is a build-time define.
    expect(src).toContain("--dart-define=API_BASE_URL=");
  });

  it("does NOT vendor the large android/ or ios/ platform scaffolds", async () => {
    const files = await generateSystemFiles(SRC);
    const keys = [...files.keys()];
    expect(keys.some((k) => k.includes("app/android/"))).toBe(false);
    expect(keys.some((k) => k.includes("app/ios/"))).toBe(false);
  });

  it("emits a README documenting the three build surfaces", async () => {
    const files = await generateSystemFiles(SRC);
    const readme = [...files.entries()].find(([k]) => k.endsWith("app/README.md"));
    expect(readme, "no README emitted").toBeDefined();
    expect(readme![1]).toContain("make apk");
    expect(readme![1]).toContain("make web");
  });
});
