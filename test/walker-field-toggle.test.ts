// Slice 11.14 — Field + Toggle with `bind:` two-way state binding.
// Closes the interactive-page loop in the walker stdlib: read
// state via Text, mutate state via Button, BIND state via
// Field / Toggle.
//
//   state {
//     name:   string = ""
//     active: bool   = false
//   }
//   body: Stack(
//     Field("Your name",  bind: name),
//     Toggle("Active",    bind: active),
//     Button("Submit",    onClick: e => { … })
//   )
//
//     →
//
//   <TextInput label="Your name"
//              value={name}
//              onChange={(e) => setName(e.currentTarget.value)} />
//   <Switch    label="Active"
//              checked={active}
//              onChange={(e) => setActive(e.currentTarget.checked)} />

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { generateSystems } from "../src/system/index.js";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";

async function buildAndGenerate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

describe("Slice 11.14 — Field + Toggle with bind: state binding", () => {
  it("Field('Label', bind: name) wires controlled TextInput to state", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Form {
            route: "/form"
            state { name: string = "" }
            body:  Field("Your name", bind: name)
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
    const content = files.get("web/src/pages/form.tsx")!;
    expect(content).toBeDefined();
    expect(content).toMatch(/import \{ TextInput \} from "@mantine\/core";/);
    // useState declaration emitted (bind: triggered usesState).
    expect(content).toMatch(
      /const \[name, setName\] = useState<string>\(""\);/,
    );
    expect(content).toMatch(
      /<TextInput label="Your name" value=\{name\} onChange=\{\(e\) => setName\(e\.currentTarget\.value\)\} \/>/,
    );
  });

  it("Toggle('Label', bind: active) wires controlled Switch to bool state", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Pref {
            route: "/pref"
            state { active: bool = false }
            body:  Toggle("Active", bind: active)
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
    const content = files.get("web/src/pages/pref.tsx")!;
    expect(content).toMatch(/import \{ Switch \} from "@mantine\/core";/);
    expect(content).toMatch(
      /const \[active, setActive\] = useState<boolean>\(false\);/,
    );
    expect(content).toMatch(
      /<Switch label="Active" checked=\{active\} onChange=\{\(e\) => setActive\(e\.currentTarget\.checked\)\} \/>/,
    );
  });

  it("complete interactive form: state + Field + Toggle + Button + Text", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Profile {
            route: "/profile"
            state {
              name:    string = ""
              welcome: bool   = false
            }
            body: Stack(
              Heading("Profile"),
              Field("Your name", bind: name),
              Toggle("Show welcome", bind: welcome),
              Text("Hello, " + name),
              Button("Reset", onClick: e => { name := "" })
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
    const content = files.get("web/src/pages/profile.tsx")!;
    // All hooks deduped on a single React import line.
    expect(content).toMatch(/import \{ useState \} from "react";/);
    // All 4 useState declarations emitted.
    expect(content).toMatch(/const \[name, setName\]/);
    expect(content).toMatch(/const \[welcome, setWelcome\]/);
    // Both controlled inputs wired.
    expect(content).toMatch(/<TextInput .+ value=\{name\}/);
    expect(content).toMatch(/<Switch .+ checked=\{welcome\}/);
    // Text interpolation reads `name` via JSX expr.
    expect(content).toMatch(/<Text>\{\("Hello, " \+ name\)\}<\/Text>/);
    // Button onClick :=  resets name.
    expect(content).toMatch(/setName\(""\);/);
  });

  it("Field without bind: emits an uncontrolled label-only stub", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            body:  Field("Bare")
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
    // No controlled-input wiring — just label.
    expect(content).toMatch(/<TextInput label="Bare" \/>/);
    expect(content).not.toMatch(/onChange=/);
    expect(content).not.toMatch(/useState/);
  });

  it("Field label accepts a binary-op (state interpolation in label)", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            state {
              kind: string = "Name"
              v:    string = ""
            }
            body:  Field(kind + ":", bind: v)
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
    // Label slot accepts binary op as JSX expr.
    expect(content).toMatch(
      /<TextInput label=\{\(kind \+ ":"\)\} value=\{v\}/,
    );
  });
});
