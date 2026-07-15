import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// ES applier folds over value-object / enum fields (P4.3).  Vanilla stores
// value objects as plain JSON maps (no struct module), so an inline VO
// constructor in an applier fold must build a map — `%Ctx.VO{…}` would
// reference an undefined struct and fail `mix compile`.  Enum assignments
// already render as the stored string.
// ---------------------------------------------------------------------------

const SRC = `
system L {
  subdomain Core {
    context Accounts {
      valueobject Money { amount: int  currency: string }
      enum Status { active  closed }
      event Opened { account: Account id }
      event Funded { account: Account id, m: Money }
      aggregate Account persistedAs: eventLog {
        status: Status
        balance: Money
        create open() { emit Opened { account: id } }
        operation fund(m: Money) { emit Funded { account: id, m: m } }
        apply(e: Opened) {
          status := active
          balance := Money { amount: 0, currency: "USD" }
        }
        apply(e: Funded) { balance := e.m }
      }
      repository Accounts for Account { }
    }
  }
  api A from Core
  storage pg { type: postgres }
  resource acctlog { for: Accounts, kind: eventLog, use: pg }
  deployable api {
    platform: elixir
    contexts: [Accounts]
    dataSources: [acctlog]
    serves: A
    port: 4000
  }
}
`;

describe("vanilla — ES applier folds over VO / enum fields (P4.3)", () => {
  it("inline value-object construction folds to a plain map, not a struct", async () => {
    const files = await generateSystemFiles(SRC);
    const fold = files.get(
      [...files.keys()].find((k) => k.endsWith("/accounts/account_fold.ex"))!,
    )!;
    // VO ctor → map (no undefined `%Api.Accounts.Money{}` struct reference).
    expect(fold).toContain('balance: %{amount: 0, currency: "USD"}');
    expect(fold).not.toContain("%Api.Accounts.Money{");
    // enum value → the declared-case atom (the in-memory fold builds the struct
    // whose Ecto.Enum field is the atom; serialization dumps it back to "active").
    // Unquoted — value names are identifiers; `:"active"` would warn under -Werror.
    expect(fold).toContain("status: :active");
    // a VO copied straight off the event still threads through unchanged.
    expect(fold).toContain("balance: e.m");
  });

  it("a value-object event field types as map() (no undefined VO module ref)", async () => {
    const files = await generateSystemFiles(SRC);
    const ev = files.get([...files.keys()].find((k) => k.endsWith("/events/funded.ex"))!)!;
    expect(ev).toContain("m: map()");
    expect(ev).not.toContain("Money.t()");
  });
});
