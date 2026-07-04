// Generator coverage for the `reading`-tier `domainService` on the Phoenix /
// Elixir (vanilla Ecto) backend — domain-services.md rev. 4, Slice 1.
//
// Elixir is the structural OUTLIER (sim §2.5, decision B — ambient `Repo`):
//   - a PURE service op stays a standalone `<App>.Domain.Services.<Name>`
//     module fn (byte-identical to the pre-rev.4 shell), but
//   - a single-context READING service op lowers to a CONTEXT FUNCTION on its
//     aggregate's context module (`Api.Accounts.is_email_available/1`) so it
//     has the ambient `Repo` — there is NO read-port handle to thread.
//   - the body's repo read renders against the sibling context-facade find fn
//     (`by_holder_account/1`), unwrapping `{:ok, value}`.
//   - the orchestrating workflow's call site has NO handle argument
//     (`Context.is_email_available(source)`).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** A Banking system with a `reading` service (`Registration.isEmailAvailable`,
 *  reads the `Accounts.byHolder` find), a `pure` service (`FeeQuote`), and a
 *  workflow calling the reading service in a precondition.  Params are
 *  `source`/`dest` per the slice-1 convention (`from`/`to` are reserved). */
const SRC = `
system Banking {
  subdomain Accounts {
    context Accounts {
      valueobject Money {
        amount: decimal
        currency: string
        invariant amount >= 0
      }
      aggregate Account ids guid with crudish {
        holder: string
        balance: Money
      }
      repository Accounts for Account {
        find byHolder(holder: string): Account? where this.holder == holder
      }
      domainService Registration {
        operation isEmailAvailable(holder: string): bool {
          return Accounts.byHolder(holder) == null
        }
      }
      domainService FeeQuote {
        operation forAmount(amount: Money): Money {
          return Money { amount: amount.amount, currency: amount.currency }
        }
      }
      workflow RegisterAccount transactional {
        create(source: string, dest: Money) {
          precondition Registration.isEmailAvailable(source)
          let acct = Account.create({ holder: source, balance: dest })
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

describe("phoenix vanilla — reading-tier domainService (domain-services.md rev. 4)", () => {
  it("places a single-context reading op as a CONTEXT FUNCTION, not a Domain.Services module", async () => {
    const files = await generateSystemFiles(SRC);

    // A reading-only service emits NO standalone Domain.Services module.
    expect(maybeBySuffix(files, "domain/services/registration.ex")).toBeUndefined();

    // It lands on the aggregate's context module instead.
    const context = bySuffix(files, "/accounts.ex");
    expect(context).toContain("def is_email_available(holder) do");
    // No Domain.Services prefix inside the context fn.
    expect(context).not.toContain("Domain.Services.Registration");
  });

  it("renders the repo read against the ambient context find fn, unwrapping {:ok, value}", async () => {
    const files = await generateSystemFiles(SRC);
    const context = bySuffix(files, "/accounts.ex");
    // `Accounts.byHolder(holder) == null` → is_nil over the unwrapped value of
    // the sibling `by_holder_account/1` context find fn (ambient Repo).
    expect(context).toContain("by_holder_account(holder)");
    expect(context).toContain("{:ok, value} -> value");
    expect(context).toContain("is_nil(");
    // No read-port handle param — the ambient Repo is free (decision B).
    expect(context).toMatch(/def is_email_available\(holder\) do/);
  });

  it("keeps a PURE service op as a standalone Domain.Services module (byte-identical shell)", async () => {
    const files = await generateSystemFiles(SRC);
    const fee = bySuffix(files, "domain/services/fee_quote.ex");
    expect(fee).toContain("defmodule Api.Domain.Services.FeeQuote do");
    expect(fee).toContain("def for_amount(amount) do");
    // The pure shell is exactly the pre-rev.4 standalone-module shape — no
    // ambient-Repo / context-fn machinery leaks into a pure service.
    expect(fee).not.toContain("by_holder");
    expect(fee).not.toContain("Repo");
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

  it("calls the reading service from the workflow with NO handle argument", async () => {
    const files = await generateSystemFiles(SRC);
    const wf = bySuffix(files, "workflows/register_account.ex");
    // The call site names the context fn directly (aliased `Context`), passing
    // only the user arg — no read-port handle, no Domain.Services prefix.
    expect(wf).toContain("Context.is_email_available(source)");
    expect(wf).not.toContain("Domain.Services.Registration");
    expect(wf).not.toContain("is_email_available(accounts");
  });
});
