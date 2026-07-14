// Feliz UI authorization gate (D-AUTH-OIDC) — a page `requires <currentUser gate>`
// decodes the verified session claims into a typed `CurrentUser` record and
// wraps the gated page view in a `Some currentUser when <gate> -> … | _ ->
// forbiddenView` guard (the client mirror of the backend 403).  The F# sibling
// of the shared `gate-expr.ts` renderer the JSX frontends reuse.  Proven to
// Fable-compile (SDK:8.0) for string-eq, `<>`, and `List.contains` shapes.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const BASE = (uiPages: string) => `
system Storefront {
  user { id: string  role: string  permissions: string[] }
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product { name: string  price: money }
      repository Products for Product { }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp {
    api Shop: ShopApi
${uiPages}
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 auth: required }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 auth: ui }
}
`;

const GATED = BASE(`    page Home { route: "/"  body: Heading { "Home", level: 1 } }
    page Admin {
      route: "/admin"
      requires currentUser.role == "admin"
      body: Heading { "Admin only", level: 1 }
    }`);

// An `auth: ui` app with NO page `requires` — must stay on the status-only
// boolean probe (byte-identical to the pre-gate auth session gate).
const NO_GATE = BASE(`    page Home { route: "/"  body: Heading { "Home", level: 1 } }
    page About { route: "/about"  body: Heading { "About", level: 1 } }`);

async function appFs(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz UI auth gate", () => {
  it("decodes session claims into a typed CurrentUser record + decoder", async () => {
    const app = await appFs(GATED);
    expect(app).toContain("type CurrentUser =");
    expect(app).toContain("    Role: string");
    expect(app).toContain("    Permissions: string list");
    expect(app).toContain("let currentUserDecoder : Decoder<CurrentUser> =");
    expect(app).toContain('Role = get.Required.Field "role" Decode.string');
    expect(app).toContain(
      'Permissions = get.Required.Field "permissions" (Decode.list Decode.string)',
    );
  });

  it("upgrades the probe to a claims decode carried on the Model", async () => {
    const app = await appFs(GATED);
    expect(app).toContain("let checkSession () : Async<CurrentUser option> =");
    expect(app).toContain("match Decode.fromString currentUserDecoder body with");
    expect(app).toContain("    CurrentUser: CurrentUser option");
    expect(app).toContain("  | SessionChecked of CurrentUser option");
    // The probe stashes the decoded claims on Authed, drops to Anon otherwise.
    expect(app).toContain("| SessionChecked (Some user) ->");
    expect(app).toContain("{ model with Session = Authed; CurrentUser = Some user }, Cmd.none");
    expect(app).toContain("| SessionChecked None -> { model with Session = Anon }, Cmd.none");
    // Init seeds the claim slot empty.
    expect(app).toContain("CurrentUser = None");
  });

  it("wraps the gated page view in a claims guard with a forbiddenView fallback", async () => {
    const app = await appFs(GATED);
    expect(app).toContain("let forbiddenView =");
    expect(app).toContain('Html.h2 [ prop.className "font-bold"; prop.text "Forbidden" ]');
    // The gate is F#-rendered: `==` → `=`, claim access → pascal record field.
    expect(app).toContain("let adminView (model: Model) (dispatch: Msg -> unit) =");
    expect(app).toContain("    match model.CurrentUser with");
    expect(app).toContain('    | Some currentUser when currentUser.Role = "admin" ->');
    expect(app).toContain("    | _ -> forbiddenView");
    // The ungated page stays plain (no guard leaks onto it).
    expect(app).toMatch(/let homeView \(model: Model\) \(dispatch: Msg -> unit\) =\n {4}Html\.h1/);
  });

  it("renders membership + inequality gates in F# syntax", async () => {
    const app = await appFs(
      BASE(`    page Home { route: "/"  body: Heading { "Home", level: 1 } }
    page Ops {
      route: "/ops"
      requires currentUser.permissions.contains("ops") && currentUser.role != "guest"
      body: Heading { "Ops", level: 1 }
    }`),
    );
    // `.contains` → F# membership (item-first); `!=` → `<>`.
    expect(app).toContain('(List.contains "ops" currentUser.Permissions)');
    expect(app).toContain('currentUser.Role <> "guest"');
  });

  it("leaves a gate-free auth app on the status-only boolean probe", async () => {
    const app = await appFs(NO_GATE);
    expect(app).toContain("let checkSession () : Async<bool> =");
    expect(app).toContain("  | SessionChecked of bool");
    expect(app).toContain("| SessionChecked true -> { model with Session = Authed }, Cmd.none");
    // None of the claims-decode machinery leaks into a gate-free app.
    expect(app).not.toContain("CurrentUser");
    expect(app).not.toContain("forbiddenView");
    expect(app).not.toContain("currentUserDecoder");
  });

  it("validates cleanly through validateLoomModel", async () => {
    const { errors } = await parseString(GATED, { validate: true });
    expect(errors).toEqual([]);
  });
});
