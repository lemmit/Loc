import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Slice P4.0 of docs/plans/elixir-eventsourcing-vanilla-plan.md —
// per-operation HTTP endpoints on the vanilla foundation.
//
// The vanilla emit previously exposed only index/show/create/update/delete;
// public domain operations (e.g. `deposit`) had a `<op>_<agg>` context
// function but no HTTP surface, diverging from the Ash path and the
// node/dotnet/python/java backends (all of which mount
// `POST /<plural>/:id/<op>`).  This slice closes that gap — a prerequisite
// for event-sourced aggregates, whose operations are their whole point.
// ---------------------------------------------------------------------------

const VANILLA_SOURCE = `
system Ledger {
  subdomain Core {
    context Accounts {
      aggregate Account with crudish {
        owner: string
        balance: int

        operation deposit(amount: int) {
          balance := balance + amount
        }
      }
      repository Accounts for Account { }
    }
  }
  api AccountsApi from Core
  storage primary { type: postgres }
  resource accountsState { for: Accounts, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Accounts]
    dataSources: [accountsState]
    serves: AccountsApi
    port: 4000
  }
}
`;

describe("vanilla — Slice P4.0 per-operation endpoints", () => {
  it("router mounts POST /<plural>/:id/<op> for a public operation", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const router = files.get([...files.keys()].find((k) => k.endsWith("/router.ex"))!)!;
    expect(router).toMatch(
      /scope "\/api"[\s\S]*post "\/accounts\/:id\/deposit", AccountController, :deposit/,
    );
  });

  it("controller emits a member action that loads, runs the op, and returns 204", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const ctl = files.get(
      [...files.keys()].find((k) => k.endsWith("/controllers/account_controller.ex"))!,
    )!;
    expect(ctl).toContain('def deposit(conn, %{"id" => id} = params)');
    expect(ctl).toContain("Accounts.get_account(id)");
    expect(ctl).toContain("Accounts.deposit_account(record, attrs)");
    expect(ctl).toContain("send_resp(conn, 204");
    // Failure mapping reuses the shared ProblemDetails responders.
    expect(ctl).toContain('ProblemDetails.not_found_response(conn, "Account", id)');
    expect(ctl).toContain("ProblemDetails.validation_error_response(conn, changeset)");
  });

  it("the per-op action calls the context fn that context-emit actually provides", async () => {
    // The route's target (`deposit_account/2`) must exist on the context
    // façade — guards the lockstep between api-emit and context-emit.
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const ctx = files.get([...files.keys()].find((k) => k.endsWith("lib/api/accounts.ex"))!)!;
    expect(ctx).toContain("def deposit_account(%");
  });

  it("CRUD-verb-named routes are unchanged (no double-mount)", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const router = files.get([...files.keys()].find((k) => k.endsWith("/router.ex"))!)!;
    // The generic create/show/index routes still exist; the op did not
    // displace them.
    expect(router).toMatch(/post "\/accounts", AccountController, :create/);
    expect(router).toMatch(/get "\/accounts\/:id", AccountController, :show/);
  });

  it("a NO-guard named op keeps the flat linear body (no `with ensure(...)` wrap)", async () => {
    // `deposit` has no requires/precondition — its context fn stays byte-identical
    // (plain changeset pipe), and no `ensure/2` helper is emitted.
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const ctx = files.get([...files.keys()].find((k) => k.endsWith("lib/api/accounts.ex"))!)!;
    const body = ctx.slice(ctx.indexOf("def deposit_account(%"));
    expect(body.slice(0, body.indexOf("\n  end"))).not.toContain("with :ok <- ensure");
    expect(ctx).not.toContain("defp ensure(");
  });
});

// ---------------------------------------------------------------------------
// A NAMED (non-returning) op with `requires`/`precondition` guards must deny
// with a typed tuple (403/422), NOT raise an ArgumentError (→ 500).  The guards
// hoist into a leading `with ensure(...)` chain that runs BEFORE the persist,
// and the controller `else` maps the atoms.  (docs/plans/phoenix-op-guards-403-422.md)
// ---------------------------------------------------------------------------

const GUARDED_NAMED = `
system Ledger {
  subdomain Core {
    context Accounts {
      aggregate Account with crudish {
        owner: string
        balance: int

        operation withdraw(amount: int) {
          requires balance >= amount
          precondition amount > 0
          balance := balance - amount
        }
      }
      repository Accounts for Account { }
    }
  }
  api AccountsApi from Core
  storage primary { type: postgres }
  resource accountsState { for: Accounts, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Accounts]
    dataSources: [accountsState]
    serves: AccountsApi
    port: 4000
  }
}
`;

describe("vanilla — guarded NAMED op denies 403/422 (not raise → 500)", () => {
  const get = (m: Map<string, string>, suffix: string) =>
    m.get([...m.keys()].find((k) => k.endsWith(suffix))!)!;

  it("context fn hoists the guards into a `with ensure(...)` chain before the persist", async () => {
    const ctx = get(await generateSystemFiles(GUARDED_NAMED), "lib/api/accounts.ex");
    const body = ctx.slice(ctx.indexOf("def withdraw_account(%"));
    const fn = body.slice(0, body.indexOf("\n  end"));
    // `requires` → 403 (`:forbidden`); `precondition` → 422 (`:precondition_failed`).
    expect(fn).toContain("with :ok <- ensure(record.balance >= amount, :forbidden),");
    expect(fn).toContain(":ok <- ensure(amount > 0, :precondition_failed) do");
    // Guards precede the mutation + persist.
    const withAt = fn.indexOf("with :ok <- ensure");
    const mutAt = fn.indexOf("record = %{record | balance:");
    const persistAt = fn.indexOf("persist_change");
    expect(withAt).toBeGreaterThan(-1);
    expect(withAt).toBeLessThan(mutAt);
    expect(mutAt).toBeLessThan(persistAt);
    // NOT a raise — an expected denial is no longer a 500.
    expect(fn).not.toContain("raise(ArgumentError");
    // The shared `ensure/2` helper is emitted (state op now needs it).
    expect(ctx).toContain("defp ensure(true, _reason), do: :ok");
  });

  it("controller `else` maps the denial atoms to 403 / 422", async () => {
    const ctl = get(await generateSystemFiles(GUARDED_NAMED), "/controllers/account_controller.ex");
    expect(ctl).toContain(
      'ProblemDetails.problem_response(conn, 403, "Forbidden", "Operation not permitted")',
    );
    expect(ctl).toContain(
      'ProblemDetails.problem_response(conn, 422, "Unprocessable Entity", "A precondition failed")',
    );
    expect(ctl).toContain("{:error, :forbidden} ->");
    expect(ctl).toContain("{:error, :precondition_failed} ->");
  });
});
