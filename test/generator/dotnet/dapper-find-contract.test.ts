// ---------------------------------------------------------------------------
// Two contract holes in the Dapper repository emitter (audit 2026-08-24):
//
// A18 — the EVENT-SOURCED Dapper repo rendered its find methods without the
//   trailing `User currentUser` parameter the shared repository INTERFACE
//   declares for a `currentUser`-referencing find (emit/repository.ts), and
//   without `using <ns>.Auth`.  The class then did not implement its own
//   interface (CS0535) and the rendered predicate's `currentUser` bound to
//   nothing (CS0103) — `dotnet build` fails.  The relational and document
//   Dapper repos, and the EF event-sourced twin, all thread it correctly.
//
// A19 — a relational single-row DECLARED find (`find byX(): T?`) used
//   `QuerySingleOrDefaultAsync` with no `LIMIT 1`.  The predicate need not be
//   unique, so two matching rows are LEGAL data: Dapper throws
//   `InvalidOperationException` → 500, where EF / node / java / python all
//   return the first match.  `GetByIdAsync` is keyed on the primary key and
//   deliberately keeps the strict single-row read.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const ES_SRC = `
system Ledger {
  user { id: string owner: string }
  subdomain Core {
    context Accounts {
      event Opened { account: Account id, owner: string }
      event Deposited { account: Account id, amount: int }

      aggregate Account persistedAs: eventLog {
        owner: string
        balance: int

        create open(owner: string) {
          emit Opened { account: id, owner: owner }
        }
        operation deposit(amount: int) {
          precondition amount > 0
          emit Deposited { account: id, amount: amount }
        }

        apply(e: Opened) { owner := e.owner  balance := 0 }
        apply(e: Deposited) { balance := balance + e.amount }
      }

      repository Accounts for Account {
        find mine(): Account? where this.owner == currentUser.owner
      }
    }
  }
  storage pg { type: postgres }
  resource accountsLog { for: Accounts, kind: eventLog, use: pg }
  deployable api {
    platform: dotnet { persistence: dapper }
    contexts: [Accounts]
    dataSources: [accountsLog]
    port: 4000
    auth: required
  }
}
`;

const REL_SRC = `
system Shop {
  subdomain Core {
    context Catalog {
      aggregate Product {
        sku: string
        name: string
      }
      repository Products for Product {
        find bySku(sku: string): Product? where this.sku == sku
      }
    }
  }
  storage pg { type: postgres }
  resource st { for: Catalog, kind: state, use: pg }
  deployable api {
    platform: dotnet { persistence: dapper }
    contexts: [Catalog]
    dataSources: [st]
    port: 4000
  }
}
`;

describe("dapper repository — find signature + single-row contract", () => {
  it("A18: the event-sourced repo's currentUser find keeps the interface's `User currentUser` param", async () => {
    const files = await generateSystemFiles(ES_SRC);
    const iface = files.get("api/Domain/Accounts/IAccountRepository.cs")!;
    const impl = files.get("api/Infrastructure/Repositories/AccountRepository.cs")!;
    // The declared contract — the impl must match it exactly, or CS0535.
    expect(iface).toContain(
      "Task<Account?> Mine(User currentUser, CancellationToken cancellationToken = default);",
    );
    expect(impl).toContain(
      "public async Task<Account?> Mine(User currentUser, CancellationToken cancellationToken = default)",
    );
    // `User` is a named type living in `<ns>.Auth` — without the using, CS0246.
    expect(impl).toContain("using Api.Auth;");
    // …and the body reads the parameter it now declares (CS0103 otherwise).
    expect(impl).toContain("currentUser.Owner");
  });

  it("A19: a relational optional find reads the FIRST row, with LIMIT 1 pushed to the database", async () => {
    const files = await generateSystemFiles(REL_SRC);
    const impl = files.get("api/Infrastructure/Repositories/ProductRepository.cs")!;
    expect(impl).toContain(
      'var r = await conn.QueryFirstOrDefaultAsync<Row>(new CommandDefinition("SELECT id, sku, name, version FROM products WHERE (sku = @sku) LIMIT 1"',
    );
    // A second matching row must not be able to throw: the strict single-row
    // read may survive ONLY on the PK-keyed GetById.
    const strict = [
      ...impl.matchAll(/QuerySingleOrDefaultAsync<Row>\(new CommandDefinition\("([^"]*)"/g),
    ];
    expect(strict.map((m) => m[1])).toEqual([
      "SELECT id, sku, name, version FROM products WHERE id = @id",
    ]);
  });
});
