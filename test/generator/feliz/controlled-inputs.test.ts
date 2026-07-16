// Feliz controlled input primitives — Field / NumberField / PasswordField /
// MultilineField / SelectField / Toggle (via `bind:`) and the state-controlled
// Modal (via `open:`).  Each two-way-binds a page `state` field: the pack reads
// `model.<Field>` and dispatches a `Set<Field>` Msg the MVU projection emits.
// Previously these dispatched to the pack with no renderer (a `(* no renderer *)`
// comment that breaks `dotnet fable`).  The emitted F# is proven to compile via
// `dotnet fable` + `vite build` AND to two-way-bind at runtime via a Playwright
// smoke (Field/Toggle/Select + Modal open/close).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const APP = `
system Forms {
  subdomain S { context C { } }
  ui WebApp {
    framework: feliz
    page Editor {
      route: "/"
      state {
        name: string = ""
        qty: int = 0
        price: money = 0
        bio: string = ""
        secret: string = ""
        color: string = "red"
        active: bool = false
        showDlg: bool = false
      }
      action openDlg() { showDlg := true }
      body: Stack {
        Field { "Name", bind: name },
        NumberField { "Qty", bind: qty },
        NumberField { "Price", bind: price },
        MultilineField { "Bio", bind: bio },
        PasswordField { "Secret", bind: secret },
        SelectField { "Color", bind: color, options: ["red", "green", "blue"] },
        Toggle { "Active", bind: active },
        Button { "Open dialog", onClick: openDlg },
        Modal { open: showDlg, title: "Confirm", Text { "Modal body" } }
      }
    }
  }
  deployable api { platform: node contexts: [C] port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
}
`;

async function appFs(): Promise<string> {
  const files = await generateSystemFiles(APP);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz controlled input primitives", () => {
  it("renders every input — no `no renderer` placeholders leak", async () => {
    const app = await appFs();
    expect(app).not.toContain("no renderer");
  });

  it("projects a Set<Field> Msg per two-way-bound state field", async () => {
    const app = await appFs();
    // String state → `of string`; bool state (Toggle / Modal open) → `of bool`.
    expect(app).toContain("| SetName of string");
    expect(app).toContain("| SetQty of string"); // number carries the raw string
    expect(app).toContain("| SetPrice of string");
    expect(app).toContain("| SetActive of bool");
    expect(app).toContain("| SetShowDlg of bool");
  });

  it("emits an update arm per Set<Field>, converting number strings safely", async () => {
    const app = await appFs();
    expect(app).toContain("| SetName v -> { model with Name = v }, Cmd.none");
    expect(app).toContain(
      "| SetQty v -> { model with Qty = (match System.Int32.TryParse v with | true, n -> n | _ -> 0) }, Cmd.none",
    );
    expect(app).toContain(
      "| SetPrice v -> { model with Price = (match System.Decimal.TryParse v with | true, n -> n | _ -> 0m) }, Cmd.none",
    );
    expect(app).toContain("| SetActive v -> { model with Active = v }, Cmd.none");
  });

  it("a `money = 0` init coerces to a decimal literal (Fable rejects int→decimal)", async () => {
    const app = await appFs();
    expect(app).toContain("Price = 0m");
  });

  it("Field / NumberField / Multiline / Password bind model.<Field> + dispatch Set<Field>", async () => {
    const app = await appFs();
    expect(app).toContain(
      'Html.input [ prop.className "input input-bordered w-full"; prop.value model.Name; prop.onChange (fun (v: string) -> dispatch (SetName v)) ]',
    );
    // Number field stringifies the (int/decimal) value for display.
    expect(app).toContain(
      "prop.type'.number; prop.value (string model.Qty); prop.onChange (fun (v: string) -> dispatch (SetQty v))",
    );
    expect(app).toContain(
      'Html.textarea [ prop.className "textarea textarea-bordered w-full"; prop.value model.Bio;',
    );
    expect(app).toContain("prop.type'.password; prop.value model.Secret;");
  });

  it("SelectField maps its options via Seq.map (list-or-array tolerant)", async () => {
    const app = await appFs();
    expect(app).toContain(
      'Html.select [ prop.className "select select-bordered w-full"; prop.value model.Color;',
    );
    expect(app).toContain(
      'yield! ([ "red"; "green"; "blue" ]) |> Seq.map (fun o -> Html.option [ prop.value o; prop.text o ])',
    );
  });

  it("Toggle is a controlled daisyUI checkbox (isChecked + bool dispatch)", async () => {
    const app = await appFs();
    expect(app).toContain(
      'Html.input [ prop.className "toggle"; prop.type\'.checkbox; prop.isChecked model.Active; prop.onChange (fun (v: bool) -> dispatch (SetActive v)) ]',
    );
  });

  it("a state-controlled Modal toggles modal-open off its bool state + Set<Field> false on Close", async () => {
    const app = await appFs();
    expect(app).toContain('prop.className (if model.ShowDlg then "modal modal-open" else "modal")');
    expect(app).toContain('Html.div [ prop.className "modal-box"');
    expect(app).toContain('prop.onClick (fun _ -> dispatch (SetShowDlg false)); prop.text "Close"');
  });
});
