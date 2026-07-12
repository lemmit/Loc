// ---------------------------------------------------------------------------
// Python / FastAPI + SQLAlchemy — the event-sourced concurrency rider.  An
// event-sourced (`persistedAs(eventLog)`) aggregate appends to an append-only
// `<agg>_events` table keyed by a `(stream_id, version)` PRIMARY KEY.  A
// concurrent append that loses the version race hits a Postgres unique-
// violation (SQLSTATE 23505), which SQLAlchemy wraps in IntegrityError; the
// repository catches it at the append site and raises the shared
// ConcurrencyError, which the app's exception handler maps to 409 Conflict
// with the distinct `conflict` catalog event.
//
// A plain relational, non-versioned aggregate is byte-identical (no
// ConcurrencyError), so the rider is gated on the aggregate being
// event-sourced OR versioned.
//
// Sibling of python-concurrency-conflict.test.ts (the `versioned` guarded
// write → 409); this is the event-log-append → 409.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

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
    platform: python
    contexts: [Accounts]
    dataSources: [accountsLog]
    serves: LedgerApi
    port: 8000
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
    platform: python
    contexts: [Ordering]
    dataSources: [ordState]
    serves: SalesApi
    port: 8000
  }
}
`;

const at = (files: Map<string, string>, suffix: string): string => {
  const entry = [...files.entries()].find(([p]) => p.endsWith(suffix));
  expect(entry, `${suffix} missing`).toBeDefined();
  return entry![1];
};

describe("python generator — event-sourced concurrency rider", () => {
  it("append site catches IntegrityError (SQLSTATE 23505) and raises ConcurrencyError", async () => {
    const files = await generateSystemFiles(ES);
    const repo = at(files, "repositories/account_repository.py");
    expect(repo).toContain("except IntegrityError as err:");
    expect(repo).toContain('getattr(getattr(err, "orig", None), "sqlstate", None) == "23505"');
    expect(repo).toContain(
      'raise ConcurrencyError(f"Account {aggregate.id} was modified concurrently") from err',
    );
    expect(repo).toContain("from sqlalchemy.exc import IntegrityError");
    expect(repo).toContain(
      "from app.domain.errors import AggregateNotFoundError, ConcurrencyError",
    );
  });

  it("registers a ConcurrencyError handler mapping to 409 with the `conflict` event", async () => {
    const problem = at(await generateSystemFiles(ES), "app/http/problem.py");
    expect(problem).toContain("@app.exception_handler(ConcurrencyError)");
    expect(problem).toContain('log("warn", "conflict", message=str(err), status=409)');
    expect(problem).toContain('409, "Conflict"');
  });

  it("emits the ConcurrencyError class in app/domain/errors.py", async () => {
    const errors = at(await generateSystemFiles(ES), "app/domain/errors.py");
    expect(errors).toContain("class ConcurrencyError(Exception):");
  });

  it("a plain relational, non-versioned aggregate is byte-identical (no handler)", async () => {
    const files = await generateSystemFiles(RELATIONAL);
    const repo = at(files, "repositories/customer_repository.py");
    const problem = at(files, "app/http/problem.py");
    const errors = at(files, "app/domain/errors.py");
    expect(repo).not.toContain("ConcurrencyError");
    expect(problem).not.toContain("ConcurrencyError");
    expect(errors).not.toContain("ConcurrencyError");
  });
});
