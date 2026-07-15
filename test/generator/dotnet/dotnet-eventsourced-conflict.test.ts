// ---------------------------------------------------------------------------
// .NET / ASP.NET + EF Core — the event-sourced concurrency rider.  An
// event-sourced (`persistedAs: eventLog`) aggregate appends event entities to
// an append-only `<agg>_events` table keyed by a `(stream_id, version)`
// PRIMARY KEY.  A concurrent append that loses the version race hits a Postgres
// unique-violation (SQLSTATE 23505): EF surfaces it as a DbUpdateException with
// a PostgresException inner.  The event-store SaveAsync translates that to the
// EF DbUpdateConcurrencyException the DomainExceptionFilter already maps to 409
// Conflict with the distinct `conflict` catalog event — reusing the `versioned`
// machinery.
//
// A plain relational, non-versioned aggregate is byte-identical (no
// DbUpdateConcurrencyException arm), so the rider is gated on the aggregate
// being event-sourced OR versioned.
//
// Sibling of dotnet-concurrency-conflict.test.ts (the `versioned`
// IsConcurrencyToken → 409); this is the event-log-append → 409.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const ES = `
system Bank {
  subdomain Ledger {
    context Accounts {
      event Opened { account: Account id, owner: string }
      event Deposited { account: Account id, amount: int }

      aggregate Account persistedAs: eventLog {
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
    platform: dotnet
    contexts: [Accounts]
    dataSources: [accountsLog]
    serves: LedgerApi
    port: 5000
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
    platform: dotnet
    contexts: [Ordering]
    dataSources: [ordState]
    serves: SalesApi
    port: 5000
  }
}
`;

const at = (files: Map<string, string>, suffix: string): string => {
  const entry = [...files.entries()].find(([p]) => p.endsWith(suffix));
  expect(entry, `${suffix} missing`).toBeDefined();
  return entry![1];
};

describe(".NET generator — event-sourced concurrency rider", () => {
  it("event-store SaveAsync translates a 23505 DbUpdateException to DbUpdateConcurrencyException", async () => {
    const repo = at(
      await generateSystemFiles(ES),
      "Infrastructure/Repositories/AccountRepository.cs",
    );
    expect(repo).toContain("catch (Microsoft.EntityFrameworkCore.DbUpdateException __ex)");
    expect(repo).toContain(
      'when (__ex.InnerException is Npgsql.PostgresException { SqlState: "23505" })',
    );
    expect(repo).toContain("throw new Microsoft.EntityFrameworkCore.DbUpdateConcurrencyException(");
  });

  it("DomainExceptionFilter maps DbUpdateConcurrencyException to 409 with the `conflict` event", async () => {
    const filter = at(await generateSystemFiles(ES), "Api/DomainExceptionFilter.cs");
    expect(filter).toContain(
      "context.Exception is Microsoft.EntityFrameworkCore.DbUpdateConcurrencyException",
    );
    expect(filter).toContain('"conflict"');
    expect(filter).toContain('409, "Conflict"');
  });

  // Versioning is default-on (M-T3.4): a plain relational aggregate is versioned
  // even without `with versioned`, so it too gets the DbUpdateConcurrencyException
  // → 409 `conflict` arm (via the IsConcurrencyToken machinery rather than the
  // event-log-append race, but the same filter arm). The event-sourced aggregate
  // above is unchanged — its (stream_id, version) stream is its concurrency
  // control. There is no non-versioned relational opt-out to be byte-identical.
  it("a plain relational aggregate is versioned by default (has the 409 arm)", async () => {
    const filter = at(await generateSystemFiles(RELATIONAL), "Api/DomainExceptionFilter.cs");
    expect(filter).toContain("DbUpdateConcurrencyException");
    expect(filter).toContain('"conflict"');
  });
});
