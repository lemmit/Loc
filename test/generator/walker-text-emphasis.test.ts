// Inline text-emphasis primitives — Bold / Italic / InlineCode.
//
//   Bold       { "..." }  →  <strong>…</strong>
//   Italic     { "..." }  →  <em>…</em>
//   InlineCode { "..." }  →  <code>…</code>
//
// Each takes a single positional string argument and lowers through
// the active design pack's `primitive-bold` / `primitive-italic` /
// `primitive-inline-code` template.  The default pack templates emit
// the corresponding bare HTML tag — so no additional import is
// required on the React page shell.

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

async function buildAndGenerate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { valslugation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

function pageSrc(body: string): string {
  return `
    system S {
      module M { context C { } }
      ui WebApp {
        page Home {
          route: "/"
          body: ${body}
        }
      }
      deployable api { platform: hono, modules: M, port: 3000 }
      deployable web {
        platform: static
        targets: api
        ui: WebApp
        port: 3001
      }
    }
  `;
}

describe("inline text emphasis primitives", () => {
  it('Bold { "hi" } emits <strong>hi</strong>', async () => {
    const files = await buildAndGenerate(pageSrc(`Bold { "hi" }`));
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).toBeDefined();
    expect(content).toMatch(/<strong>hi<\/strong>/);
  });

  it('Italic { "hi" } emits <em>hi</em>', async () => {
    const files = await buildAndGenerate(pageSrc(`Italic { "hi" }`));
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).toBeDefined();
    expect(content).toMatch(/<em>hi<\/em>/);
  });

  it('InlineCode { "x" } emits <code>x</code>', async () => {
    const files = await buildAndGenerate(pageSrc(`InlineCode { "x" }`));
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).toBeDefined();
    expect(content).toMatch(/<code>x<\/code>/);
  });

  it("emphasis primitives compose inside a Stack with surrounding Text", async () => {
    const files = await buildAndGenerate(
      pageSrc(`Stack {
        Text { "before " },
        Bold { "strong" },
        Text { " mid " },
        Italic { "em" },
        Text { " end " },
        InlineCode { ".ddd" }
      }`),
    );
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).toMatch(/<strong>strong<\/strong>/);
    expect(content).toMatch(/<em>em<\/em>/);
    expect(content).toMatch(/<code>\.ddd<\/code>/);
  });
});
