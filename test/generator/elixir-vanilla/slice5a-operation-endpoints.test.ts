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
});
