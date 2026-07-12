// ---------------------------------------------------------------------------
// Hono / Drizzle backend — the event-sourced concurrency rider.  An
// event-sourced (`persistedAs(eventLog)`) aggregate appends to an append-only
// `<agg>_events` table keyed by a `(stream_id, version)` PRIMARY KEY.  Two
// concurrent `save`s that both read `max(version)=N` and both insert
// `version=N+1` race; the loser hits a Postgres unique-violation (SQLSTATE
// 23505).  The repository's append site catches that and rethrows the shared
// `ConcurrencyError`, which the router's `onError` maps to 409 Conflict with
// the distinct `conflict` catalog event — reusing the `versioned` machinery.
//
// A plain relational, non-versioned aggregate is byte-identical (no
// ConcurrencyError anywhere), so the whole rider is gated on the aggregate
// being event-sourced OR versioned.
//
// Sibling of typescript-concurrency-conflict.test.ts (the `versioned` guarded
// write → 409); this is the event-log-append → 409.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const esSystem = (platform: string) => `
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
    storage primarySql { type: postgres }
    resource accountsLog { for: Accounts, kind: eventLog, use: primarySql }
    deployable api {
      platform: ${platform}
      contexts: [Accounts]
      dataSources: [accountsLog]
      serves: LedgerApi
      port: 3001
    }
  }
`;

// A plain relational, non-versioned aggregate — the byte-identical negative.
const relationalSystem = `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Customer {
          email: string
          name: string
        }
        repository Customers for Customer { }
      }
    }
    api SalesApi from Sales
    storage primarySql { type: postgres }
    resource ordState { for: Ordering, kind: state, use: primarySql }
    deployable api {
      platform: node
      contexts: [Ordering]
      dataSources: [ordState]
      serves: SalesApi
      port: 3001
    }
  }
`;

const fileEndingWith = (files: Map<string, string>, suffix: string): string => {
  const entry = [...files.entries()].find(([p]) => p.endsWith(suffix));
  expect(entry, `${suffix} missing`).toBeDefined();
  return entry![1];
};

describe("hono/drizzle generator — event-sourced concurrency rider", () => {
  it("append site catches a 23505 unique-violation and rethrows ConcurrencyError", async () => {
    const files = await generateSystemFiles(esSystem("node"));
    const repo = fileEndingWith(files, "account-repository.ts");

    // The append is wrapped so a duplicate (stream_id, version) → ConcurrencyError.
    expect(repo).toContain("await this.db.insert(schema.accountEvents).values(rows);");
    expect(repo).toContain('(err as { code?: string }).code === "23505"');
    expect(repo).toContain('throw new ConcurrencyError("Account", aggregate.id as string);');
    // ConcurrencyError is imported from the domain errors module.
    expect(repo).toContain(
      'import { AggregateNotFoundError, ConcurrencyError } from "../../domain/errors";',
    );
  });

  it("onError maps ConcurrencyError to 409 Conflict with the distinct `conflict` event", async () => {
    const routes = fileEndingWith(await generateSystemFiles(esSystem("node")), "account.routes.ts");
    expect(routes).toContain("if (err instanceof ConcurrencyError) {");
    expect(routes).toContain('event: "conflict", aggregate: "Account"');
    expect(routes).toContain('return problem(409, "Conflict", err.message);');
  });

  it("emits the ConcurrencyError class in domain/errors.ts", async () => {
    const files = await generateSystemFiles(esSystem("node"));
    const errors = fileEndingWith(files, "domain/errors.ts");
    expect(errors).toContain("export class ConcurrencyError extends Error {");
  });

  it("a plain relational, non-versioned aggregate is byte-identical (no 409 arm)", async () => {
    const files = await generateSystemFiles(relationalSystem);
    const repo = fileEndingWith(files, "customer-repository.ts");
    const routes = fileEndingWith(files, "customer.routes.ts");
    expect(repo).not.toContain("ConcurrencyError");
    expect(routes).not.toContain("ConcurrencyError");
    expect(routes).not.toContain('event: "conflict"');
    // No ConcurrencyError class is emitted for a concurrency-free project.
    expect([...files.keys()].some((p) => p.endsWith("domain/errors.ts"))).toBe(true);
    const errors = fileEndingWith(files, "domain/errors.ts");
    expect(errors).not.toContain("ConcurrencyError");
  });
});
