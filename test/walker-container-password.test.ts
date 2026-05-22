// Slice 11.22 — Container + PasswordField primitives.
//
//   Container(...children)            → max-width centred wrapper
//   Container(..., size: "sm")        → constrained max-width
//
//   PasswordField("Password", bind: pwd)
//     → <PasswordInput value={pwd} onChange={...} />
//       (Mantine's toggleable-visibility password input)

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";
import { generateSystems } from "../src/system/index.js";

async function buildAndGenerate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

describe("Slice 11.22 — Container + PasswordField primitives", () => {
  it("Container(...children) emits Mantine <Container> wrapper", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body:  Container(Stack(Heading("Hi"), Text("body")))
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
    expect(content).toMatch(/import \{ Container, Stack, Text, Title \} from "@mantine\/core";/);
    expect(content).toMatch(/<Container>/);
    expect(content).toMatch(/<Stack>/);
    expect(content).toMatch(/<\/Container>/);
  });

  it("Container(size: 'sm') passes the size attr through", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body:  Container(Heading("Compact"), size: "sm")
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
    expect(content).toMatch(/<Container size="sm">/);
  });

  it("empty Container() self-closes", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            body:  Container()
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
    expect(content).toMatch(/<Container \/>/);
  });

  it("PasswordField('Password', bind: pwd) wires controlled PasswordInput", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Login {
            route: "/login"
            state { pwd: string = "" }
            body:  PasswordField("Password", bind: pwd)
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
    const content = files.get("web/src/pages/login.tsx")!;
    expect(content).toMatch(/import \{ PasswordInput \} from "@mantine\/core";/);
    expect(content).toMatch(/const \[pwd, setPwd\] = useState<string>\(""\);/);
    expect(content).toMatch(
      /<PasswordInput label="Password" value=\{pwd\} onChange=\{\(e\) => setPwd\(e\.currentTarget\.value\)\} \/>/,
    );
  });

  it("PasswordField without bind: emits a label-only stub", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page X {
            route: "/x"
            body:  PasswordField("Bare")
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
    expect(content).toMatch(/<PasswordInput label="Bare" \/>/);
    expect(content).not.toMatch(/onChange=/);
  });

  it("Container + PasswordField + Field — full sign-in form composes cleanly", async () => {
    const files = await buildAndGenerate(`
      system S {
        module M { context C { } }
        ui WebApp {
          page Login {
            route: "/login"
            state {
              email: string = ""
              pwd:   string = ""
            }
            body:  Container(
              Stack(
                Heading("Sign in"),
                Field("Email", bind: email),
                PasswordField("Password", bind: pwd),
                Button("Sign in")
              ),
              size: "xs"
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
    const content = files.get("web/src/pages/login.tsx")!;
    // Single import line with everything used.
    expect(content).toMatch(
      /import \{ Button, Container, PasswordInput, Stack, TextInput, Title \} from "@mantine\/core";/,
    );
    expect(content).toMatch(/<Container size="xs">/);
    expect(content).toMatch(/<TextInput label="Email"/);
    expect(content).toMatch(/<PasswordInput label="Password"/);
  });
});
