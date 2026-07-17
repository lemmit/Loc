// Feliz param-less operations (`confirm()`) — an operation with no parameters
// still scaffolds a Modal(OperationForm), so it must wire a trigger + submit +
// empty-`{}` POST even though there is NO form record.  Before this, param-less
// ops were dropped (`collectPageOperationForms` skipped no-field ops), so the
// scaffold `confirm` Modal fell through to an inert labelled button — the shared
// op page-object (`click trigger → click submit → wait form-detach`) could never
// drive it.  This pins the empty-form op end-to-end (view + Msg + update + Api).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// A scaffolded Order aggregate with a PARAM-LESS `confirm()` op (and a param-
// carrying `addLine` for contrast).
const SYS = `
system Shop {
  api ShopApi from Sales
  subdomain Sales {
    context Sales {
      aggregate Order with crudish {
        status: string
        function isMutable(): bool = true
        operation confirm() { precondition isMutable()  status := "Confirmed" }
      }
      repository Orders for Order { }
    }
  }
  ui WebApp with scaffold(subdomains: [Sales]) { api Shop: ShopApi }
  storage db { type: postgres }
  resource st { for: Sales, kind: state, use: db }
  deployable api { platform: node contexts: [Sales] dataSources: [st] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}
`;

async function appFs(): Promise<string> {
  const files = await generateSystemFiles(SYS);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz param-less operation forms", () => {
  it("renders the trigger + form container + submit (no inputs)", async () => {
    const app = await appFs();
    // The Modal `<summary>` trigger the op page-object clicks first.
    expect(app).toContain('prop.custom("data-testid", "orders-op-confirm")');
    // The form container it waits for, then the submit it clicks.
    expect(app).toContain('prop.custom("data-testid", "orders-op-confirm-form")');
    expect(app).toContain('prop.custom("data-testid", "orders-op-confirm-submit")');
    // The submit dispatches the id-carrying op Msg.
    expect(app).toContain("prop.onClick (fun _ -> dispatch (SubmitConfirmOrderForm id))");
  });

  it("wires a Submit(id) + Done Msg but NO form record / setters", async () => {
    const app = await appFs();
    expect(app).toContain("| SubmitConfirmOrderForm of string");
    expect(app).toContain("| ConfirmOrderDone of Result<unit, string>");
    // A param-less op has no form state — no record type, no Model field, no setters.
    expect(app).not.toContain("type ConfirmOrderForm =");
    expect(app).not.toContain("ConfirmOrderForm: ConfirmOrderForm");
    expect(app).not.toContain("SetConfirmOrderForm");
  });

  it("emits an id-qualified Api fn that POSTs an empty `{}` body", async () => {
    const app = await appFs();
    expect(app).toContain("let confirmOrder (id: string) () : Async<Result<unit, string>> =");
    expect(app).toContain('let body = "{}"');
    expect(app).toContain('Http.request (sprintf "/api/orders/%s/confirm" id)');
  });

  it("wires the update arm — submit posts `()`, done navigates (no form reset)", async () => {
    const app = await appFs();
    expect(app).toContain(
      "  | SubmitConfirmOrderForm id -> model, Cmd.OfAsync.perform (Api.confirmOrder id) () ConfirmOrderDone",
    );
    expect(app).toContain('  | ConfirmOrderDone (Ok ()) -> model, Cmd.navigatePath("orders")');
    expect(app).toContain("  | ConfirmOrderDone (Error _) -> model, Cmd.none");
  });
});
