// ternary conditional rendering in walker bodies.
//
// Surface:
//   state { loading: bool = false }
//   body: loading ? Empty("Loading…") : Stack(Heading("Done"))
//
// Top-level ternary renders directly as the function's return value:
//   return (
//     loading ? (
//       <Center mih={200}><Text c="dimmed">Loading…</Text></Center>
//     ) : (
//       <Stack>...</Stack>
//     )
//   );
//
// Nested ternaries (as a child of Stack/Group/etc) brace-wrap into
// JSX-expression form: `{cond ? <A /> : <B />}`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("ternary conditional rendering in walker pages", () => {
  it("top-level ternary body renders as function-return conditional", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            state { loading: bool = false }
            body:  loading ? Empty("Loading...") : Stack(Heading("Done"))
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
    expect(content).toBeDefined();
    // Cond + parens-wrapped branches.
    expect(content).toMatch(/loading \? \(/);
    expect(content).toMatch(/<Center mih=\{200\}><Text c="dimmed">Loading\.\.\.<\/Text><\/Center>/);
    expect(content).toMatch(/\) : \(/);
    expect(content).toMatch(/<Stack>/);
    expect(content).toMatch(/<Title order=\{2\}>Done<\/Title>/);
    expect(content).toMatch(/<\/Stack>/);
    // State usage detected → useState declaration.
    expect(content).toMatch(/const \[loading, setLoading\] = useState/);
  });

  it("nested ternary as a child of Stack brace-wraps into JSX expr", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            state { active: bool = true }
            body:  Stack(
              Heading("Status"),
              active ? Badge("Live") : Badge("Off"),
              Text("more")
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
    const content = files.get("web/src/pages/x.tsx")!;
    // Brace-wrapped JSX expression in child position.
    expect(content).toMatch(/\{active \? \(/);
    expect(content).toMatch(/<Badge>Live<\/Badge>/);
    expect(content).toMatch(/<Badge>Off<\/Badge>/);
  });

  it("ternary cond accepts a binary expression (state arithmetic)", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            state {
              count: int = 0
              limit: int = 10
            }
            body:  count > limit ? Heading("Over") : Heading("Under")
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
    expect(content).toMatch(/\(count > limit\) \? \(/);
    expect(content).toMatch(/<Title order=\{2\}>Over<\/Title>/);
    expect(content).toMatch(/<Title order=\{2\}>Under<\/Title>/);
  });

  it("ternary cond accepts a route-param ref", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Greet(active: string) {
            route: "/g/:active"
            body:  active ? Heading("Yes") : Heading("No")
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
    expect(content).toMatch(/active \? \(/);
    // Param consumed → destructured.
    expect(content).toMatch(/const \{ active \} = useParams/);
  });
});
