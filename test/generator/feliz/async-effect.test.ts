// Feliz frontend — `match await` async-effect renderer (M-T6.15, the last piece).
//
// A frontend action whose body is `match await <api>.<Agg>.<op>() { <Agg> b => …
// else => … }` (async-actions-and-effects.md Stage 2) projects to the MVU as a
// TRIGGER → RESULT pair + a `type`-tagged decode.  The emitted F# is proven to
// `dotnet fable`-compile in CI (SDK:8.0 container); this pins the projection
// shape so a regression surfaces in the fast suite before the docker gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// A list + detail ui: the detail page (`:id` route) hosts a `match await` over a
// union-returning aggregate instance op (`reserve(): Order or OrderMissing`).
const SYS = `
system Demo {
  subdomain S {
    context C {
      error OrderMissing { missingRef: string }
      aggregate Order with crudish {
        customerId: string
        operation reserve(): Order or OrderMissing {
          return OrderMissing { missingRef: customerId }
        }
      }
    }
  }
  api A from S
  ui Web {
    api C: A
    page Orders {
      route: "/orders"
      body: QueryView {
        of: C.Order.all,
        loading: Text { "loading" },
        error: Text { "err" },
        empty: Text { "none" },
        data: rows => Stack { For { each: rows, o => Card { o.customerId } } }
      }
    }
    page Detail(id: Order id) {
      route: "/orders/:id"
      state { draftName: string = "" }
      action reserveNow() {
        match await C.Order.reserve() {
          Order o => { draftName := o.customerId }
          else    => { draftName := "unavailable" }
        }
      }
      body: Stack { Heading { "Order", level: 1 }, Button { "Reserve", onClick: reserveNow } }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: feliz targets: api ui: Web { C: api } port: 3001 }
}`;

async function appFs(): Promise<string> {
  const files = await generateSystemFiles(SYS);
  const entry = [...files.entries()].find(([p]) => p.endsWith("src/App.fs"));
  expect(entry).toBeDefined();
  return entry![1];
}

describe("feliz async effect — `match await` (M-T6.15)", () => {
  it("emits the trigger + result Msg cases (trigger carries the route id)", async () => {
    const fs = await appFs();
    expect(fs).toContain("  | ReserveNow of string");
    expect(fs).toContain("  | ReserveNowResult of Result<Order option, string>");
    // The plain-action path did NOT also emit a bare `| ReserveNow` (no `of`) —
    // the async-effect action is pulled out of the plain Msg/update projection.
    expect(fs).not.toMatch(/\| ReserveNow$/m);
  });

  it("projects the update arms — trigger fires Cmd.OfAsync.perform; result reduces the option", async () => {
    const fs = await appFs();
    expect(fs).toContain(
      "  | ReserveNow id -> model, Cmd.OfAsync.perform (Api.reserveOrderEffect id) () ReserveNowResult",
    );
    // Success arm binds `o` under `(Ok (Some o))`; its body writes state.
    expect(fs).toContain("  | ReserveNowResult (Ok (Some o)) ->");
    expect(fs).toContain("{ model with DraftName = o.customerId }");
    // The `else` body reduces BOTH the non-success tag and a thrown/non-2xx.
    expect(fs).toContain("  | ReserveNowResult (Ok None) ->");
    expect(fs).toContain("  | ReserveNowResult (Error _) ->");
    expect(fs).toContain('{ model with DraftName = "unavailable" }');
  });

  it("member access on the success binding keeps the lowercase wire-field name", async () => {
    const fs = await appFs();
    // The wire record is `type Order = { customerId: … }` (lowercase), so the
    // arm reads `o.customerId`, NOT `o.CustomerId` — same casing as the view path.
    expect(fs).toContain("o.customerId");
    expect(fs).not.toContain("o.CustomerId");
  });

  it("emits the curried api fn — POSTs the op route, decodes the `type`-tagged union", async () => {
    const fs = await appFs();
    expect(fs).toContain(
      "  let reserveOrderEffect (id: string) () : Async<Result<Order option, string>> =",
    );
    expect(fs).toContain('Http.request (sprintf "/api/orders/%s/reserve" id)');
    expect(fs).toContain("|> Http.method POST");
    // Tagged-union decode: success tag → `Some Decoders.order`, else → `None`.
    expect(fs).toContain('Decode.field "type" Decode.string');
    expect(fs).toContain("|> Decode.andThen (fun tag ->");
    expect(fs).toContain('if tag = "Order" then Decode.map Some Decoders.order');
    expect(fs).toContain("else Decode.succeed None");
  });

  it("emits the success aggregate's record + decoder even without a Remote read of it", async () => {
    const fs = await appFs();
    // `Decoders.order` is referenced by the effect fn, so the record + decoder
    // must be emitted (here a list read also exists, but the wiring is driven by
    // the effect's success aggregate, not the read).
    expect(fs).toContain("type Order =");
    expect(fs).toContain("let order : Decoder<Order> =");
  });

  it("the dispatch wrapper passes the route id to the trigger", async () => {
    const fs = await appFs();
    expect(fs).toContain("let reserveNow () = dispatch (ReserveNow id)");
  });
});

