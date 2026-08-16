import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// M-T6.20 — a MESSAGED `precondition` over an operation's own request params
// must answer the WIRE-VALIDATION 422 on the Phoenix backend, not the domain
// floor.
//
// The other four backends lift such a precondition into the SAME request
// validator the invariants use (`preconditionsAsInvariants` → zod refine /
// FluentValidation / pydantic), so a trip answers title "Validation failed",
// detail "One or more fields are invalid." and an `errors[]` entry carrying the
// RFC 6901 pointer + the `msg.<hash>` code.  Elixir lowers preconditions to the
// `ensure/2` control-flow chain, so the same denial used to answer the
// DOMAIN-FLOOR rung (authored message in `detail`, NO `errors[]` — hence no
// pointer and no wire code, and a frontend ACL's `applyServerErrors` bound
// nothing).  That was the `corpus/validation-messages` wire-golden divergence,
// waived three ways in `test/_helpers/wire-waivers.ts` until this landed.
//
// Two halves of the gate are asserted here, because BOTH are what keep the fix
// honest cross-backend:
//   * a messaged, param-only precondition takes the new rung;
//   * a precondition over `this`-STATE (not wire-translatable on ANY backend —
//     `corpus/wire-contract`'s `discontinue` is the live example) and a
//     message-LESS one both stay on the domain floor, byte-identical.
// ---------------------------------------------------------------------------

const SRC = `
system S {
  subdomain Sales {
    context Cat {
      aggregate Product {
        name: string
        quantity: int
        status: string
        create(n: string) { name := n  quantity := 0  status := "open" }

        // Messaged + param-only → the WIRE rung.
        operation restock(amount: int) {
          precondition amount >= 1 message "Restock amount must be at least 1"
          quantity := quantity + amount
        }
        // Message-LESS → stays on the domain floor (its wire text would come
        // from each backend's NATIVE validator chain, not from Loom).
        operation ship(amount: int) {
          precondition amount >= 1
          quantity := quantity - amount
        }
        // Messaged but reads THIS-STATE, so no request body can carry it →
        // not wire-translatable on any backend; stays on the domain floor.
        operation close() {
          precondition status != "closed" message "Product is already closed"
          status := "closed"
        }
      }
      repository Products for Product { }
    }
  }
  api CatApi from Sales
  storage db { type: postgres }
  resource st { for: Cat, kind: state, use: db }
  deployable api { platform: elixir contexts: [Cat] dataSources: [st] serves: CatApi port: 8080 }
}
`;

// A twin with NO messaged param precondition — the gate that keeps a project
// without one byte-identical (an unused `defp` fails `--warnings-as-errors`).
const PLAIN = `
system P {
  subdomain Sales {
    context Cat {
      aggregate Widget {
        quantity: int
        create() { quantity := 0 }
        operation ship(amount: int) {
          precondition amount >= 1
          quantity := quantity - amount
        }
      }
      repository Widgets for Widget { }
    }
  }
  api CatApi from Sales
  storage db { type: postgres }
  resource st { for: Cat, kind: state, use: db }
  deployable api { platform: elixir contexts: [Cat] dataSources: [st] serves: CatApi port: 8080 }
}
`;

