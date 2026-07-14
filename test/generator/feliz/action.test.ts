// Feliz `Action { instance.op }` — the one-click operation button (the fieldless
// sibling of OperationForm).  A parameterless public op invoked on a single-record
// QueryView instance dispatches a trigger Msg carrying the route id → a
// `POST /<id>/<op>` (empty body) → a Done result that refetches the detail.  Under
// `auth: ui`, a currentUser-only op `requires` hides the button via the decoded
// claims (the action-level mirror of the page gate).  Proven to Fable-compile
// (SDK 8.0) plain and gated.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const DETAIL = (opBody: string, auth = "") => `
system Storefront {
  ${auth ? "user { id: string  role: string }" : ""}
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product {
        name: string
        active: bool
        operation activate() { ${opBody} active := true }
      }
      repository Products for Product { }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp {
    api Shop: ShopApi
    page Home { route: "/"  body: Heading { "Home", level: 1 } }
    page ProductDetail {
      route: "/products/:id"
      body: QueryView {
        of: Shop.Product.byId(id), single: true,
        loading: Text { "…" }, error: Text { "err" }, empty: Text { "none" },
        data: p => Stack { Heading { p.name, level: 1 }, Action { p.activate } }
      }
    }
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 ${auth ? "auth: required" : ""} }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 ${auth ? "auth: ui" : ""} }
}
`;

async function appFs(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz Action(x.op)", () => {
  it("wires a one-click op as trigger/done Msg + POST + refetch", async () => {
    const app = await appFs(DETAIL(""));
    // No leftover React syntax (the shared emitAction path).
    expect(app).not.toContain("mutateAsync");
    // Msg pair.
    expect(app).toContain("  | ActivateProduct of string");
    expect(app).toContain("  | ActivateProductDone of Result<unit, string>");
    // update: trigger fires the id-qualified POST; Done refetches the detail.
    expect(app).toContain(
      "  | ActivateProduct id -> model, Cmd.OfAsync.perform Api.activateProduct id ActivateProductDone",
    );
    expect(app).toContain("  | ActivateProductDone (Ok ()) -> model, pageCmd model.CurrentPage");
    expect(app).toContain("  | ActivateProductDone (Error _) -> model, Cmd.none");
    // Api: empty-body POST to /<id>/<op> → unit.
    expect(app).toContain("let activateProduct (id: string) : Async<Result<unit, string>> =");
    expect(app).toContain('Http.request (sprintf "/api/products/%s/activate" id)');
    expect(app).toContain('Http.content (BodyContent.Text "{}")');
    // view: a plain dispatching button (ungated).
    expect(app).toContain(
      'Html.button [ prop.onClick (fun _ -> dispatch (ActivateProduct id)); prop.text "Activate" ]',
    );
  });

  it("gates the button on a currentUser-only op requires (auth: ui)", async () => {
    const app = await appFs(DETAIL('requires currentUser.role == "admin"', "auth"));
    // The gated action alone (no page `requires`) pulls in the claims machinery.
    expect(app).toContain("type CurrentUser =");
    expect(app).toContain("let currentUserDecoder : Decoder<CurrentUser> =");
    expect(app).toContain("    CurrentUser: CurrentUser option");
    // The button is wrapped in a one-line claims match; no session → hidden.
    expect(app).toContain(
      '(match model.CurrentUser with Some currentUser when (currentUser.Role = "admin") -> Html.button [ prop.onClick (fun _ -> dispatch (ActivateProduct id)); prop.text "Activate" ] | _ -> Html.none)',
    );
  });

  it("emits a comment (not broken F#) for a param-carrying op", async () => {
    // An op WITH a parameter is an OperationForm, not an Action — the seam
    // refuses it with a comment rather than emitting a dangling trigger Msg.
    const src = `
system S {
  api A from Sub
  subdomain Sub { context C {
    aggregate Product { name: string  active: bool  operation bump(by: int) { active := true } }
    repository Products for Product { }
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui W { api Shop: A
    page Home { route: "/"  body: Heading { "H", level: 1 } }
    page D { route: "/products/:id"
      body: QueryView { of: Shop.Product.byId(id), single: true,
        loading: Text { "x" }, error: Text { "x" }, empty: Text { "x" },
        data: p => Action { p.bump } } } }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: feliz targets: api ui: W { Shop: api } port: 3005 }
}`;
    const app = await appFs(src);
    expect(app).not.toContain("mutateAsync");
    expect(app).toContain("Action(p.bump): no parameterless public operation in scope");
  });

  it("validates cleanly through validateLoomModel", async () => {
    const { errors } = await parseString(DETAIL(""), { validate: true });
    expect(errors).toEqual([]);
  });
});
