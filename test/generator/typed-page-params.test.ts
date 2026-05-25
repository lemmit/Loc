// typed page parameters threaded into walker-rendered
// pages.  When a page declares route params:
//
//   page Hello(name: string) {
//     route: "/hello/:name"
//     body:  Heading { name }
//   }
//
// the walker now resolves `Heading { name }` to `<Title>{name}</Title>`,
// the page shell adds `useParams<{ name: string }>()` + destructuring,
// and the React component is fully wired to its route param at
// render time.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("typed page parameters in walker-rendered pages", () => {
  it("emits useParams + destructure when a param is referenced", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Hello(name: string) {
            route: "/hello/:name"
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
    const content = files.get("web/src/pages/hello.tsx")!;
    expect(content).toBeDefined();
    // useParams import + typed generic + destructure of `name`.
    expect(content).toMatch(/import \{ useParams \} from "react-router";/);
    expect(content).toMatch(/const \{ name \} = useParams<\{ name: string \}>\(\);/);
    // Heading { name } → <Title order={2}>{name}</Title> (JSX expr, not text).
    expect(content).toMatch(/<Title order=\{2\}>\{name\}<\/Title>/);
  });

  it("multi-param pages get a typed object generic + only-used destructure", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M {
          context C {
            aggregate Customer { name: string }
            repository Customers for Customer { }
          }
        }
        ui WebApp {
          page Greet(name: string, customerId: Customer id) {
            route: "/greet/:name/:customerId"
            body:  Stack { Heading { name }, Text { "Welcome." } }
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
    // Type generic includes BOTH params (typed shape stays
    // intact regardless of usage).
    expect(content).toMatch(/useParams<\{ name: string; customerId: string \}>/);
    // Destructure only the params actually referenced — `name`
    // was used, `customerId` wasn't, so only `name` is pulled out.
    expect(content).toMatch(/const \{ name \} = useParams/);
    expect(content).not.toMatch(/const \{ name, customerId \}/);
  });

  it("page with params but no ref usage still calls useParams (typed shape preserved)", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X(id: string) {
            route: "/x/:id"
            body:  Heading { "static title" }
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
    // Bare useParams call (no destructure) so the type shape
    // stays in the file even when nothing's currently used.
    // Could also have skipped — chose to keep it as documentation.
    expect(content).toMatch(/useParams<\{ id: string \}>\(\);/);
    expect(content).not.toMatch(/const \{.+\} = useParams/);
  });

  it("page without params has no useParams hook", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Welcome {
            route: "/welcome"
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
    const content = files.get("web/src/pages/welcome.tsx")!;
    expect(content).not.toMatch(/useParams/);
    expect(content).not.toMatch(/react-router/);
    expect(content).toMatch(/<Title order=\{2\}>Welcome<\/Title>/);
  });

  it("Text { name } — ref in Text position resolves to {name}", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page User(name: string) {
            route: "/users/:name"
            body:  Text { name }
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
    expect(content).toMatch(/<Text>\{name\}<\/Text>/);
  });

  it("ref to non-param name still emits as a placeholder (build-warn shape)", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Page(realParam: string) {
            route: "/p/:realParam"
            body:  Heading { unknownThing }
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
    const content = files.get("web/src/pages/page.tsx")!;
    // unknownThing isn't a route param → walker emits a JSX
    // comment placeholder (visible in the file, no crash).
    expect(content).toMatch(/ref: unknownThing/);
  });

  it("Card { name, Stack { ... } } — param ref resolves in Card title position", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Profile(userName: string) {
            route: "/profile/:userName"
            body:  Card { userName, Stack { Text { "hello" } } }
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
    const content = files.get("web/src/pages/profile.tsx")!;
    // Card got a title from the userName ref.
    expect(content).toMatch(/<Title order=\{3\}>\{userName\}<\/Title>/);
    // Card wraps the inner Stack with the static Text child.
    expect(content).toMatch(/<Card withBorder padding="md">/);
    expect(content).toMatch(/<Text>hello<\/Text>/);
  });
});
