// User-defined components.  ComponentIR finally has
// output: each `component <Name>(p: T) { body: ... }` declaration
// emits as `src/components/<Name>.tsx` with a typed Props
// interface, and walker pages can invoke them as JSX elements
// (`<WelcomeBox name="Alice" />`).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const buildAndGenerate = generateSystemFiles;

describe("user-defined components", () => {
  it("component declaration emits a tsx file with typed Props", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          component WelcomeBox(name: string) {
            body: Card { "Hello, " + name, Stack { Text { "Welcome!" } } }
          }
          page Home {
            route: "/"
            body:  Heading { "home" }
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
        subdomain M { context C { } }
        ui WebApp {
          component WelcomeBox(name: string) {
            body: Card { "Hi, " + name, Text { "welcome" } }
          }
          page Home {
            route: "/"
            body:  WelcomeBox("Alice")
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
    const content = files.get("web/src/pages/home.tsx")!;
    // Page imports the user component from ../components.
    expect(content).toMatch(/import WelcomeBox from "\.\.\/components\/WelcomeBox";/);
    // JSX invocation maps positional arg → param name as prop.
    expect(content).toMatch(/<WelcomeBox name="Alice" \/>/);
  });

  it("user component invocation with a non-string arg renders as JSX expression", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
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
        deployable api { platform: node, contexts: [C], port: 3000 }
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
        subdomain M { context C { } }
        ui WebApp {
          component LabeledIcon(icon: string, label: string) {
            body: Stack { Text { icon }, Text { label } }
          }
          page Home {
            route: "/"
            body:  LabeledIcon(icon: "star", label: "Featured")
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
    const content = files.get("web/src/pages/home.tsx")!;
    // Named args use their declared names verbatim.
    expect(content).toMatch(/<LabeledIcon icon="star" label="Featured" \/>/);
  });

  it("multiple user components dedupe imports per page", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
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
        deployable api { platform: node, contexts: [C], port: 3000 }
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
        subdomain M { context C { } }
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
        deployable api { platform: node, contexts: [C], port: 3000 }
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
        subdomain M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body:  Heading { "hi" }
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
        subdomain M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body: Hero("Welcome")
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
        subdomain M { context C { } }
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
        deployable api { platform: node, contexts: [C], port: 3000 }
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

  it("`slot?` (optional) emits an optional Props field and admits omission at the call site", async () => {
    // `slot?` lowers to `{kind: "optional", inner: {kind: "slot"}}`.
    // The Props interface should mark the field optional (`heading?:`)
    // so a caller can leave it off; the type is still `ReactNode`.
    // Named `Panel` rather than `Card` because `Card` collides with
    // the stdlib walker primitive.
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          component Panel(heading: slot?, body: slot) {
            body: Stack { heading, body }
          }
          page Home {
            route: "/"
            body: Panel { body: Text { "no heading provided" } }
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
    const panel = files.get("web/src/components/Panel.tsx")!;
    expect(panel).toBeDefined();
    // Optional slot → `heading?: ReactNode`; required slot stays `body: ReactNode`.
    expect(panel).toMatch(
      /export interface PanelProps \{\n\s+heading\?: ReactNode;\n\s+body: ReactNode;\n\}/,
    );
    // Caller can omit the optional slot.
    const home = files.get("web/src/pages/home.tsx")!;
    expect(home).toMatch(/<Panel body=\{[\s\S]*?<Text>no heading provided<\/Text>[\s\S]*?\} \/>/);
    // The optional slot was NOT passed — should not appear as a prop attr.
    expect(home).not.toMatch(/<Panel[^>]*heading=/);
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
        subdomain M { context C { } }
        ui WebApp {
          component Hero(title: string) {
            body: Text { "ui-scope: " + title }
          }
          page Home {
            route: "/"
            body: Hero("World")
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
    const hero = files.get("web/src/components/Hero.tsx")!;
    expect(hero).toMatch(/"ui-scope: "/);
    expect(hero).not.toMatch(/"top-level: "/);
  });

  it("a named layout's slot can invoke a top-level component", async () => {
    // Layout slots are walked at App.tsx-emit time (via `walkSlot` in
    // layouts-emitter), which previously didn't see workspace-wide
    // components.  After the fix, a `layout LandingFrame { header:
    // Logo {} }` resolves `Logo` to the top-level component, emits the
    // matching `<Logo />` inside `LandingFrameLayout`, and threads the
    // `import Logo from "./components/Logo"` into App.tsx.
    const files = await buildAndGenerate(`
      component Logo() {
        body: Heading { "Loom", level: 3 }
      }

      system S {
        subdomain M { context C { } }
        layout LandingFrame {
          header { Logo() }
          main
        }
        ui WebApp {
          page Home {
            route: "/"
            layout: LandingFrame
            body: Heading { "Hi", level: 1 }
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
    const app = files.get("web/src/App.tsx")!;
    expect(app).toBeDefined();
    // Logo imported from ./components in App.tsx.
    expect(app).toMatch(/import Logo from "\.\/components\/Logo";/);
    // LandingFrameLayout wrapper renders <Logo /> in its header slot.
    expect(app).toMatch(/function LandingFrameLayout\(\)/);
    expect(app).toMatch(/<Logo \/>/);
    // a11y: the header slot is a <header> landmark and the Outlet lives in a
    // <main id="main-content"> landmark (named layouts otherwise had no
    // landmarks at all — the default AppShellLayout gets them from AppShell.*).
    expect(app).toMatch(/<header><Logo \/><\/header>/);
    expect(app).toMatch(/<main id="main-content">\s*<AppErrorBoundary>/);
    // The component file itself is emitted exactly once.
    expect(files.get("web/src/components/Logo.tsx")).toBeDefined();
  });

  it("a named layout's footer slot is wrapped in a <footer> landmark", async () => {
    const files = await buildAndGenerate(`
      component SiteFooter() {
        body: Text { "© Loom" }
      }

      system S {
        subdomain M { context C { } }
        layout LandingFrame {
          main
          footer { SiteFooter() }
        }
        ui WebApp {
          page Home {
            route: "/"
            layout: LandingFrame
            body: Heading { "Hi", level: 1 }
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
    const app = files.get("web/src/App.tsx")!;
    expect(app).toBeDefined();
    // The footer slot renders inside a <footer> (contentinfo) landmark.
    expect(app).toMatch(/<footer><SiteFooter \/><\/footer>/);
  });
});
