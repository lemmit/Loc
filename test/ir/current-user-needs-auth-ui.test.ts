// `loom.current-user-needs-auth-ui` — a page/component that reads
// `currentUser` on a deployable that binds no verified session.
//
// `currentUser` in a page body is the SESSION user, and the only thing that
// materialises one is the auth guard: `auth: ui` on a frontend deployable
// (React's `const currentUser = useSession().user` and its Vue/Svelte/Angular/
// Feliz twins) or `auth: required` on a fullstack deployable that mounts the ui
// itself (Phoenix `LiveAuth.on_mount` assigns `@current_user`).  Without one,
// nothing downstream re-checks the read: react emits `currentUser.email`
// against no binding, flutter invalid Dart, feliz a `CurrentUser` match on a
// Model with no such field.  The model compiled clean and the claim read was
// garbage at runtime — this gate makes it a compile error.
//
// The positive control matters as much as the negative one: the SAME model
// with `auth: ui` added must stay clean, or the gate is just noise.
//
// A read inside a COMPONENT is covered too, and is the reason this file grew a
// third `where`: a component renders INTO a page, so the read is exactly as
// dangling, but `lowerComponent` used to thread `user: undefined` where
// `lowerPage` threads the system's user block — so the component's
// `currentUser` lowered to an unresolved ref and never reached this gate
// (audit finding A9).  The lowering threads it now; these cases pin that.
//
// NOT covered here: a missing `user { … }` block.  Without one the token never
// resolves to a principal at all, and `loom.auth-no-user-block` already names it.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function currentUserErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.current-user-needs-auth-ui")
    .map((d) => d.message);
}

/** `where` places the `currentUser.email` read; `auth` is the frontend
 *  deployable's auth clause (`` = none). */
function sys(opts: { where: "page" | "action" | "component"; auth?: string }): string {
  const user = "user { id: string email: string }";
  const auth = opts.auth ? opts.auth : "";
  const read = "Text(`hello ${currentUser.email}`)";
  const uiBody =
    opts.where === "page"
      ? `page X { route: "/x"  body: Stack { ${read} } }`
      : opts.where === "component"
        ? `component Greeting() { body: Stack { ${read} } }
           page X { route: "/x" body: Stack { Greeting() } }`
        : `page X {
             route: "/x"
             state { greeting: string = "" }
             action greet() { greeting := currentUser.email }
           body: Stack { Button("greet", onClick: greet) }
         }`;
  return `
system S {
  ${user}
  auth { provider: keycloak oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") } }
  subdomain Sales {
    context Orders {
      aggregate Customer { name: string }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  ui WebApp {
    framework: react
    api Sales: SalesApi
    ${uiBody}
  }
  deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000, auth: required }
  deployable web { platform: static, targets: api, port: 3001, ui: WebApp { Sales: api } ${auth} }
}
`;
}

describe("loom.current-user-needs-auth-ui", () => {
  for (const where of ["page", "action", "component"] as const) {
    it(`rejects a currentUser read in a ${where} with no auth guard`, async () => {
      const errs = await currentUserErrors(sys({ where }));
      expect(errs.length, `expected the gate to fire for a ${where} read`).toBe(1);
      if (where === "component") expect(errs[0]).toContain("component 'Greeting'");
      expect(errs[0]).toContain("'web'");
      expect(errs[0]).toContain("currentUser");
      // The message must name the fix, not just the symptom.
      expect(errs[0]).toContain("auth: ui");
    });

    // Positive control — the same model, guard added, must be silent.
    it(`accepts the same ${where} read once the deployable declares auth: ui`, async () => {
      expect(await currentUserErrors(sys({ where, auth: "auth: ui" }))).toEqual([]);
    });
  }

  it("stays silent on a ui with no currentUser read at all", async () => {
    const clean = sys({ where: "page" }).replace(
      "Text(`hello ${currentUser.email}`)",
      'Text("hello")',
    );
    expect(await currentUserErrors(clean)).toEqual([]);
  });
});
