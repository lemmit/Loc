// Generator coverage for the `mutating`-tier `domainService` on the Phoenix /
// Elixir (vanilla Ecto) backend — domain-services.md rev. 4, Slice 3.
//
// Elixir is the structural OUTLIER (sim §2.5, decision B).  Where the other four
// backends emit a service unit and the workflow orchestrator SAVES the mutated
// args at exit, on Elixir a `mutating` service is pure SUGAR for the `with`-chain
// of context mutating-fn calls — there is NO separate service unit:
//   - `emitDomainServices` skips the mutating op (no `Domain.Services` module),
//   - the workflow's `Transfer.run(s, d, amount)` inlines to the `with`-chain
//     `{:ok, s} <- Context.withdraw_account(s, %{...}), {:ok, d} <- ...`,
//   - persistence happens INSIDE each context fn (changeset + Repo.update via
//     `persist_change`); the atomic commit is the workflow's `Repo.transaction`,
//   - each clause rebinds the mutated arg to the struct the context fn returns
//     (immutable-Ecto-struct threading).
// The pure + reading tiers (Slice 1) must stay byte-identical.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** A Banking system with a `mutating` service (`Transfer.run`, calls the
 *  mutating `withdraw`/`deposit` ops on its two `Account` params) called from a
 *  `transactional` workflow.  Params are `source`/`dest` (the slice convention —
 *  `from`/`to` are reserved). */
const MUTATING = `
system Banking {
  subdomain Accounts {
    context Accounts {
      valueobject Money {
        amount: decimal
        currency: string
        invariant amount >= 0
      }
      aggregate Account with crudish {
        holder: string
        balance: Money
        operation withdraw(amount: Money) {
          balance := Money { amount: balance.amount - amount.amount, currency: balance.currency }
        }
        operation deposit(amount: Money) {
          balance := Money { amount: balance.amount + amount.amount, currency: balance.currency }
        }
      }
      repository Accounts for Account { }
      domainService Transfer {
        operation run(source: Account, dest: Account, amount: Money) {
          source.withdraw(amount)
          dest.deposit(amount)
        }
      }
      domainService FeeQuote {
        operation forAmount(amount: Money): Money {
          return Money { amount: amount.amount, currency: amount.currency }
        }
      }
      workflow MoveMoney transactional {
        create(src: Account id, dst: Account id, amount: Money) {
          let s = Accounts.getById(src)
          let d = Accounts.getById(dst)
          Transfer.run(s, d, amount)
        }
      }
    }
  }
  storage primary { type: postgres }
  resource accountsState { for: Accounts, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Accounts]
    dataSources: [accountsState]
    port: 4000
  }
}
`;

function bySuffix(f: Map<string, string>, suffix: string): string {
  const key = [...f.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no generated file ending in ${suffix}`);
  return f.get(key)!;
}

function maybeBySuffix(f: Map<string, string>, suffix: string): string | undefined {
  const key = [...f.keys()].find((k) => k.endsWith(suffix));
  return key ? f.get(key) : undefined;
}

describe("phoenix vanilla — mutating-tier domainService (domain-services.md rev. 4, Slice 3)", () => {
  it("emits NO standalone Domain.Services module for a mutating op", async () => {
    const files = await generateSystemFiles(MUTATING);
    // The mutating service is sugar for the workflow's with-chain — no unit.
    expect(maybeBySuffix(files, "domain/services/transfer.ex")).toBeUndefined();
  });

  it("inlines the service call as the with-chain of context mutating fns", async () => {
    const files = await generateSystemFiles(MUTATING);
    const wf = bySuffix(files, "workflows/move_money.ex");

    // The two loaded aggregate args route to their context mutating fns, in
    // service-body order — byte-identical to an INLINE `s.withdraw(amount)`
    // op-call (`{:ok, _} <- Context.<op>_<agg>(<arg>, %{"<param>" => ...})`).
    // The params map is keyed by the called op's REAL parameter name as a
    // string key (`"amount"`), matching the facade's `Map.get(params, "amount")`
    // read.  Each discards (`{:ok, _}`) since neither arg is read again (already
    // persisted inside the context fn); the result falls back to the load bind `d`.
    expect(wf).toContain('{:ok, _} <- Context.withdraw_account(s, %{"amount" => amount})');
    expect(wf).toContain('{:ok, _} <- Context.deposit_account(d, %{"amount" => amount})');

    // The clauses sit inside the same with-chain as the loads (one Repo.transaction).
    expect(wf).toMatch(
      /with \{:ok, s\} <- Context\.get_account\(src\),\s*\{:ok, d\} <- Context\.get_account\(dst\),\s*\{:ok, _\} <- Context\.withdraw_account\(s, %\{"amount" => amount\}\),\s*\{:ok, _\} <- Context\.deposit_account\(d, %\{"amount" => amount\}\) do/,
    );

    // The atomic, persisted commit is the workflow's Repo.transaction.
    expect(wf).toContain("Repo.transaction(fn ->");

    // No inert placeholder, and no leftover Domain.Services service-module call.
    expect(wf).not.toContain("_ = Api.Domain.Services.Transfer.run");
    expect(wf).not.toContain("Domain.Services.Transfer");
  });

  it("destructures the workflow's scalar param so the inlined clause resolves", async () => {
    const files = await generateSystemFiles(MUTATING);
    const wf = bySuffix(files, "workflows/move_money.ex");
    // `amount` is referenced only through the service call args; it must be
    // bound off run/1 (the pre-Slice-3 placeholder left it undefined).
    expect(wf).toContain(`"amount" => amount`);
  });

  it("persistence happens INSIDE the context mutating fns (Repo.update via persist_change)", async () => {
    const files = await generateSystemFiles(MUTATING);
    const context = bySuffix(files, "/accounts.ex");
    // The context fns the with-chain calls each build a changeset and persist —
    // the per-aggregate mutation+persist seam, not an orchestrator exit-save.
    expect(context).toContain("def withdraw_account(%Api.Accounts.Account{} = record, params)");
    expect(context).toContain("def deposit_account(%Api.Accounts.Account{} = record, params)");
    expect(context).toContain("AccountRepository.persist_change()");
  });

  it("keeps a sibling PURE service op as a standalone Domain.Services module (byte-identical shell)", async () => {
    const files = await generateSystemFiles(MUTATING);
    // A pure op alongside the mutating one still emits its module — the mutating
    // skip must not regress pure placement.
    const fee = bySuffix(files, "domain/services/fee_quote.ex");
    expect(
      fee,
    ).toBe(`# Auto-generated — stateless pure-calculator domain service (domain-services.md).
defmodule Api.Domain.Services.FeeQuote do
  @moduledoc false

  @spec for_amount(map()) :: map()
  def for_amount(amount) do
    %{amount: Map.get(amount, :amount, Map.get(amount, "amount")), currency: Map.get(amount, :currency, Map.get(amount, "currency"))}
  end
end
`);
  });
});
