import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// §13 — LiveView operation-action bang seams on the vanilla (plain Ecto/Phoenix)
// foundation.
//
// A `Detail` page hosting `Action { c.<op> }` on a non-destroy operation hoists a
// `handle_event/3` that calls `<Ctx>.get_<agg>!(id)` then `<Ctx>.<op>_<agg>!(record)`
// (`liveview-emit.ts`).  The context module emits only the non-bang `get_<agg>`
// (`{:ok|:error}`) and `<op>_<agg>(record, params)`, so without the bang seams
// `mix compile --warnings-as-errors` fails on the undefined calls.  This pins the
// emitted bangs (sibling of §10's `destroy_<agg>!/1`).
// ---------------------------------------------------------------------------

function withOps(extra: string): string {
  return `
system S {
  subdomain Sales { context Sales {
    aggregate Customer {
      name: string
      status: string
      operation confirm() {
        requires currentUser.role == "manager"
        status := "confirmed"
      }
      operation cancel() {
        status := "cancelled"
      }
    }
    repository Customers for Customer { }
    ${extra}
  } }
  user { id: string  role: string }
  api SApi from Sales
  storage pg { type: postgres }
  resource st { for: Sales, kind: state, use: pg }
  deployable api {
    platform: elixir { foundation: vanilla }
    contexts: [Sales]
    dataSources: [st]
    serves: SApi
    ui: Admin { Sales: api }
    port: 4000
    auth: required
  }
  ui Admin {
    api Sales: SApi
    page Detail {
      route: "/customers/:id"
      body: QueryView {
        of: Sales.Customer.byId(id),
        single: true,
        loading: Loader {},
        empty: Empty { "Not found" },
        data: c => Toolbar { Action { c.confirm }, Action { c.cancel } }
      }
    }
  }
}
`;
}

function ctxOf(files: Map<string, string>): string {
  const key = [...files.keys()].find((k) => k.endsWith("/sales.ex"));
  expect(key, "context module not emitted").toBeDefined();
  return files.get(key!)!;
}

describe("vanilla LiveView operation-action bang seams (§13)", () => {
  it("emits get_<agg>!/1 — a load-or-raise getter (arity-1, the call-site arity)", async () => {
    const ctx = ctxOf(await generateSystemFiles(withOps("")));
    expect(ctx).toContain("def get_customer!(id) do");
    expect(ctx).toMatch(/case get_customer\(id\) do\s*\n\s*\{:ok, record\} -> record/);
    expect(ctx).toContain("raise Ecto.NoResultsError");
  });

  it("the operation controller action maps a raised guard to 403/400 (not 500)", async () => {
    // `confirm` has `requires currentUser.role == "manager"` — its domain core
    // raises `ArgumentError, "Forbidden: …"` on rejection.  Without a rescue that
    // propagates to Phoenix's default 500; the controller action must map it to
    // 403 (requires) / 400 (precondition), the statuses the other backends return.
    const files = await generateSystemFiles(withOps(""));
    const ctrlKey = [...files.keys()].find((k) => k.endsWith("/customer_controller.ex"))!;
    const ctrl = files.get(ctrlKey)!;
    // The confirm action carries the rescue clause.
    const confirm = ctrl.slice(ctrl.indexOf("def confirm("));
    expect(confirm).toContain("rescue");
    expect(confirm).toContain('String.starts_with?(guard_msg, "Forbidden: ")');
    expect(confirm).toContain('ProblemDetails.problem_response(conn, 403, "Forbidden", guard_msg)');
    expect(confirm).toContain('String.starts_with?(guard_msg, "Precondition failed: ")');
    expect(confirm).toContain('ProblemDetails.problem_response(conn, 400, "Bad Request", guard_msg)');
    // A non-guard ArgumentError still reraises → 500 (unchanged).
    expect(confirm).toContain("reraise(guard_error, __STACKTRACE__)");
  });

  it("emits <op>_<agg>!(record) per operation, raising on {:error, _}", async () => {
    const ctx = ctxOf(await generateSystemFiles(withOps("")));
    // gated op threads current_user (default nil so the arity-1 call-site resolves)
    expect(ctx).toContain("def confirm_customer!(record, current_user \\\\ nil) do");
    expect(ctx).toMatch(/case confirm_customer\(record, %\{\}, current_user\) do/);
    // ungated op is plain arity-1
    expect(ctx).toContain("def cancel_customer!(record) do");
    expect(ctx).toMatch(/case cancel_customer\(record, %\{\}\) do/);
    expect(ctx).toMatch(/\{:error, reason\} -> raise/);
  });

  // §11c follow-up — the PURE domain core (aggregate schema module, emitted only
  // when the aggregate carries `test` blocks) must thread the actor for a
  // `requires currentUser.<…>` op, or `current_user` is unbound and
  // `mix compile --warnings-as-errors` fails (the showcase 5-backend-parity blocker).
  it("threads current_user into the PURE-CORE op fn for a `requires currentUser` op", async () => {
    const SRC = `
system PC {
  subdomain Sales { context Sales {
    aggregate Customer {
      name: string
      status: string
      operation confirm() {
        requires currentUser.role == "manager"
        status := "confirmed"
      }
      test "a fresh customer can be built" {
        let c = Customer.create({ name: "acme" })
        expect(c.name).toBe("acme")
      }
    }
    repository Customers for Customer { }
  } }
  user { id: string  role: string }
  api PApi from Sales
  storage pg { type: postgres }
  resource st { for: Sales, kind: state, use: pg }
  deployable api { platform: elixir { foundation: vanilla } contexts: [Sales] dataSources: [st] serves: PApi port: 4000 auth: required }
}
`;
    const files = await generateSystemFiles(SRC);
    const key = [...files.keys()].find((k) => k.endsWith("/customer.ex"));
    expect(key, "aggregate schema module not emitted").toBeDefined();
    const core = files.get(key!)!;
    // The pure-core op binds the actor (default nil so the inlined context caller
    // and any 2-arg test call site still resolve), and the guard reads it.
    expect(core).toMatch(
      /def confirm\(%__MODULE__\{\} = record, _params, current_user \\\\ nil\) do/,
    );
    expect(core).toContain('current_user.role == "manager"');
  });

  it("an aggregate with NO operations emits no op-action bangs (byte-identical)", async () => {
    const SRC = `
system S2 {
  subdomain Cat { context Cat {
    aggregate Item { name: string }
    repository Items for Item { }
  } }
  api CApi from Cat
  storage pg { type: postgres }
  resource st { for: Cat, kind: state, use: pg }
  deployable api { platform: elixir { foundation: vanilla } contexts: [Cat] dataSources: [st] serves: CApi port: 4000 }
}
`;
    const key = [...(await generateSystemFiles(SRC)).keys()].find((k) => k.endsWith("/cat.ex"));
    const cat = (await generateSystemFiles(SRC)).get(key!)!;
    expect(cat).not.toContain("def get_item!(");
    expect(cat).not.toContain("def get_item!");
  });
});
