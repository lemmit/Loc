// Slice 11.9 — compound assignment ergonomics in onClick lambdas.
//
//   count += 1                → setCount(count + 1)
//   count -= 1                → setCount(count - 1)
//
// Both lower to the IR's `kind: "add"` / `kind: "remove"` shape
// (the same kinds collection mutations use; for scalar state
// they're compound additions / subtractions).  Slice 11.7 emitted
// the long form `count := count + 1`; this slice adds the
// counter-style sugar so click handlers read more naturally.

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

async function buildAndGenerate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

describe("Slice 11.9 — += / -= in onClick mutations", () => {
  it("count += 1 lowers to setCount(count + 1)", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Counter {
            route: "/c"
            state { count: int = 0 }
            body:  Stack(
              Text(count),
              Button("+", onClick: e => { count += 1 })
            )
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
    const content = files.get("web/src/pages/counter.tsx")!;
    expect(content).toBeDefined();
    expect(content).toMatch(/setCount\(count \+ 1\);/);
  });

  it("count -= 1 lowers to setCount(count - 1)", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Counter {
            route: "/c"
            state { count: int = 0 }
            body:  Button("-", onClick: e => { count -= 1 })
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
    const content = files.get("web/src/pages/counter.tsx")!;
    expect(content).toMatch(/setCount\(count - 1\);/);
  });

  it("compound rhs expression: count += step * 2", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Counter {
            route: "/c"
            state {
              count: int = 0
              step: int = 5
            }
            body:  Button("Bump", onClick: e => { count += step * 2 })
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
    const content = files.get("web/src/pages/counter.tsx")!;
    // The rhs is a binary op — emitExpr already parenthesises it.
    expect(content).toMatch(/setCount\(count \+ \(step \* 2\)\);/);
  });

  it("mixed +=, -=, := in one onClick handler all emit in order", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Counter {
            route: "/c"
            state {
              a: int = 0
              b: int = 10
              c: int = 0
            }
            body:  Button("Mix", onClick: e => {
              a += 1
              b -= 1
              c := 99
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
    const content = files.get("web/src/pages/counter.tsx")!;
    expect(content).toMatch(
      /<Button onClick=\{\(\) => \{ setA\(a \+ 1\); setB\(b - 1\); setC\(99\); \}\}>Mix<\/Button>/,
    );
  });

  it("fails loud on an unlowerable multi-segment assignment (no silent drop)", async () => {
    // A handler statement the walker can't lower used to emit a
    // `/* unsupported assign */` comment — compiling fine but silently
    // doing nothing at runtime (a dead button).  It must now throw.
    const build = buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page P {
            route: "/p"
            state { draft: int = 0 }
            body:  Button("x", onClick: e => { draft.note := 1 })
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
    await expect(build).rejects.toThrow(
      /unsupported assignment to 'draft\.note' in a page event handler/,
    );
  });
});
