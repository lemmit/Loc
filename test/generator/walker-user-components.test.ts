// User-defined components.  ComponentIR finally has
// output: each `component <Name>(p: T) { body: ... }` declaration
// emits as `src/components/<Name>.tsx` with a typed Props
// interface, and walker pages can invoke them as JSX elements
// (`<WelcomeBox name="Alice" />`).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("user-defined components", () => {
  it("component declaration emits a tsx file with typed Props", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          component WelcomeBox(name: string) {
            body: Card { "Hello, " + name, Stack { Text { "Welcome!" } } }
          }
          page Home {
            route: "/"
            body:  Heading { "home" }
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
    const content = files.get("web/src/components/WelcomeBox.tsx")!;
    expect(content).toBeDefined();
    // Props interface declared.
    expect(content).toMatch(/export interface WelcomeBoxProps \{\n\s+name: string;\n\}/);
    // Default-export fn with destructured props.
    expect(content).toMatch(/export default function WelcomeBox\(\{ name \}: WelcomeBoxProps\)/);
    // Body walked: Card with binary-op title + Stack child.
    expect(content).toMatch(/<Card withBorder padding="md">/);
    expect(content).toMatch(/<Title order=\{3\}>\{\("Hello, " \+ name\)\}<\/Title>/);
    expect(content).toMatch(/<Text>Welcome!<\/Text>/);
  });

  it("walker page can invoke a user component with positional args", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          component WelcomeBox(name: string) {
            body: Card { "Hi, " + name, Text { "welcome" } }
          }
          page Home {
            route: "/"
            body:  WelcomeBox("Alice")
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
    // Page imports the user component from ../components.
    expect(content).toMatch(/import WelcomeBox from "\.\.\/components\/WelcomeBox";/);
    // JSX invocation maps positional arg → param name as prop.
    expect(content).toMatch(/<WelcomeBox name="Alice" \/>/);
  });

  it("user component invocation with a non-string arg renders as JSX expression", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          component CounterBadge(n: int) {
            body: Badge { "Count: " + n }
          }
          page Home {
            route: "/"
            state { x: int = 5 }
            body:  CounterBadge(x)
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
    // Ref → `n={x}` JSX-expr attr.
    expect(content).toMatch(/<CounterBadge n=\{x\} \/>/);
    // State usage detected → useState declaration.
    expect(content).toMatch(/const \[x, setX\] = useState/);
  });

  it("user component invocation accepts named args", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          component LabeledIcon(icon: string, label: string) {
            body: Stack { Text { icon }, Text { label } }
          }
          page Home {
            route: "/"
            body:  LabeledIcon(icon: "star", label: "Featured")
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
    // Named args use their declared names verbatim.
    expect(content).toMatch(/<LabeledIcon icon="star" label="Featured" \/>/);
  });

  it("multiple user components dedupe imports per page", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          component Foo(s: string) {
            body: Text { s }
          }
          component Bar(s: string) {
            body: Heading { s }
          }
          page Home {
            route: "/"
            body:  Stack { Foo("a"), Bar("b"), Foo("c") }
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
    // Each user component imported once even when invoked twice.
    const fooImports = content.match(/import Foo from/g) ?? [];
    expect(fooImports).toHaveLength(1);
    const barImports = content.match(/import Bar from/g) ?? [];
    expect(barImports).toHaveLength(1);
    // Both invocations of Foo render.
    expect(content.match(/<Foo s=/g)).toHaveLength(2);
  });

  it("component invokes another component (cross-component composition)", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          component Inner(n: string) {
            body: Text { n }
          }
          component Outer(name: string) {
            body: Card { "Outer", Inner(name) }
          }
          page Home {
            route: "/"
            body:  Outer("X")
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
    const outer = files.get("web/src/components/Outer.tsx")!;
    // Cross-component import — Outer.tsx imports Inner from sibling.
    expect(outer).toMatch(/import Inner from "\.\/Inner";/);
    expect(outer).toMatch(/<Inner n=\{name\} \/>/);
  });

  it("page with no components emits no components dir", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
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
    const componentFiles = [...files.keys()].filter((k) => k.includes("/components/"));
    // No user-component files emitted (existing scaffold-side
    // src/components/Sidebar.tsx etc don't count — they're at
    // src/components/Sidebar.tsx, not under src/components/<Name>.tsx
    // for a user component).  Check there's no `WelcomeBox`-shaped file.
    expect(componentFiles.find((k) => /WelcomeBox|Foo|Bar/.test(k))).toBeUndefined();
  });

  it("top-level component (declared as a ModelMember) is reachable from every ui", async () => {
    // A bare `component Hero(...)` at the file root — outside any
    // `system { … }` — flows into `LoomModel.components` and the
    // React emitter merges it into the per-ui name→params map.
    // Pages can invoke it by bare name; one `src/components/<Name>.tsx`
    // is emitted per ui that references the component.
    const files = await buildAndGenerate(`
      component Hero(title: string) {
        body: Card { title, Text { "shared library" } }
      }

      system S {
        module M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body: Hero("Welcome")
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
    const hero = files.get("web/src/components/Hero.tsx");
    expect(hero).toBeDefined();
    expect(hero).toMatch(/export interface HeroProps \{\n\s+title: string;\n\}/);
    expect(hero).toMatch(/<Title order=\{3\}>\{title\}<\/Title>/);
    const home = files.get("web/src/pages/home.tsx")!;
    expect(home).toMatch(/import Hero from "\.\.\/components\/Hero";/);
    expect(home).toMatch(/<Hero title="Welcome" \/>/);
  });

  it("slot-typed params accept any walker expression from the caller", async () => {
    // PR B: a `slot`-typed param renders as `ReactNode` in the
    // generated component's Props interface; in the body, a bare ref
    // emits as a JSX expression `{paramName}`.  At call sites, the
    // walker walks the arg expression in the CALLER'S env (so refs
    // like `name` resolve against the page's params, not the
    // component's) and brace-wraps the resulting JSX into the prop
    // slot.
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          component DetailView(heading: slot, primaryAction: slot) {
            body: Stack { heading, primaryAction }
          }
          page Home(name: string) {
            route: "/:name"
            body: DetailView {
              heading: Heading { "Hello " + name, level: 2 },
              primaryAction: Button { "Click " + name }
            }
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
    const dv = files.get("web/src/components/DetailView.tsx")!;
    expect(dv).toBeDefined();
    // ReactNode in scope + slot params typed.
    expect(dv).toMatch(/import type \{ ReactNode \} from "react";/);
    expect(dv).toMatch(
      /export interface DetailViewProps \{\n\s+heading: ReactNode;\n\s+primaryAction: ReactNode;\n\}/,
    );
    // Body: bare slot refs render as JSX expressions.
    expect(dv).toMatch(/\{heading\}/);
    expect(dv).toMatch(/\{primaryAction\}/);

    // Caller side: slot args walked as JSX, brace-wrapped into the prop.
    const home = files.get("web/src/pages/home.tsx")!;
    expect(home).toBeDefined();
    expect(home).toMatch(
      /<DetailView heading=\{[\s\S]*?<Title order=\{2\}>\{\("Hello " \+ name\)\}<\/Title>[\s\S]*?\}/,
    );
    expect(home).toMatch(/primaryAction=\{[\s\S]*?<Button[\s\S]*?Click[\s\S]*?\}/);
  });

  it("ui-scope component overrides a same-named top-level component", async () => {
    // Resolution precedence: a `component X(...)` inside the ui wins
    // over a top-level `component X(...)` declared at the model root.
    // Only the ui-scope body emits.
    const files = await buildAndGenerate(`
      component Hero(title: string) {
        body: Text { "top-level: " + title }
      }

      system S {
        module M { context C { } }
        ui WebApp {
          component Hero(title: string) {
            body: Text { "ui-scope: " + title }
          }
          page Home {
            route: "/"
            body: Hero("World")
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
    const hero = files.get("web/src/components/Hero.tsx")!;
    expect(hero).toMatch(/"ui-scope: "/);
    expect(hero).not.toMatch(/"top-level: "/);
  });
});
