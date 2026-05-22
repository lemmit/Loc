// Slice 11.5 — `Button("label", to: "/path")` wires the rendered
// Mantine button to a React-Router navigate call.  The page shell
// pulls `useNavigate` from `react-router` and declares
// `const navigate = useNavigate()` so the generated onClick lambda
// resolves at render time.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("Slice 11.5 — Button(to:) navigation in walker-rendered pages", () => {
  it("emits useNavigate hook + onClick when to: is a string literal", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body:  Stack(Heading("Welcome"), Button("Go to orders", to: "/orders"))
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
    // useNavigate import + hook call.
    expect(content).toMatch(/import \{ useNavigate \} from "react-router";/);
    expect(content).toMatch(/const navigate = useNavigate\(\);/);
    // Button onClick lambda navigates to the literal path.
    expect(content).toMatch(
      /<Button onClick=\{\(\) => navigate\("\/orders"\)\}>Go to orders<\/Button>/,
    );
  });

  it("multiple Buttons in a page share one useNavigate hook", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body:  Stack(
              Button("Orders", to: "/orders"),
              Button("Settings", to: "/settings")
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
    const content = files.get("web/src/pages/home.tsx")!;
    // Hook declared exactly once.
    const matches = content.match(/const navigate = useNavigate\(\);/g) ?? [];
    expect(matches).toHaveLength(1);
    // Both buttons emit their onClick.
    expect(content).toMatch(/<Button onClick=\{\(\) => navigate\("\/orders"\)\}>Orders<\/Button>/);
    expect(content).toMatch(
      /<Button onClick=\{\(\) => navigate\("\/settings"\)\}>Settings<\/Button>/,
    );
  });

  it("Button without to: stays unwired (no onClick)", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body:  Button("Click me")
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
    expect(content).toMatch(/<Button>Click me<\/Button>/);
    expect(content).not.toMatch(/onClick=/);
    expect(content).not.toMatch(/useNavigate/);
  });

  it("page combining route params + Button(to:) imports both useParams and useNavigate", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Detail(slug: string) {
            route: "/items/:slug"
            body:  Stack(Heading(slug), Button("Back", to: "/"))
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
    const content = files.get("web/src/pages/detail.tsx")!;
    // Single combined import line (specifier order: useParams first,
    // useNavigate second, matches the shell logic).
    expect(content).toMatch(/import \{ useParams, useNavigate \} from "react-router";/);
    expect(content).toMatch(/const \{ slug \} = useParams<\{ slug: string \}>\(\);/);
    expect(content).toMatch(/const navigate = useNavigate\(\);/);
    expect(content).toMatch(/<Button onClick=\{\(\) => navigate\("\/"\)\}>Back<\/Button>/);
  });

  it("Button(to: <param-ref>) interpolates the param via template literal", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Home(slug: string) {
            route: "/h/:slug"
            body:  Button("Open", to: slug)
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
    // Template literal interpolating the route param at render time.
    expect(content).toMatch(/<Button onClick=\{\(\) => navigate\(`\$\{slug\}`\)\}>Open<\/Button>/);
    // Param consumed by the Button to: arg → destructured in shell.
    expect(content).toMatch(/const \{ slug \} = useParams/);
  });
});
