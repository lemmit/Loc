// page-level `title:` declaration wires into a
// `useEffect` that sets `document.title` on mount and re-runs
// whenever any referenced param / state field changes.  Deps array
// is auto-derived from the title expression's refs so React's
// exhaustive-deps lint stays clean.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("page title via useEffect(document.title)", () => {
  it('static title: "..." emits a useEffect with empty deps', async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            title: "Acme — Home"
            body:  Heading { "Welcome" }
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
    expect(content).toBeDefined();
    expect(content).toMatch(/import \{ useEffect \} from "react";/);
    expect(content).toMatch(/useEffect\(\(\) => \{ document\.title = "Acme — Home"; \}, \[\]\);/);
  });

  it("title interpolating a route param adds it to deps + destructures it", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page User(name: string) {
            route: "/u/:name"
            title: "User: " + name
            body:  Heading { name }
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
    const content = files.get("web/src/pages/user.tsx")!;
    expect(content).toMatch(/const \{ name \} = useParams<\{ name: string \}>\(\);/);
    expect(content).toMatch(
      /useEffect\(\(\) => \{ document\.title = \("User: " \+ name\); \}, \[name\]\);/,
    );
  });

  it("title interpolating state → useState + useEffect import on one line, state in deps", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Counter {
            route: "/c"
            state { count: int = 0 }
            title: "Count: " + count
            body:  Button { "+", onClick: e => { count += 1 } }
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
    // useState + useEffect deduped on a single React import line.
    expect(content).toMatch(/import \{ useState, useEffect \} from "react";/);
    expect(content).toMatch(/const \[count, setCount\] = useState<number>\(0\);/);
    // Effect deps include the state field referenced in the title.
    expect(content).toMatch(
      /useEffect\(\(\) => \{ document\.title = \("Count: " \+ count\); \}, \[count\]\);/,
    );
  });

  it("title with both param and state: deps array sorted, both names included", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Hybrid(slug: string) {
            route: "/h/:slug"
            state { n: int = 0 }
            title: slug + ":" + n
            body:  Text { "hi" }
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
    const content = files.get("web/src/pages/hybrid.tsx")!;
    // n + slug — deps array sorted.
    expect(content).toMatch(/useEffect\(\(\) => \{ document\.title = .+; \}, \[n, slug\]\);/);
    // Both names made it into the appropriate destructures.
    expect(content).toMatch(/const \{ slug \} = useParams/);
    expect(content).toMatch(/const \[n, setN\] = useState/);
  });

  it("page without title emits no useEffect import and no effect line", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Plain {
            route: "/plain"
            body:  Heading { "hi" }
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
    expect(content).not.toMatch(/useEffect/);
    expect(content).not.toMatch(/document\.title/);
  });
});
