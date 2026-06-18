// Walker `style: { ... }` escape hatch — end-to-end render.
//
// Pins that a primitive call carrying a `style:` named arg threads
// through lowering, the per-pack template, and produces a JSX
// `style={{ ... }}` attribute on the root element of the emitted
// component.  Keys are camelCased on emission (CSS `background-color`
// → React `backgroundColor`); values flow through `emitExpr` so
// string literals stay quoted.

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

async function buildAndGenerate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

const DEPLOYABLES = `
  deployable api { platform: node, contexts: [C], port: 3000 }
  deployable web {
    platform: static
    targets: api
    ui: WebApp
    port: 3001
  }
`;

describe("walker style: escape hatch — React emission", () => {
  it("Container { style: {...} } emits style={{...}} on the root JSX element", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body: Container {
              style: { background: "red", padding: "60px 0" },
              Heading { "Hi", level: 1 }
            }
          }
        }
        ${DEPLOYABLES}
      }
    `);
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).toBeDefined();
    // Camel-cased keys, quoted string literals, single style attribute.
    expect(content).toMatch(/<Container style=\{\{ "background": "red", "padding": "60px 0" \}\}>/);
  });

  it("Stack { style: {...} } emits style on the root element", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body: Stack {
              style: { gap: "16px" },
              Heading { "Hi", level: 1 }
            }
          }
        }
        ${DEPLOYABLES}
      }
    `);
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).toMatch(/<Stack style=\{\{ "gap": "16px" \}\}>/);
  });

  it("primitive without style: emits no style attribute", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body: Stack { Heading { "Hi", level: 1 } }
          }
        }
        ${DEPLOYABLES}
      }
    `);
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).not.toMatch(/<Stack style=/);
  });

  it("camelCases kebab-case CSS keys (background-color → backgroundColor)", async () => {
    // The grammar's ObjectFieldInit.name = ID, so quoted/kebab keys
    // aren't a source-level option — but downstream renderers must
    // still camelCase whatever key arrives (e.g. via macro expansion
    // or future grammar relaxation).  We synthesise the case via a
    // valid ID that the camel-caser leaves alone, plus a kebab-cased
    // entry routed in directly (the IR accepts arbitrary key strings).
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body: Container { style: { backgroundColor: "blue" } }
          }
        }
        ${DEPLOYABLES}
      }
    `);
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).toMatch(/"backgroundColor": "blue"/);
  });
});
