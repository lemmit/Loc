// Generator coverage for the `mutating` tier of `domainService` on the .NET /
// ASP.NET + EF Core backend (domain-services.md rev. 4, Slice 2).
//
// A `mutating` service mutates the aggregate args the orchestrator passes in
// (their own ops).  The workflow loads the targets, calls the static service,
// and persists the mutated args.  The passed-in entities are EF change-tracked,
// so they flush at the single `await db.SaveChangesAsync()` (here the
// transaction commit); the explicit `SaveAsync(...)` is harmless / needed for
// a newly-created aggregate.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Banking {
    aggregate Account with crudish {
      holder: string
      balance: decimal
      operation withdraw(amount: decimal) {
        balance := balance - amount
      }
      operation deposit(amount: decimal) {
        balance := balance + amount
      }
    }
    repository Accounts for Account { }
    domainService Transfer {
      operation run(source: Account, dest: Account, amount: decimal) {
        source.withdraw(amount)
        dest.deposit(amount)
      }
    }
    workflow MoveMoney transactional {
      create(src: Account id, dst: Account id, amount: decimal) {
        let s = Accounts.getById(src)
        let d = Accounts.getById(dst)
        Transfer.run(s, d, amount)
      }
    }
  }
`;

describe(".NET generator — mutating-tier domainService (domain-services.md rev. 4)", () => {
  it("calls the static service and saves the mutated args inside the transaction", async () => {
    const handler = (await generateDotnet(await parseValid(SRC))).get(
      "Application/Workflows/MoveMoneyHandler.cs",
    )!;
    expect(handler).toBeDefined();
    // The aggregate args passed to the service are load-or-throw (guarded), so
    // the non-null `Account` params don't trip CS8604 under /warnaserror.
    expect(handler).toMatch(
      /var s = await _accounts\.GetByIdAsync[\s\S]*\?\? throw new AggregateNotFoundException/,
    );
    // The static service is called with the loaded aggregate args (PascalCased).
    expect(handler).toContain("Transfer.Run(s, d, command.Amount);");
    // The mutated aggregate args persist; EF flushes the tracked entities at
    // the transaction commit (the explicit save covers new aggregates).
    expect(handler).toMatch(/await _accounts\.SaveAsync\(s, cancellationToken\);/);
    expect(handler).toMatch(/await _accounts\.SaveAsync\(d, cancellationToken\);/);
    // The scalar (read-only) arg is never saved.
    expect(handler).not.toContain("SaveAsync(command.Amount");
    // The saves sit inside the begun transaction, committed once.
    expect(handler).toMatch(/BeginTransactionAsync[\s\S]*SaveAsync\(s[\s\S]*CommitAsync/);
  });
});