// A workflow whose step CALLS the guarded operation.  The op's `{:error,
// reason}` threads straight through the workflow controller's shared `respond/2`
// dispatcher, so that tail needs the same arm — without it the denial would fall
// to the sanitized 500 catch-all while the direct route answered 422.
const WORKFLOW = `
system W {
  subdomain Sales {
    context Cat {
      aggregate Product {
        name: string
        quantity: int
        operation restock(amount: int) {
          precondition amount >= 1 message "Restock amount must be at least 1"
          quantity := quantity + amount
        }
      }
      repository Products for Product { }
      workflow replenish {
        create(n: string, amount: int) {
          let p = Product.create({ name: n, quantity: 0 })
          p.restock(amount)
        }
      }
    }
  }
  api CatApi from Sales
  storage db { type: postgres }
  resource st { for: Cat, kind: state, use: db }
  deployable api { platform: elixir contexts: [Cat] dataSources: [st] serves: CatApi port: 8080 }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("elixir/vanilla — messaged precondition answers the wire-validation 422 (M-T6.20)", () => {
  it("denies with a pointer + msg.<hash> code instead of the domain-floor tuple", async () => {
    const ctx = file(await generateSystemFiles(SRC), "/api/cat.ex");
    expect(ctx).toContain(
      'ensure(amount >= 1, {:validation_failed, [%{pointer: "/amount", message: "Restock amount must be at least 1", code: "msg.zjdkcr"}]})',
    );
  });

  it("leaves the message-LESS and this-state preconditions on the domain floor", async () => {
    const ctx = file(await generateSystemFiles(SRC), "/api/cat.ex");
    // Message-less: the derived default, domain-floor tuple.
    expect(ctx).toContain(
      'ensure(amount >= 1, {:precondition_failed, "Precondition failed: amount >= 1"})',
    );
    // Messaged but reads `this.status` — no request body carries it, so it is
    // not wire-translatable on ANY backend and keeps the domain-floor rung.
    expect(ctx).toContain(
      'ensure(record.status != "closed", {:precondition_failed, "Product is already closed"})',
    );
  });

  it("the controller renders the wire rung through the shared errors[] responder", async () => {
    const ctrl = file(await generateSystemFiles(SRC), "/controllers/product_controller.ex");
    expect(ctrl).toContain("{:error, {:validation_failed, errors}} ->");
    expect(ctrl).toContain("ProblemDetails.validation_errors_response(conn, errors)");
    // The domain-floor arm survives beside it (the other two ops still use it).
    expect(ctrl).toContain("{:error, {:precondition_failed, detail}} ->");
  });

  it("both 422 rungs share ONE sender, so title/detail can never drift", async () => {
    const pd = file(await generateSystemFiles(SRC), "/problem_details.ex");
    expect(pd).toContain("defp send_validation_problem(conn, pointer_errors) do");
    expect(pd).toContain('title: "Validation failed"');
    expect(pd).toContain('detail: "One or more fields are invalid."');
    // The changeset path delegates to it rather than building its own body.
    expect(pd).toContain("send_validation_problem(conn, pointer_errors)\n  end");
    // The wire path localises the code through the SAME catalog lookup.
    expect(pd).toContain("def validation_errors_response(conn, errors) when is_list(errors) do");
    expect(pd).toContain("message: localize(code, message)");
  });

  it("the shared workflow respond/2 tail carries the arm, so an op-call denial keeps its 422", async () => {
    const files = await generateSystemFiles(WORKFLOW);
    const ctrl = file(files, "/controllers/workflows_controller.ex");
    expect(ctrl).toContain("def respond(conn, {:error, {:validation_failed, errors}}),");
    expect(ctrl).toContain("do: ProblemDetails.validation_errors_response(conn, errors)");
    // Still ahead of the sanitized catch-all, which must stay LAST.
    const wireIdx = ctrl.indexOf("{:error, {:validation_failed, errors}}");
    const catchAllIdx = ctrl.indexOf("def respond(conn, {:error, _reason})");
    expect(wireIdx).toBeGreaterThan(-1);
    expect(catchAllIdx).toBeGreaterThan(wireIdx);
  });

  it("is gated: a project with no messaged param precondition emits no wire responder", async () => {
    const files = await generateSystemFiles(PLAIN);
    const pd = file(files, "/problem_details.ex");
    expect(pd).not.toContain("validation_errors_response");
    expect(pd).not.toContain("render_wire_error");
    const ctrl = file(files, "/controllers/widget_controller.ex");
    expect(ctrl).not.toContain(":validation_failed");
  });
});
