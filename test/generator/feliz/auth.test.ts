// Feliz auth gate (D-AUTH-OIDC) — when the target backend is `auth: required`
// and this ui opts in with `auth: ui` (+ a system `user {}` block), the app is
// wrapped in an MVU session gate: a `SessionState` field, an `Auth` module that
// probes `/api/auth/me` + redirects to the backend's sign-in/out, and a root
// `view` that shows a spinner → sign-in prompt → the real `appView`.  Proven to
// compile + run via `dotnet fable` (SDK:8.0) + vite build + headless smoke.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const AUTH = `
system Secure {
  user { id: string  role: string }
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product with crudish { name: string  price: money }
      repository Products for Product { }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp {
    api Shop: ShopApi
    page Products {
      route: "/products"
      body: QueryView {
        of: Shop.Product.all,
        loading: Text { "…" }, error: Text { "!" }, empty: Text { "0" },
        data: rows => Stack { For { each: rows, p => Card { p.name } } }
      }
    }
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 auth: required }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 auth: ui }
}
`;

// Same system WITHOUT auth on the deployables — the gate must NOT appear.
const NO_AUTH = AUTH.replace(" auth: required", "").replace(" auth: ui", "");

async function appFs(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}
async function fsproj(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("App.fsproj"))![1];
}

describe("feliz auth gate", () => {
  it("emits the SessionState type + Auth probe/redirect module", async () => {
    const app = await appFs(AUTH);
    expect(app).toContain("type SessionState =\n  | Checking\n  | Authed\n  | Anon");
    expect(app).toContain("open Browser.Dom");
    expect(app).toContain('let! (status, _) = Http.get "/api/auth/me"');
    expect(app).toContain('let signIn () : unit = window.location.href <- "/api/auth/login"');
    expect(app).toContain('let signOut () : unit = window.location.href <- "/api/auth/logout"');
  });

  it("wires Session into the Model / init / Msg / update", async () => {
    const app = await appFs(AUTH);
    expect(app).toContain("Session: SessionState");
    expect(app).toContain("Session = Checking");
    expect(app).toContain("Cmd.OfAsync.perform Auth.checkSession () SessionChecked");
    expect(app).toContain("| SessionChecked of bool");
    expect(app).toContain("| SessionChecked true -> { model with Session = Authed }, Cmd.none");
    expect(app).toContain("| SessionChecked false -> { model with Session = Anon }, Cmd.none");
  });

  it("renames the root view to appView + emits the gate view", async () => {
    const app = await appFs(AUTH);
    expect(app).toContain("let appView (model: Model) (dispatch: Msg -> unit) =");
    expect(app).toContain(
      "let view (model: Model) (dispatch: Msg -> unit) =\n  match model.Session with",
    );
    expect(app).toContain('| Checking -> Html.p [ Html.text "Loading…" ]');
    expect(app).toContain("| Authed -> appView model dispatch");
    // The sign-in prompt dispatches the redirect.
    expect(app).toContain('prop.onClick (fun _ -> Auth.signIn ()); prop.text "Sign in"');
    // Program still runs the (gate) `view`.
    expect(app).toContain("Program.mkProgram init update view");
  });

  it("refs Fable.Browser.Dom in the fsproj", async () => {
    const proj = await fsproj(AUTH);
    expect(proj).toContain('Include="Fable.Browser.Dom"');
  });

  // Without `auth: required` + `auth: ui`, the gate is absent (byte-additive).
  it("a non-auth ui emits no gate", async () => {
    const app = await appFs(NO_AUTH);
    expect(app).not.toContain("SessionState");
    expect(app).not.toContain("module Auth");
    expect(app).not.toContain("appView");
    expect(app).not.toContain("open Browser.Dom");
  });

  it("validates cleanly through validateLoomModel", async () => {
    const { errors } = await parseString(AUTH, { validate: true });
    expect(errors).toEqual([]);
  });
});
