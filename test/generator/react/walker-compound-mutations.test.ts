// compound assignment ergonomics in onClick lambdas.
//
//   count += 1                → setCount(count + 1)
//   count -= 1                → setCount(count - 1)
//
// Both lower to the IR's `kind: "add"` / `kind: "remove"` shape
// (the same kinds collection mutations use; for scalar state
// they're compound additions / subtractions).  The walker previously emitted
// the long form `count := count + 1`; the
// counter-style sugar so click handlers read more naturally.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("+= / -= in onClick mutations", () => {
  it("count += 1 lowers to setCount(count + 1)", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Counter {
            route: "/c"
            state { count: int = 0 }
            body:  Stack {
              Text { count },
              Button { "+", onClick: e => { count += 1 } }
            }
          }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
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
        subdomain M { context C { } }
        ui WebApp {
          page Counter {
            route: "/c"
            state { count: int = 0 }
            body:  Button { "-", onClick: e => { count -= 1 } }
          }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
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
        subdomain M { context C { } }
        ui WebApp {
          page Counter {
            route: "/c"
            state {
              count: int = 0
              step: int = 5
            }
            body:  Button { "Bump", onClick: e => { count += step * 2 } }
          }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
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
        subdomain M { context C { } }
        ui WebApp {
          page Counter {
            route: "/c"
            state {
              a: int = 0
              b: int = 10
              c: int = 0
            }
            body:  Button {"Mix", onClick: e => {
              a += 1
              b -= 1
              c := 99
            }}
          }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
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
        subdomain M { context C { } }
        ui WebApp {
          page P {
            route: "/p"
            state { draft: int = 0 }
            body:  Button { "x", onClick: e => { draft.note := 1 } }
          }
        }
        deployable api { platform: hono, contexts: [C], port: 3000 }
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
