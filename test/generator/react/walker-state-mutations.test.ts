// state {} fields + onClick lambda mutations.
// First interactive walker primitive: a click counter renders end
// to end without a single line of TS hand-written.
//
//   page Counter {
//     route: "/counter"
//     state { count: int = 0 }
//     body: Stack {
//       Heading { "Counter" },
//       Text { count },
//       Button { "Increment", onClick: e => { count := count + 1 } }
//     }
//   }
//
// becomes a fully-wired React component with `useState`, the body
// referencing `{count}`, and the onClick lambda emitting
// `setCount(count + 1)`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("state + onClick mutations in walker pages", () => {
  it("click counter — useState + state ref + setX in onClick handler", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Counter {
            route: "/counter"
            state { count: int = 0 }
            action inc() { count := count + 1 }
            body:  Stack {
              Heading { "Counter" },
              Text { count },
              Button { "Increment", onClick: inc }
            }
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
    const content = files.get("web/src/pages/counter.tsx")!;
    expect(content).toBeDefined();
    // useState import + per-field declaration.
    expect(content).toMatch(/import \{ useState \} from "react";/);
    expect(content).toMatch(/const \[count, setCount\] = useState<number>\(0\);/);
    // Body refs render as JSX expressions.
    expect(content).toMatch(/<Text>\{count\}<\/Text>/);
    // The named `action` hoists to a const whose body lowers
    // `count := count + 1` → setCount(count + 1); the control just references
    // it.  (An inline `onClick: e => { … }` is rejected by
    // `loom.effect-in-lambda`, so the hoisted form is the only one a user can
    // reach.)
    expect(content).toMatch(/const inc = \(\) => \{ setCount\(\(count \+ 1\)\); \};/);
    expect(content).toMatch(/<Button onClick=\{inc\}>\{t\("[^"]*", "Increment"\)\}<\/Button>/);
  });

  it("page declares state but body never refs it → no useState in shell", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Stale {
            route: "/stale"
            state { unused: int = 7 }
            body:  Heading { "No state in sight" }
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
    const content = files.get("web/src/pages/stale.tsx")!;
    // Walker only emits useState plumbing when something actually
    // referenced state.  Pure-static body keeps the shell silent.
    expect(content).not.toMatch(/useState/);
    expect(content).not.toMatch(/setUnused/);
  });

  it("string-typed state with no init → empty-string default", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Greet {
            route: "/greet"
            state { who: string }
            action setWho() { who := "world" }
            body:  Stack {
              Text { who },
              Button { "Set", onClick: setWho }
            }
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
    const content = files.get("web/src/pages/greet.tsx")!;
    expect(content).toMatch(/const \[who, setWho\] = useState<string>\(""\);/);
    expect(content).toMatch(/setWho\("world"\);/);
  });

  it("bool state with init = true → useState<boolean>(true)", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Toggle {
            route: "/toggle"
            state { open: bool = true }
            action close() { open := false }
            body:  Stack {
              Text { open },
              Button { "Close", onClick: close }
            }
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
    const content = files.get("web/src/pages/toggle.tsx")!;
    expect(content).toMatch(/const \[open, setOpen\] = useState<boolean>\(true\);/);
    expect(content).toMatch(/setOpen\(false\);/);
  });

  it("multi-statement onClick body emits all stmts in order", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Pair {
            route: "/pair"
            state {
              a: int = 0
              b: int = 0
            }
            action bump() {
              a := a + 1
              b := b + 2
            }
            body:  Button {"Bump", onClick: bump}
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
    const content = files.get("web/src/pages/pair.tsx")!;
    // Both setters declared.
    expect(content).toMatch(/const \[a, setA\] = useState<number>\(0\);/);
    expect(content).toMatch(/const \[b, setB\] = useState<number>\(0\);/);
    // Both emitted, in order, in the hoisted action body.
    expect(content).toMatch(/const bump = \(\) => \{ setA\(\(a \+ 1\)\); setB\(\(b \+ 2\)\); \};/);
    expect(content).toMatch(/<Button onClick=\{bump\}>\{t\("[^"]*", "Bump"\)\}<\/Button>/);
  });

  it("onClick lambda takes priority over to: when both are written", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Confused {
            route: "/x"
            state { n: int = 0 }
            action bump() { n := n + 1 }
            body:  Button {"Do",
              to: "/elsewhere",
              onClick: bump
            }
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
    const content = files.get("web/src/pages/confused.tsx")!;
    // onClick wins → no useNavigate, no navigate(...) call.
    expect(content).not.toMatch(/useNavigate/);
    expect(content).not.toMatch(/navigate\(/);
    expect(content).toMatch(/setN\(\(n \+ 1\)\);/);
  });
});
