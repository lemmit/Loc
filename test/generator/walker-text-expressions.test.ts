// Slice 11.10 — arbitrary expressions in text positions.
//
// Before this slice: text-position slots in Heading / Text / Stat
// / Badge / Card-title only accepted string literals or single
// refs.  Anything richer (string concat, arithmetic) silently
// fell back to the component default.
//
// After: any non-call expression renders through `emitExpr`
// wrapped in `{...}` JSX expression brackets.  Calls are still
// child components (walked recursively, never emitted as text).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("Slice 11.10 — expressions in text positions", () => {
  it('Heading("Hello, " + name) emits the binary op as a JSX expr', async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Greet(name: string) {
            route: "/greet/:name"
            body:  Heading("Hello, " + name)
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
    const content = files.get("web/src/pages/greet.tsx")!;
    expect(content).toBeDefined();
    // Binary op rendered as a JSX expression — both operands resolved.
    expect(content).toMatch(/<Title order=\{2\}>\{\("Hello, " \+ name\)\}<\/Title>/);
    // Param consumed → destructured in shell.
    expect(content).toMatch(/const \{ name \} = useParams/);
  });

  it("Text(count + 1) emits state arithmetic", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Counter {
            route: "/c"
            state { count: int = 0 }
            body:  Stack(
              Text(count + 1),
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
    expect(content).toMatch(/<Text>\{\(count \+ 1\)\}<\/Text>/);
    // State usage detected → useState declaration emitted.
    expect(content).toMatch(/const \[count, setCount\] = useState/);
  });

  it("Stat slots accept binary ops in either position", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Dashboard {
            route: "/d"
            state {
              total: int = 100
              count: int = 47
            }
            body:  Stat("Active: " + count, total - count)
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
    const content = files.get("web/src/pages/dashboard.tsx")!;
    expect(content).toMatch(/<Text size="sm" c="dimmed">\{\("Active: " \+ count\)\}<\/Text>/);
    expect(content).toMatch(/<Text fw=\{700\} size="xl">\{\(total - count\)\}<\/Text>/);
  });

  it("Card title accepts a binary-op expression", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page UserCard(name: string) {
            route: "/users/:name"
            body:  Card("Profile: " + name, Text("hello"))
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
    const content = files.get("web/src/pages/user_card.tsx")!;
    // Card title slot picks up the binary op (not the inner Text).
    expect(content).toMatch(/<Title order=\{3\}>\{\("Profile: " \+ name\)\}<\/Title>/);
    // Inner Text is the content child.
    expect(content).toMatch(/<Text>hello<\/Text>/);
  });

  it("Card with state-ref title (no longer needs param-only fallback)", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page S {
            route: "/s"
            state { label: string = "Section" }
            body:  Card(label, Text("body"))
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
    const content = files.get("web/src/pages/s.tsx")!;
    expect(content).toMatch(/<Title order=\{3\}>\{label\}<\/Title>/);
    expect(content).toMatch(/<Text>body<\/Text>/);
    // State ref consumed → useState declaration emitted.
    expect(content).toMatch(/const \[label, setLabel\]/);
  });

  it("Card(child-only) — call in first slot stays as content, no title", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Plain {
            route: "/plain"
            body:  Card(Text("just content"))
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
    const content = files.get("web/src/pages/plain.tsx")!;
    // No Title heading because the only positional was a call.
    expect(content).not.toMatch(/<Title/);
    expect(content).toMatch(/<Text>just content<\/Text>/);
  });

  it("Text(42) emits the int literal as a JSX expr", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page N {
            route: "/n"
            body:  Text(42)
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
    const content = files.get("web/src/pages/n.tsx")!;
    expect(content).toMatch(/<Text>\{42\}<\/Text>/);
  });
});
