// Slice 11.19 — Slot() + children prop for user components.
// Components with `Slot()` in their body get a typed `children`
// prop and accept extra positional args from the caller as JSX
// children.  Closes the composition loop: components can wrap
// arbitrary content the parent declares.

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";
import { generateSystems } from "../src/system/index.js";

async function buildAndGenerate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

describe("Slice 11.19 — Slot + children prop", () => {
  it("component with Slot() emits children prop in Props interface", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          component PageBox(title: string) {
            body: Card(title, Slot())
          }
          page Home {
            route: "/"
            body:  Heading("home")
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
    `);
    const content = files.get("web/src/components/PageBox.tsx")!;
    expect(content).toBeDefined();
    expect(content).toMatch(/import type \{ ReactNode \} from "react";/);
    expect(content).toMatch(
      /export interface PageBoxProps \{\n\s+title: string;\n\s+children\?: ReactNode;\n\}/,
    );
    expect(content).toMatch(
      /export default function PageBox\(\{ title, children \}: PageBoxProps\)/,
    );
    // Body shows the Slot rendered as {children}.
    expect(content).toMatch(/\{children\}/);
  });

  it("page passes extra positionals as JSX children", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          component PageBox(title: string) {
            body: Card(title, Slot())
          }
          page Home {
            route: "/"
            body:  PageBox("Welcome", Text("hi"), Text("world"))
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
    `);
    const content = files.get("web/src/pages/home.tsx")!;
    // PageBox emits as a wrapping element with title attr + nested children.
    expect(content).toMatch(/<PageBox title="Welcome">/);
    expect(content).toMatch(/<Text>hi<\/Text>/);
    expect(content).toMatch(/<Text>world<\/Text>/);
    expect(content).toMatch(/<\/PageBox>/);
  });

  it("component without Slot() doesn't get a children prop", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          component Plain(s: string) {
            body: Text(s)
          }
          page X {
            route: "/x"
            body:  Plain("hi")
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
    `);
    const content = files.get("web/src/components/Plain.tsx")!;
    expect(content).not.toMatch(/children/);
    expect(content).not.toMatch(/ReactNode/);
  });

  it("named args still map to props even when extras become children", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          component Box(title: string, color: string) {
            body: Card(title, Slot())
          }
          page X {
            route: "/x"
            body:  Box("Title", color: "red", Text("body"))
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
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    // title from positional, color from named arg.
    expect(content).toMatch(/<Box title="Title" color="red">/);
    expect(content).toMatch(/<Text>body<\/Text>/);
  });

  it("zero-arg invocation of a Slot-using component emits a self-closing tag", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          component Ghost() {
            body: Card("ghost", Slot())
          }
          page X {
            route: "/x"
            body:  Ghost()
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
    `);
    const content = files.get("web/src/pages/x.tsx")!;
    // No props, no children → self-closing.
    expect(content).toMatch(/<Ghost \/>/);
  });
});
