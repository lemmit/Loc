// A Flutter deployable named `web` generated an app that could not be built.
//
// The Dart package name is `snake(deployable.name)`, and `web` is a real
// pub.dev package AND a transitive dependency of `http`, which every generated
// Flutter app uses.  Pub resolved that dependency to the local root package,
// found 0.1.0 where `^0.5.0` was required, and failed version solving before
// compiling anything:
//
//   Because http >=1.2.2 depends on web >=0.5.0 <2.0.0 and web is 0.1.0,
//   version solving failed.
//
// `web` is the most natural name there is for a frontend deployable — it is
// what every other frontend example in this repo uses — and the error names
// neither the deployable nor the collision.
//
// Verified against the real toolchain, which is the only thing that can prove
// it: `flutter pub get` + `flutter analyze` + `flutter test` all pass on a
// deployable named `web`, and all three failed at the first step before.

import { describe, expect, it } from "vitest";
import { dartPackageName } from "../../../src/generator/flutter/package-name.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = (deployable: string): string => `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order {
        code: string
        derived display: string = code
      }
      repository Orders for Order {}
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  ui WebApp {
    api Sales: SalesApi
    page Dash { route: "/dash" title: "Dashboard" body: Stack { Text { "hi" } } }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable ${deployable} { platform: flutter targets: api ui: WebApp { Sales: api } port: 3000 }
}
`;

async function emitted(deployable: string): Promise<Map<string, string>> {
  return await generateSystemFiles(SYSTEM(deployable));
}

function fileEndingWith(files: Map<string, string>, suffix: string): string {
  const hit = [...files].find(([p]) => p.endsWith(suffix));
  if (!hit) throw new Error(`no ${suffix}; got ${[...files.keys()].join(", ")}`);
  return hit[1];
}

describe("flutter package name — collisions with the app's own dependencies", () => {
  it("renames a deployable called `web`, which otherwise breaks `pub get`", async () => {
    const files = await emitted("web");
    expect(fileEndingWith(files, "pubspec.yaml")).toContain("name: web_app");
  });

  it("keeps the pubspec and the emitted tests' package: imports in agreement", async () => {
    // One derivation, three consumers — a rename that reached only the pubspec
    // would leave both emitted test files importing a package that no longer
    // exists.
    const files = await emitted("web");
    expect(fileEndingWith(files, "test/widget_test.dart")).toContain(
      "import 'package:web_app/main.dart';",
    );
    expect(fileEndingWith(files, "test/a11y_test.dart")).toContain(
      "import 'package:web_app/main.dart';",
    );
  });

  it("leaves a non-colliding name completely alone", async () => {
    // The reason this is a denylist and not a blanket `_app` suffix: every
    // existing generated app keeps its package name byte-identical.
    const files = await emitted("mobile");
    expect(fileEndingWith(files, "pubspec.yaml")).toContain("name: mobile");
    expect(fileEndingWith(files, "test/widget_test.dart")).toContain(
      "import 'package:mobile/main.dart';",
    );
  });

  it("covers the rest of the resolved dependency graph, not just `web`", () => {
    for (const name of ["http", "path", "collection", "meta", "intl", "vector_math"]) {
      expect(dartPackageName(name)).toBe(`${name}_app`);
    }
  });

  it("covers the file_picker-only dependencies a FileUpload app pulls in", () => {
    expect(dartPackageName("file_picker")).toBe("file_picker_app");
    expect(dartPackageName("win32")).toBe("win32_app");
  });

  it("covers Dart reserved words, which are not legal package names at all", () => {
    for (const word of ["class", "switch", "return", "void", "is"]) {
      expect(dartPackageName(word)).toBe(`${word}_app`);
    }
  });

  it("still falls back for a name that snake-cases to nothing", () => {
    expect(dartPackageName("")).toBe("loom_app");
  });

  it("normalises before asking — `Web` collides just as `web` does", () => {
    expect(dartPackageName("Web")).toBe("web_app");
  });
});
