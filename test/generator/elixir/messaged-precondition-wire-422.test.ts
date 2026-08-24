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
        create(name: string) { }

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
        create() { }
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

  it("is gated: a project with no messaged param precondition tags no wire denial", async () => {
    const files = await generateSystemFiles(PLAIN);
    const ctrl = file(files, "/controllers/widget_controller.ex");
    // The CONTROLLER side is what M-T6.20 gates: without a messaged, param-only
    // precondition nothing is tagged `:validation_failed`, so nothing reaches
    // the wire rung and the denial stays on the domain floor.
    expect(ctrl).not.toContain(":validation_failed");

    // The RESPONDER, however, is no longer exclusive to this feature.  The
    // paging-bounds refusal (audit A16 — an out-of-range `page`/`pageSize` now
    // 422s instead of being clamped past the bounds the OpenAPI document
    // publishes) sends through the SAME `validation_errors_response/2`, and the
    // auto-`findAll` makes every non-abstract controller paged — so its
    // presence no longer implies a messaged precondition.  Asserting its
    // ABSENCE here would pin a coincidence, not the gate.
    const pd = file(files, "/problem_details.ex");
    expect(pd).toContain("def validation_errors_response(conn, errors) when is_list(errors) do");
  });
});

// ---------------------------------------------------------------------------
// M-T6.20 PATH 2 — the RAISE path (`function` / `domainService` / pure-core).
//
// The `ensure` chain above is only reachable from an HTTP-boundary operation.
// A guard in a PURE body has no `with` chain to short-circuit through, so it
// RAISES and a controller `rescue` maps the raise to a status.
//
// That rescue used to route by MESSAGE PREFIX — `String.starts_with?(guard_msg,
// "Precondition failed: ")` — which made the message the ROUTING KEY, so an
// authored `message "…"` was UNEMITTABLE: it would miss the prefix and fall to
// the `reraise` arm, answering 500 instead of 422.  Both raise sites carried a
// comment saying so and shipped the derived text instead.
//
// The classification is now out of band, in the `:kind` field of a typed
// `<App>.GuardError`.  Three things must hold together, and each is asserted on
// the ONE file that owns it (a joined search over all files would be satisfied
// by any sibling that happens to carry the shape):
//   1. the exception module exists in the DOMAIN layer (`lib/<app>/`, not
//      `<App>Web.*` — `function-emit` / `domain-service-emit` render there);
//   2. the raise carries `kind:` + the AUTHOR'S message;
//   3. the controller rescue routes on `guard_error.kind`, and reads the
//      message nowhere.
// ---------------------------------------------------------------------------

const RAISE_PATH = `
system S {
  subdomain Sales {
    context Cat {
      aggregate Product {
        name: string
        quantity: int

        function checkRestockable(amount: int): bool {
          precondition amount >= 1 message "A pure function keeps its authored message"
          return true
        }

        create(name: string) { }

        operation restock(amount: int) {
          let ok = checkRestockable(amount)
          quantity := quantity + amount
        }
      }
      repository Products for Product { }

      domainService Quotes {
        operation quote(p: Product): int {
          requires currentUser.level > 2
          return p.quantity
        }
      }
    }
  }
  user { id: string  level: int }
  api CatApi from Sales
  storage db { type: postgres }
  resource st { for: Cat, kind: state, use: db }
  deployable api { platform: elixir contexts: [Cat] dataSources: [st] serves: CatApi port: 8080 auth: required }
}
`;

describe("elixir/vanilla — the RAISE path carries the author's message (M-T6.20 path 2)", () => {
  it("emits the typed guard exception in the DOMAIN layer", async () => {
    const files = await generateSystemFiles(RAISE_PATH);
    const mod = file(files, "/api/guard_error.ex");
    expect(mod).toContain("defmodule Api.GuardError do");
    expect(mod).toContain("defexception [:message, :kind]");
    expect(mod).toContain("@type kind :: :forbidden | :precondition");
    // Domain layer, NOT `<App>Web.*` — the raise sites live under `lib/<app>/`
    // and must not reference the Web namespace.
    expect(mod).not.toContain("ApiWeb");
    const key = [...files.keys()].find((k) => k.endsWith("/api/guard_error.ex"))!;
    expect(key).toMatch(/\/lib\/api\/guard_error\.ex$/);
  });

  it("a `function` precondition raises with the AUTHOR'S message, not the derived form", async () => {
    const ctx = file(await generateSystemFiles(RAISE_PATH), "/api/cat.ex");
    expect(ctx).toContain(
      'raise(Api.GuardError, kind: :precondition, message: "A pure function keeps its authored message")',
    );
    // The derived form is what shipped while the prefix was the routing key.
    expect(ctx, "derived detail emitted despite an authored message").not.toContain(
      "Precondition failed: amount >= 1",
    );
  });

  it("a `domainService` requires raises the same typed exception", async () => {
    const svc = file(await generateSystemFiles(RAISE_PATH), "/domain/services/quotes.ex");
    expect(svc).toContain(
      'raise(Api.GuardError, kind: :forbidden, message: "Forbidden: currentUser.level > 2")',
    );
  });

  it("the controller rescue routes on the :kind FIELD, and reads the message nowhere", async () => {
    const ctrl = file(await generateSystemFiles(RAISE_PATH), "/controllers/product_controller.ex");
    expect(ctrl).toContain("guard_error in Api.GuardError ->");
    expect(ctrl).toContain("case guard_error.kind do");
    expect(ctrl).toContain(":forbidden ->\n          ProblemDetails.problem_response(conn, 403,");
    expect(ctrl).toContain("_ ->\n          ProblemDetails.problem_response(conn, 422,");
    // The routing key is the field; the message is free text again.  These two
    // absences ARE the fix — with either one back, an authored message reroutes.
    expect(ctrl).not.toContain("String.starts_with?(guard_msg");
    expect(ctrl).not.toContain('"Precondition failed: "');
  });
});