// The "harder shapes": a multi-variant discriminated union (named success +
// error arms), an op WITH params, and a MISSING `else`.  A detail page's action
// awaits `confirm(note): Order or Rejected or Blocked` with one arm per variant
// and no `else`.  Proven to `dotnet fable`-compile (the DU + tagged-union decoder
// + ProblemDetails error reification + no-op fallthrough all type-check).
const HARD = `
system Demo {
  subdomain S {
    context C {
      error Rejected { reason: string }
      error Blocked { until: string }
      aggregate Order with crudish {
        code: string
        operation confirm(note: string): Order or Rejected or Blocked {
          return Rejected { reason: note }
        }
      }
    }
  }
  api A from S
  ui Web {
    api C: A
    page Detail(id: Order id) {
      route: "/orders/:id"
      state { message: string = "" }
      action confirm() {
        match await C.Order.confirm("hi") {
          Order o    => { message := o.code }
          Rejected r => { message := r.reason }
          Blocked b  => { message := "blocked" }
        }
      }
      body: Stack { Heading { "Order", level: 1 }, Button { "Confirm", onClick: confirm } }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: feliz targets: api ui: Web { C: api } port: 3001 }
}`;

async function hardFs(): Promise<string> {
  const files = await generateSystemFiles(HARD);
  const entry = [...files.entries()].find(([p]) => p.endsWith("src/App.fs"));
  expect(entry).toBeDefined();
  return entry![1];
}

describe("feliz async effect — harder shapes (multi-variant / params / no-else)", () => {
  it("emits the outcome discriminated union — one case per named variant", async () => {
    const fs = await hardFs();
    expect(fs).toContain("type ConfirmOrderOutcome =");
    expect(fs).toContain("  | ConfirmOrderOrder of Order");
    expect(fs).toContain("  | ConfirmOrderRejected of Rejected");
    expect(fs).toContain("  | ConfirmOrderBlocked of Blocked");
    // The result Msg carries the DU (not a bare `<Succ> option`).
    expect(fs).toContain("| ConfirmResult of Result<ConfirmOrderOutcome option, string>");
  });

  it("carries the op arg through the trigger Msg + dispatch, and encodes it into the body", async () => {
    const fs = await hardFs();
    expect(fs).toContain("| Confirm of string * string");
    expect(fs).toContain('let confirm () = dispatch (Confirm (id, "hi"))');
    expect(fs).toContain(
      "let confirmOrderEffect (id: string) (arg0: string) () : Async<Result<ConfirmOrderOutcome option, string>> =",
    );
    expect(fs).toContain('Encode.object [ "note", Encode.string arg0 ]');
  });

  it("decodes the success variant at 200 and reifies error variants from the non-2xx `type` URI", async () => {
    const fs = await hardFs();
    // 200 → the success aggregate, wrapped into the DU.
    expect(fs).toContain(
      'if tag = "Order" then Decode.map (fun x -> Some (ConfirmOrderOrder x)) Decoders.order',
    );
    // non-2xx → the ProblemDetails `type` URI → the matching error DU case.
    expect(fs).toContain(
      'if tag = "/errors/rejected" then Decode.map (fun x -> Some (ConfirmOrderRejected x)) Decoders.rejected',
    );
    expect(fs).toContain(
      'elif tag = "/errors/blocked" then Decode.map (fun x -> Some (ConfirmOrderBlocked x)) Decoders.blocked',
    );
    // The error records + decoders are force-emitted for the reification.
    expect(fs).toMatch(/(let|and) rejected : Decoder<Rejected> =/);
    expect(fs).toMatch(/(let|and) blocked : Decoder<Blocked> =/);
  });

  it("projects one update arm per variant; the unused binder degrades to `_`; missing else is a no-op", async () => {
    const fs = await hardFs();
    expect(fs).toContain("| ConfirmResult (Ok (Some (ConfirmOrderOrder o))) ->");
    expect(fs).toContain("| ConfirmResult (Ok (Some (ConfirmOrderRejected r))) ->");
    // `Blocked b` never reads `b` → the binder drops to `_` (no unused-var warning).
    expect(fs).toContain("| ConfirmResult (Ok (Some (ConfirmOrderBlocked _))) ->");
    // No `else` in source → the non-matching / error outcome is a no-op.
    expect(fs).toContain("| ConfirmResult (Ok None) ->");
    expect(fs).toContain("| ConfirmResult (Error _) ->");
    expect(fs).toMatch(/\| ConfirmResult \(Error _\) ->\n\s+model, Cmd\.none/);
  });
});
