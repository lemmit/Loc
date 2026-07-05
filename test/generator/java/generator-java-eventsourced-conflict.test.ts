// ---------------------------------------------------------------------------
// Java / Spring Boot — the event-sourced concurrency rider.  An event-sourced
// (`persistedAs(eventLog)`) aggregate appends to an append-only `<agg>_events`
// table keyed by a `(stream_id, version)` PRIMARY KEY.  A concurrent append
// that loses the version race hits a Postgres unique-violation (SQLSTATE
// 23505), which Spring's JdbcTemplate translates to DuplicateKeyException; the
// event-store repository catches it and rethrows the SAME
// ObjectOptimisticLockingFailureException the `versioned` service raises, which
// the ApiExceptionAdvice maps to 409 Conflict with the distinct `conflict`
// catalog event.
//
// A plain relational, non-versioned aggregate is byte-identical (no
// ObjectOptimisticLockingFailureException arm), so the rider is gated on the
// aggregate being event-sourced OR versioned.
//
// Sibling of generator-java-concurrency-conflict.test.ts (the `versioned`
// @Version → 409); this is the event-log-append → 409.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const ES = `
system Bank {
  subdomain Ledger {
    context Accounts {
      event Opened { account: Account id, owner: string }
      event Deposited { account: Account id, amount: int }

      aggregate Account ids guid persistedAs(eventLog) {
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
    platform: java
    contexts: [Accounts]
    dataSources: [accountsLog]
    serves: LedgerApi
    port: 8080
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
    platform: java
    contexts: [Ordering]
    dataSources: [ordState]
    serves: SalesApi
    port: 8080
  }
}
`;

const at = (files: Map<string, string>, suffix: string): string => {
  const entry = [...files.entries()].find(([p]) => p.endsWith(suffix));
  expect(entry, `${suffix} missing`).toBeDefined();
  return entry![1];
};

describe("java generator — event-sourced concurrency rider", () => {
  it("append site catches DuplicateKeyException and rethrows the optimistic-lock failure", async () => {
    const impl = at(await generateSystemFiles(ES), "AccountRepositoryImpl.java");
    expect(impl).toContain("} catch (org.springframework.dao.DuplicateKeyException e) {");
    expect(impl).toContain(
      "throw new org.springframework.orm.ObjectOptimisticLockingFailureException(",
    );
    expect(impl).toContain("Account.class, aggregate.id().value());");
  });

  it("ApiExceptionAdvice maps the optimistic-lock failure to 409 with the `conflict` event", async () => {
    const advice = at(await generateSystemFiles(ES), "ApiExceptionAdvice.java");
    expect(advice).toContain(
      "@ExceptionHandler(org.springframework.orm.ObjectOptimisticLockingFailureException.class)",
    );
    expect(advice).toContain('CatalogLog.event("conflict", "warn"');
    expect(advice).toContain('problem(409, "Conflict"');
    expect(advice).toContain(
      "import org.springframework.orm.ObjectOptimisticLockingFailureException;",
    );
  });

  it("a plain relational, non-versioned aggregate is byte-identical (no 409 arm)", async () => {
    const advice = at(await generateSystemFiles(RELATIONAL), "ApiExceptionAdvice.java");
    expect(advice).not.toContain("ObjectOptimisticLockingFailureException");
    expect(advice).not.toContain('CatalogLog.event("conflict"');
  });
});
