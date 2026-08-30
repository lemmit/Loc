// Feliz param-less workflow forms — a `WorkflowForm(runs: <wf>)` over a workflow
// with NO parameters.  There is nothing to fill in, but there is still something
// to RUN, so the form is a submit-only button (the same shape Flutter emits, and
// the same shape feliz already emits for a param-less `operation confirm()`).
//
// Before this, `renderWorkflowForm` returned null for a field-less form, which
// handed the primitive to the shared `emitFormRuns` fallback → the
// `primitive-form-of` pack id → a feliz pack with no renderer for it → the whole
// `WorkflowForm` collapsed into a `(* feliz pack: no renderer … *)` comment.  A
// SILENT drop: the page compiled, the workflow was simply unreachable from the
// UI.  This pins the submit-only form end-to-end (view + Msg + update + Api).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

// `closeBooks` is a `create()` starter with NO parameters — nothing to fill in.
const SYS = `
system Bank {
  api BankApi from Core
  subdomain Core {
    context Acc {
      aggregate Account with crudish { name: string  balance: money }
      repository Accounts for Account { }
      workflow closeBooks transactional {
        create() {
          let a = Account.create(name: "closing", balance: 0)
        }
      }
    }
  }
  storage db { type: postgres }
  resource accState { for: Acc, kind: state, use: db }
  ui WebApp {
    api Bank: BankApi
    page Close {
      route: "/close"
      body: Stack {
        Heading { "Close the books", level: 1 },
        WorkflowForm { runs: closeBooks }
      }
    }
  }
  deployable api { platform: node contexts: [Acc] dataSources: [accState] serves: BankApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Bank: api } port: 3005 }
}
`;

async function appFs(): Promise<string> {
  const files = await generateSystemFiles(SYS);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz param-less workflow forms", () => {
  it("renders the form container + a submit dispatching the run Msg (no inputs)", async () => {
    const app = await appFs();
    expect(app).toContain('prop.custom("data-testid", "workflow-close_books")');
    expect(app).toContain('prop.custom("data-testid", "workflow-close_books-submit")');
    // No validity guard (no required fields to guard) — just the dispatch.
    expect(app).toContain(
      'Html.button [ prop.custom("data-testid", "workflow-close_books-submit"); prop.className "btn btn-primary"; prop.onClick (fun _ -> dispatch SubmitCloseBooksForm); prop.text "Run CloseBooks" ]',
    );
  });

  it("does not fall through to the unrendered `primitive-form-of` pack id", async () => {
    const app = await appFs();
    expect(app).not.toContain("primitive-form-of");
    expect(app).not.toContain("no renderer for");
  });

  it("wires a paramless Submit + Done Msg but NO form record / setters", async () => {
    const app = await appFs();
    expect(app).toContain("| SubmitCloseBooksForm\n"); // paramless (no `of`)
    expect(app).toContain("| CloseBooksDone of Result<unit, string>");
    expect(app).not.toContain("type CloseBooksForm =");
    expect(app).not.toContain("CloseBooksForm: CloseBooksForm");
    expect(app).not.toContain("SetCloseBooksForm");
  });

  it("emits an Api fn that POSTs an empty `{}` body to /api/workflows/<wf>", async () => {
    const app = await appFs();
    expect(app).toContain("let runCloseBooks () : Async<Result<unit, string>> =");
    expect(app).toContain('let body = "{}"');
    expect(app).toContain('Http.request "/api/workflows/close_books"');
  });

  it("wires the update arm — submit posts `()`, done navigates (no form reset)", async () => {
    const app = await appFs();
    expect(app).toContain(
      "  | SubmitCloseBooksForm -> model, Cmd.OfAsync.perform Api.runCloseBooks () CloseBooksDone",
    );
    expect(app).toContain('  | CloseBooksDone (Ok ()) -> model, Cmd.navigatePath("")');
    expect(app).toContain("  | CloseBooksDone (Error _) -> model, Cmd.none");
  });

  // The submit posts through `Api` and navigates on success, so both opens must
  // ship even though this ui has no form RECORD and only one page.
  it("opens Fable.SimpleHttp + Feliz.Router for a record-less submit", async () => {
    const app = await appFs();
    expect(app).toContain("open Fable.SimpleHttp");
    expect(app).toContain("open Feliz.Router");
  });

  it("validates cleanly through validateLoomModel", async () => {
    const { errors } = await parseString(SYS, { validate: true });
    expect(errors).toEqual([]);
  });
});
