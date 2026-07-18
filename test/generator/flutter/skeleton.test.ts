// Flutter Phase 0 — foundation skeleton.  Proves `platform: flutter` is wired
// end-to-end (grammar → validator → lowering → platform registry dispatch) and
// that the generator emits a coherent minimal Flutter project tree.  No Dart is
// compiled here (no local Flutter SDK); the `generated-flutter-build.yml` CI gate
// owns "is the Dart real" (Phase 2).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// One aggregate + a `node` backend + a `platform: flutter` frontend + one page.
const SRC = `
system Mobile {
  subdomain S {
    context Shop {
      aggregate Product { name: string }
      repository Products for Product { }
    }
  }
  ui MobileApp {
    framework: flutter
    page Home {
      route: "/"
      body: Stack {
        Heading { "Products", level: 1 }
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

describe("flutter foundation skeleton", () => {
  it("emits a Flutter project tree with pubspec.yaml and lib/main.dart", async () => {
    const files = await generateSystemFiles(SRC);
    const keys = [...files.keys()];

    const pubspec = keys.find((k) => k.endsWith("pubspec.yaml"));
    const main = keys.find((k) => k.endsWith("lib/main.dart"));
    expect(pubspec, `no pubspec.yaml in: ${keys.join(", ")}`).toBeDefined();
    expect(main, `no lib/main.dart in: ${keys.join(", ")}`).toBeDefined();

    // pubspec is a real Flutter manifest (SDK dep + material design).
    expect(files.get(pubspec!)).toContain("sdk: flutter");
    expect(files.get(pubspec!)).toContain("uses-material-design: true");

    // main.dart boots a MaterialApp with the declared page wired as a route.
    const mainSrc = files.get(main!)!;
    expect(mainSrc).toContain("import 'package:flutter/material.dart';");
    expect(mainSrc).toContain("runApp(const App())");
    expect(mainSrc).toContain("MaterialApp(");
    expect(mainSrc).toContain("routes:");
    expect(mainSrc).toContain("const HomePage()");

    // The `ui`'s Home page renders through walkBody → flutterTarget + the
    // flutterMaterial pack (not a placeholder), surfacing the heading text.
    const home = keys.find((k) => k.endsWith("lib/pages/home_page.dart"));
    expect(home, `no home page in: ${keys.join(", ")}`).toBeDefined();
    const homeSrc = files.get(home!)!;
    expect(homeSrc).toContain("class HomePage extends StatelessWidget");
    expect(homeSrc).toContain("Products");

    // Track A wire models: one Dart class per aggregate, JSON round-trip.
    const models = keys.find((k) => k.endsWith("lib/models.dart"));
    expect(models, `no models.dart in: ${keys.join(", ")}`).toBeDefined();
    const modelsSrc = files.get(models!)!;
    expect(modelsSrc).toContain("class Product");
    expect(modelsSrc).toContain("fromJson");
    expect(modelsSrc).toContain("toJson");

    // Self-hosting web build (Track E web surface).
    const dockerfile = keys.find((k) => k.endsWith("app/Dockerfile"));
    expect(dockerfile, `no Dockerfile in: ${keys.join(", ")}`).toBeDefined();
    expect(files.get(dockerfile!)).toContain("flutter build web");
  });
});
