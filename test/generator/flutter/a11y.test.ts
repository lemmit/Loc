// Flutter accessibility — the Semantics-emit contract per primitive.
//
// The framework-neutral a11y contract (`src/generator/_walker/a11y.ts`) applies
// to every frontend, but Flutter renders through its own procedural pack
// (`pack.ts`), so it can't ride the JSX/markup `a11yAttr` string fragments and
// is out of axe's reach (canvas render).  These assertions are the Flutter twin
// of the per-pack a11y unit tests: they pin that each obligation-bearing
// primitive emits the right Dart `Semantics(...)` so a `pack.ts` refactor can't
// silently drop it (the contract↔emit drift the M-T1.12 audit flagged).
//
// See docs/audits/flutter-a11y-audit-2026-07.md.  No Dart is compiled here;
// `generated-flutter-build.yml` owns "is the Dart real".

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** A single-page Flutter system whose body is the given primitive source. */
const system = (body: string): string => `
system A11y {
  subdomain S {
    context Shop {
      aggregate Product { name: string  price: int }
      repository Products for Product { }
    }
  }
  ui MobileApp {
    framework: flutter
    api Shop: A
    page Screen {
      route: "/"
      body: Container {
        ${body}
      }
    }
  }
  api A from S
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: MobileApp { Shop: api1 } port: 3006 }
}
`;

/** The emitted Dart of the single generated page. */
async function pageDart(body: string): Promise<string> {
  const files = await generateSystemFiles(system(body));
  const key = [...files.keys()].find((k) => k.endsWith("screen_page.dart"));
  expect(key, `no screen_page.dart in: ${[...files.keys()].join(", ")}`).toBeDefined();
  return files.get(key!)!;
}

describe("flutter a11y — derived Semantics emission", () => {
  it("Heading emits Semantics(header: true) so screen-reader heading nav works", async () => {
    const dart = await pageDart(`Heading { "Products", level: 1 }`);
    expect(dart).toContain("Semantics(header: true, child: Text('Products'");
  });

  it("Alert is a liveRegion so an async status is announced", async () => {
    const dart = await pageDart(`Alert { "Saved", color: "green" }`);
    expect(dart).toMatch(/Semantics\(container: true, liveRegion: true, child: Container\(/);
  });

  it("Loader carries a 'Loading' status label + liveRegion", async () => {
    const dart = await pageDart(`Loader {}`);
    expect(dart).toContain("Semantics(label: 'Loading', liveRegion: true");
    expect(dart).toContain("CircularProgressIndicator()");
  });

  it("Toolbar re-expresses its accessible name as Semantics(container:, label:)", async () => {
    // Default name is "Actions" (the Toolbar contract default).
    const dart = await pageDart(`Toolbar { Button { "Go" } }`);
    expect(dart).toContain("Semantics(container: true, label: 'Actions', child: Row(");
  });

  it("Toolbar honours an explicit label: as its accessible name", async () => {
    const dart = await pageDart(`Toolbar { label: "Order actions", Button { "Go" } }`);
    expect(dart).toContain("Semantics(container: true, label: 'Order actions', child: Row(");
  });
});

describe("flutter a11y — author-hint facts (Image / Avatar / Icon / Button)", () => {
  it("Image alt maps to semanticLabel", async () => {
    const dart = await pageDart(`Image { src: "/logo.png", alt: "Shop logo" }`);
    expect(dart).toContain(`Image.network("/logo.png", semanticLabel: "Shop logo")`);
  });

  it("a decorative Image is excluded from semantics, not empty-labelled", async () => {
    const dart = await pageDart(`Image { src: "/x.png", decorative: true }`);
    expect(dart).toContain("excludeFromSemantics: true");
    expect(dart).not.toContain('semanticLabel: ""');
  });

  it("Avatar alt becomes an accessible name via Semantics(image:)", async () => {
    const dart = await pageDart(`Avatar { src: "/u.png", alt: "Owner avatar" }`);
    expect(dart).toContain(`Semantics(label: "Owner avatar", image: true, child: CircleAvatar(`);
  });

  it("a decorative Avatar is excluded from semantics", async () => {
    const dart = await pageDart(`Avatar { src: "/u.png", decorative: true }`);
    expect(dart).toContain("ExcludeSemantics(child: CircleAvatar(");
  });

  it("a labelled Icon maps label: to semanticLabel", async () => {
    const dart = await pageDart(`Icon { name: "check", label: "Done" }`);
    expect(dart).toContain("semanticLabel: 'Done'");
  });

  it("a Button label: becomes a Semantics accessible name", async () => {
    const dart = await pageDart(`Button { "Refresh", label: "Refresh products" }`);
    expect(dart).toContain("Semantics(label: 'Refresh products', child: ElevatedButton(");
  });
});
