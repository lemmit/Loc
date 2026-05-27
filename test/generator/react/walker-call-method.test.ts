// function & method calls in walker expressions
// and statements (with v0 caveat for method calls).
//
// onClick lambdas can invoke FREE functions that the user
// expects to import / declare in their app:
//
//   Button { "Save", onClick: e => { saveOrder() } }
//     → <Button onClick={() => { saveOrder(); }}>Save</Button>
//
// METHOD calls (`Orders.create(draft)`) need a hooks-binding
// mechanism the walker doesn't yet provide — so v0 emits a
// visible TODO placeholder, NOT runtime-broken code like
// `undefined.create(draft)`.  A later change will
// resolve aggregate / workflow / view method calls into auto-
// emitted React Query hook calls.
//
// Same call shape works inside expression positions for free
// functions:
//
//   state { count: int = 0 }
//   body: Text { "doubled: " + double(count) }
//     → <Text>{("doubled: " + double(count))}</Text>

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("function + method calls in walker bodies", () => {
  it("bare function-call statement in onClick lambda emits as a JS call", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            body:  Button { "Save", onClick: e => { saveOrder() } }
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
    expect(content).toMatch(/<Button onClick=\{\(\) => \{ saveOrder\(\); \}\}>Save<\/Button>/);
  });

  it("function-call expression in let RHS emits inline", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            state { count: int = 0 }
            body:  Button {"Bump", onClick: e => {
              let n = inc(count)
              count := n
            }}
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

  it("method call against an unresolved receiver emits a placeholder, not broken code", async () => {
    // v0 caveat — `Orders.create(draft)` needs the forthcoming
    // `hooks {}` binding mechanism to resolve to a real React Query
    // mutation hook.  Today, the walker emits a visible TODO
    // placeholder (the previous behaviour produced runtime-broken
    // `undefined.create(draft)` code; this test pins the honest
    // shape).
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            state { draft: int = 0 }
            body:  Button { "Sync", onClick: e => { Orders.create(draft) } }
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
    // Placeholder comment, NOT broken `undefined.create(...)` code.
    expect(content).toMatch(/TODO: method-call Orders\.create\(draft\)/);
    expect(content).not.toMatch(/undefined\.create\(/);
  });

  it("function call in text-position expression renders as JSX expr", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            state { count: int = 0 }
            body:  Text { "doubled: " + double(count) }
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
    expect(content).toMatch(/<Text>\{\("doubled: " \+ double\(count\)\)\}<\/Text>/);
  });

  it("method call with multiple args + state ref still emits placeholder", async () => {
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
            body:  Button { "Mix", onClick: e => { mixer.combine(a, b, "extra") } }
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
    expect(content).toMatch(/TODO: method-call mixer\.combine\(a, b, "extra"\)/);
    expect(content).not.toMatch(/undefined\.combine\(/);
  });
});
