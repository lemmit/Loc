// Page-level `derived` bindings on the Flutter frontend.  A `derived x = …` on a
// PAGE hoists one `final x = <dart>;` local into `build` (the page twin of a
// component's derived GETTER — `component-emit.ts`), in declaration order so a
// later one may read an earlier, and the body reads it BARE through the walker's
// `renderDerivedRead` seam.
//
// Before this the page walk was handed an EMPTY `derivedNames` set, so every
// page-level derived read fell through to the walker's give-up comment — and the
// pack then wrapped that Dart source in `Text('…')`, so the running app PRINTED
// `const SizedBox.shrink() /* ref: total */` on screen.  No Dart is compiled
// here; `generated-flutter-build.yml` owns the SDK gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const PRELUDE = `
system S {
  api A from D
  subdomain D { context C {
    aggregate Item { name: string }
    repository Items for Item {}
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
`;

const EPILOGUE = `
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}
`;

const src = (ui: string): string => `${PRELUDE}\n${ui}\n${EPILOGUE}`;

async function pageSource(ddd: string, file: string): Promise<string> {
  const files = await generateSystemFiles(ddd);
  const page = [...files.entries()].find(([k]) => k.endsWith(file));
  expect(page, `no ${file}`).toBeDefined();
  return page![1];
}

const STATE_UI = src(`
  ui App {
    framework: flutter
    api Shop: A
    page Home {
      route: "/"
      state { qty: int = 2 }
      derived total: int = qty * 3
      derived doubled: int = total * 2
      derived unused: int = qty + 1
      body: Stack { Text { total }, Text { doubled } }
    }
  }
`);

describe("flutter page-level derived bindings", () => {
  it("hoists one local per derived, in declaration order, read bare in the body", async () => {
    const src = await pageSource(STATE_UI, "home_page.dart");
    // One `final` per derived the body reads — the second reads the first as a
    // bare local (Dart locals are not hoisted, so declaration order is load-bearing).
    expect(src).toContain("final total = (state.qty * 3);");
    expect(src).toContain("final doubled = (total * 2);");
    expect(src.indexOf("final total =")).toBeLessThan(src.indexOf("final doubled ="));
    // …and the body reads them, rather than printing Dart source on screen.
    expect(src).toContain("Text('${total}')");
    expect(src).toContain("Text('${doubled}')");
    expect(src).not.toContain("ref: total");
    expect(src).not.toContain("Text('const SizedBox");
  });

  it("binds the watched state ABOVE the derived that reads it", async () => {
    const src = await pageSource(STATE_UI, "home_page.dart");
    // A derived reading `state` makes the page a ConsumerWidget even when the
    // body itself never touches a state cell — otherwise the local would name
    // an unbound `state` (`Undefined name`).
    expect(src).toContain("class HomePage extends ConsumerWidget {");
    expect(src).toContain("final state = ref.watch(homeProvider);");
    expect(src.indexOf("final state = ref.watch")).toBeLessThan(src.indexOf("final total ="));
  });

  it("emits no local for a derived the body never reads", async () => {
    const src = await pageSource(STATE_UI, "home_page.dart");
    // Dart flags an unused LOCAL and `flutter analyze` is a gate, so a derived
    // nothing references is not hoisted.
    expect(src).not.toContain("final unused");
  });

  it("hoists a state-free derived on the plain StatelessWidget path", async () => {
    const source = await pageSource(
      src(`
  ui App {
    framework: flutter
    api Shop: A
    page About {
      route: "/about"
      derived greeting: string = "hi " + "there"
      body: Stack { Text { greeting } }
    }
  }
`),
      "about_page.dart",
    );
    expect(source).toContain("class AboutPage extends StatelessWidget {");
    expect(source).toContain("final greeting = ('hi ' + 'there');");
    expect(source).toContain("Text('${greeting}')");
  });

  it("defers a derived reaching a page-shell-only binding instead of naming it", async () => {
    const source = await pageSource(
      src(`
  ui App {
    framework: flutter
    api Shop: A
    store Cart { state { count: int = 0 } }
    page Home {
      route: "/"
      derived viaStore: int = Cart.count + 1
      body: Card { Text { viaStore } }
    }
  }
`),
      "home_page.dart",
    );
    // A store member local exists only when the BODY reads that store, so a
    // derived over one keeps its pre-existing drop rather than emitting Dart
    // that names nothing.
    expect(source).not.toContain("final viaStore");
    // …and the give-up sentinel stays a WIDGET — never Dart source printed as text.
    expect(source).toContain("const SizedBox.shrink() /* ref: viaStore */");
    expect(source).not.toContain("Text('const SizedBox");
  });
});
