// Anchor (text-style link) primitive.
//
//   Anchor { "View orders", to: "/orders" }
//     → Mantine <Anchor component={RouterLink} to="/orders">…</Anchor>
//       (`Link as RouterLink` from react-router — aliased so packs
//        whose own primitive is named `Link` don't collide.)
//
// Without `to:` falls through to a bare <Anchor> (no href —
// visible no-op).

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

async function buildAndGenerate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { valslugation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

describe("Anchor primitive", () => {
  it('Anchor { "label", to: "/path" } emits <Anchor component={RouterLink} to=...>', async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body:  Stack {
              Heading { "Welcome" },
              Anchor { "View orders", to: "/orders" }
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
    const content = files.get("web/src/pages/home.tsx")!;
    expect(content).toBeDefined();
    expect(content).toMatch(/import \{ Link as RouterLink \} from "react-router";/);
    expect(content).toMatch(/import \{ Anchor, Stack, Title \} from "@mantine\/core";/);
    expect(content).toMatch(
      /<Anchor component=\{RouterLink\} to="\/orders">\{t\("[^"]*", "View orders"\)\}<\/Anchor>/,
    );
  });

  it("Anchor without to: emits a bare <Anchor> (no RouterLink import)", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Plain {
            route: "/plain"
            body:  Anchor { "Bare link" }
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
    const content = files.get("web/src/pages/plain.tsx")!;
    expect(content).not.toMatch(/react-router/);
    expect(content).toMatch(/<Anchor>\{t\("[^"]*", "Bare link"\)\}<\/Anchor>/);
  });

  it("Anchor with a route-param ref to: binds the param as a JSX expression", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page User(slug: string) {
            route: "/users/:slug"
            body:  Anchor { "Profile", to: slug }
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
    const content = files.get("web/src/pages/user.tsx")!;
    // The destination is an EXPRESSION, so it binds: `to={slug}`.  This used to
    // emit a bare JS template literal (``to=`${slug}` ``) — not valid JSX at all,
    // since an attribute value must be a string literal or a braced expression.
    // Both halves came from `stringOrRefArgValue`, the literal-or-param-ref
    // reader that also DROPPED any computed destination (audit finding A12);
    // the arg now renders through `emitExpr` like every other expression.
    expect(content).toMatch(/<Anchor component=\{RouterLink\} to=\{slug\}>/);
  });

  it("page combining navigate (Button to:) + Link (Anchor to:) imports both specifiers", async () => {
    const files = await buildAndGenerate(`
      system S {
        subdomain M { context C { } }
        ui WebApp {
          page Home {
            route: "/"
            body:  Stack {
              Anchor { "Settings", to: "/settings" },
              Button { "Logout", to: "/logout" }
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
    const content = files.get("web/src/pages/home.tsx")!;
    // Single import line with both useNavigate (for Button) and Link (for Anchor).
    expect(content).toMatch(/import \{ useNavigate, Link as RouterLink \} from "react-router";/);
    expect(content).toMatch(/<Anchor component=\{RouterLink\} to="\/settings">/);
    expect(content).toMatch(/<Button onClick=\{\(\) => navigate\("\/logout"\)\}>/);
  });
});
