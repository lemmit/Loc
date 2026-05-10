// Slice 11.23 — function & method calls in walker expressions
// and statements.
//
// onClick lambdas can now invoke functions and methods that the
// user expects to import / declare in their app:
//
//   Button("Save", onClick: e => { saveOrder() })
//     → <Button onClick={() => { saveOrder(); }}>Save</Button>
//
//   Button("Sync", onClick: e => { Orders.create(draft) })
//     → <Button onClick={() => { Orders.create(draft); }}>Sync</Button>
//
// Same shape works inside expression positions:
//
//   state { count: int = 0 }
//   body: Text("doubled: " + double(count))
//     → <Text>{("doubled: " + double(count))}</Text>

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { generateSystems } from "../src/system/index.js";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";

async function buildAndGenerate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

describe("Slice 11.23 — function + method calls in walker bodies", () => {
  it("bare function-call statement in onClick lambda emits as a JS call", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            body:  Button("Save", onClick: e => { saveOrder() })
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
    expect(content).toMatch(
      /<Button onClick=\{\(\) => \{ saveOrder\(\); \}\}>Save<\/Button>/,
    );
  });

  it("function-call expression in let RHS emits inline", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            state { count: int = 0 }
            body:  Button("Bump", onClick: e => {
              let n = inc(count)
              count := n
            })
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
    expect(content).toMatch(
      /<Button onClick=\{\(\) => \{ const n = inc\(count\); setCount\(n\); \}\}>Bump<\/Button>/,
    );
  });

  it("method call in onClick lambda emits as receiver.method(args)", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            state { draft: int = 0 }
            body:  Button("Sync", onClick: e => { Orders.create(draft) })
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
    expect(content).toMatch(
      /<Button onClick=\{\(\) => \{ \/\* unresolved: Orders \*\/ undefined\.create\(draft\); \}\}>Sync<\/Button>/,
    );
  });

  it("function call in text-position expression renders as JSX expr", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            state { count: int = 0 }
            body:  Text("doubled: " + double(count))
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
    expect(content).toMatch(
      /<Text>\{\("doubled: " \+ double\(count\)\)\}<\/Text>/,
    );
  });

  it("method call with multiple args + state ref", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            state {
              a: int = 1
              b: int = 2
            }
            body:  Button("Mix", onClick: e => { mixer.combine(a, b, "extra") })
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
    expect(content).toMatch(
      /\/\* unresolved: mixer \*\/ undefined\.combine\(a, b, "extra"\);/,
    );
  });
});
