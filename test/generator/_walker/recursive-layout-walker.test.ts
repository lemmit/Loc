// recursive body walker for custom layouts.
//
// Pages whose body is composed of layout primitives (Stack /
// Heading / Text / Button / Card) instead of scaffold archetypes
// (List / Detail / Form) emit through the body walker.  Output
// goes to `src/pages/<name-snake>.tsx` with App.tsx routing via
// the existing `deriveExtraRoutesFromUi` pipeline.
//
// What this test pins:
//   1. `body: Stack { Heading { "X" }, Text { "Y" } }` emits a TSX file
//      with a Mantine `<Stack>` containing the children.
//   2. Imports for the Mantine components used are emitted at
//      the top of the page file.
//   3. App.tsx imports + routes the custom-layout page.
//   4. Nested composition works: Card {"Title", Stack {Text { "a" },
//      Text { "b" }}} → nested JSX.
//   5. Scaffold-archetype bodies (List/Detail/Form) STILL go
//      through the scaffold dispatch path, not the walker.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("recursive layout walker", () => {
  it("emits Stack { Heading, Text } into a TSX file with Mantine imports", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Welcome {
            route: "/welcome"
            body:  Stack { Heading { "Welcome to Acme" }, Text { "Pick a destination." } }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    expect([...files.keys()]).toContain("web/src/pages/welcome.tsx");
    const content = files.get("web/src/pages/welcome.tsx")!;
    // Mantine imports for the components used.
    expect(content).toMatch(/import \{ Stack, Text, Title \} from "@mantine\/core";/);
    // Function component named after the page.
    expect(content).toMatch(/export default function Welcome\(\)/);
    // JSX shape: Stack > Title order={2} + Text.
    expect(content).toMatch(/<Stack>/);
    expect(content).toMatch(/<Title order=\{2\}>Welcome to Acme<\/Title>/);
    expect(content).toMatch(/<Text>Pick a destination\.<\/Text>/);
    expect(content).toMatch(/<\/Stack>/);
  });

  it("App.tsx imports + routes the walker-rendered page", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Welcome {
            route: "/"
            body:  Stack { Heading { "Hello" } }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const appTsx = files.get("web/src/App.tsx")!;
    expect(appTsx).toMatch(/import Welcome from "\.\/pages\/welcome";/);
    expect(appTsx).toMatch(/path="\/"\s+element=\{<Welcome \/>\}/);
  });

  it("supports `level:` named arg on Heading", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Welcome {
            route: "/welcome"
            body:  Heading { "Big", level: 1 }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/welcome.tsx")!;
    expect(content).toMatch(/<Title order=\{1\}>Big<\/Title>/);
  });

  it('nested composition: Card { "Stats", Stack { Text { "a" }, Text { "b" } } }', async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Dashboard {
            route: "/dashboard"
            body:  Card { "Stats", Stack { Text { "a" }, Text { "b" } } }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/dashboard.tsx")!;
    // Card imports Card + Title (for the title heading).
    expect(content).toMatch(/Card/);
    expect(content).toMatch(/Title/);
    // Card structure with title + nested Stack.
    expect(content).toMatch(/<Card withBorder padding="md">/);
    expect(content).toMatch(/<Title order=\{3\}>Stats<\/Title>/);
    expect(content).toMatch(/<Stack>/);
    expect(content).toMatch(/<Text>a<\/Text>/);
    expect(content).toMatch(/<Text>b<\/Text>/);
  });

  it("Button emits unwired in v0 (no onClick)", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Welcome {
            route: "/welcome"
            body:  Button { "Click me" }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/welcome.tsx")!;
    expect(content).toMatch(/<Button>Click me<\/Button>/);
    // No onClick wiring in v0.
    expect(content).not.toMatch(/onClick=/);
  });

  it("unknown components leave a placeholder comment, no crash", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Mixed {
            route: "/mixed"
            body:  Stack { Heading { "Real" }, SomeUnknownThing(foo: 42) }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp
          port: 3001
        }
      }
    `);
    const content = files.get("web/src/pages/mixed.tsx")!;
    expect(content).toMatch(/<Title order=\{2\}>Real<\/Title>/);
    // Unknown component renders as a JSX comment placeholder, so
    // the file still compiles even with an unrecognised primitive
    // mid-tree.
    expect(content).toMatch(/unknown layout component: SomeUnknownThing/);
  });

  // accessibility.md Phase 2 — heading rank is DERIVED from `Section`/`Card`
  // nesting depth (never a skipped level) when `level:` is absent.
  it("derives heading level from Section/Card nesting depth", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Nested {
            route: "/nested"
            body: Stack {
              Heading { "Top" },
              Section {
                Heading { "In section" },
                Card { "Card title", Heading { "In card in section" } }
              },
              Card { "Just a card", Heading { "In card" } }
            }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const content = files.get("web/src/pages/nested.tsx")!;
    // Page top → h2 (chrome owns the h1); Section body → h3; Card inside
    // Section → h4; a top-level Card body → h3.  No level is skipped.
    expect(content).toMatch(/<Title order=\{2\}>Top<\/Title>/);
    expect(content).toMatch(/<Title order=\{3\}>In section<\/Title>/);
    expect(content).toMatch(/<Title order=\{4\}>In card in section<\/Title>/);
    expect(content).toMatch(/<Title order=\{3\}>In card<\/Title>/);
  });

  // An explicit `level:` always wins over the derivation.
  it("honours an explicit level: inside a nesting container", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Explicit {
            route: "/explicit"
            body: Section { Heading { "Pinned", level: 2 } }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    const content = files.get("web/src/pages/explicit.tsx")!;
    expect(content).toMatch(/<Title order=\{2\}>Pinned<\/Title>/);
  });
});
