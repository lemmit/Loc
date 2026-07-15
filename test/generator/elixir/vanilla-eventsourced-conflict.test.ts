import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Vanilla (Ecto/Phoenix) foundation — the event-sourced concurrency rider.  An
// event-sourced (`persistedAs(eventLog)`) aggregate appends to an append-only
// `<agg>_events` table keyed by a `(stream_id, version)` PRIMARY KEY.  A
// concurrent append that loses the version race raises a Postgrex.Error
// unique_violation (SQLSTATE 23505) inside the append transaction; the
// repository rescues it to `{:error, :conflict}`, which the event-sourced
// controller's `command_error/2` maps onto `ProblemDetails.conflict_response/1`
// — a 409 with the distinct `conflict` catalog event, reusing the `versioned`
// machinery.
//
// Since versioning is default-on (M-T3.4), a plain relational aggregate is now
// auto-versioned and ALSO carries `conflict_response/1` (via the shared
// optimistic-lock → 409 machinery); the rider fires for event-sourced OR
// versioned aggregates, which is now every non-event-sourced aggregate too.
//
// Sibling of vanilla-concurrency-conflict.test.ts (the `versioned`
// optimistic_lock → 409); this is the event-log-append → 409.
// ---------------------------------------------------------------------------

const ES = `
system Bank {
  subdomain Ledger {
    context Accounts {
      event Opened { account: Account id, owner: string }
      event Deposited { account: Account id, amount: int }

      aggregate Account persistedAs(eventLog) {
        owner: string
        balance: int

        create open(owner: string) { emit Opened { account: id, owner: owner } }
        operation deposit(amount: int) {
          precondition amount > 0
          emit Deposited { account: id, amount: amount }
        }

        apply(e: Opened) { owner := e.owner  balance := 0 }
        apply(e: Deposited) { balance := balance + e.amount }
      }
      repository Accounts for Account { }
    }
  }
  api LedgerApi from Ledger
  storage primary { type: postgres }
  resource accountsLog { for: Accounts, kind: eventLog, use: primary }
  deployable api {
    platform: elixir
    contexts: [Accounts]
    dataSources: [accountsLog]
    serves: LedgerApi
    port: 4000
  }
}
`;

const RELATIONAL = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Customer { email: string  name: string }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource ordState { for: Ordering, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Ordering]
    dataSources: [ordState]
    serves: SalesApi
    port: 4000
  }
}
`;

const at = (files: Map<string, string>, suffix: string): string => {
  const entry = [...files.entries()].find(([p]) => p.endsWith(suffix));
  expect(entry, `${suffix} missing`).toBeDefined();
  return entry![1];
};

describe("vanilla elixir generator — event-sourced concurrency rider", () => {
  it("append rescues a Postgrex unique_violation to {:error, :conflict}", async () => {
    const repo = at(await generateSystemFiles(ES), "accounts/account_repository.ex");
    expect(repo).toContain("rescue");
    expect(repo).toContain("e in Postgrex.Error ->");
    expect(repo).toContain(
      "%Postgrex.Error{postgres: %{code: :unique_violation}} -> {:error, :conflict}",
    );
  });

  it("the event-sourced controller maps {:error, :conflict} onto conflict_response/1", async () => {
    const controller = at(await generateSystemFiles(ES), "controllers/account_controller.ex");
    expect(controller).toContain("defp command_error(conn, :conflict) do");
    expect(controller).toContain("ProblemDetails.conflict_response(conn)");
  });

  it("ProblemDetails emits conflict_response/1 with the distinct `conflict` event", async () => {
    const pd = at(await generateSystemFiles(ES), "problem_details.ex");
    expect(pd).toContain("def conflict_response(conn) do");
    expect(pd).toContain('event: "conflict"');
    expect(pd).toContain("send_resp(409, body)");
  });

  it("a plain relational aggregate ALSO gets conflict_response/1 — versioning is default-on (M-T3.4)", async () => {
    // Versioning is now auto-applied to every plain (non-event-sourced)
    // aggregate, so the `versioned` optimistic-lock → 409 machinery (and its
    // shared `conflict_response/1`) rides along even without `with versioned`.
    const pd = at(await generateSystemFiles(RELATIONAL), "problem_details.ex");
    expect(pd).toContain("def conflict_response(conn) do");
  });
});
