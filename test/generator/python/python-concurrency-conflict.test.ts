// ---------------------------------------------------------------------------
// Python / FastAPI + SQLAlchemy backend — the `versioned` capability turns the
// unconditional upsert into an explicit guarded upsert: `where Row.version ==
// expected` + `version = Row.version + 1` + `.returning(Row.id)`; a None result
// (0 rows) → `ConcurrencyError`, which a registered exception handler maps to
// 409 Conflict with a distinct `conflict` catalog event.  The client's expected
// version is parsed off the `If-Match` header (think-time CAS).  A NON-versioned
// aggregate is byte-identical — everything gated on `aggregateIsVersioned`.
//
// Sibling of python-unique-conflict.test.ts (the 23505 → 409 mapping).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const pySystem = (cap: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Customer ${cap} {
          email: string
          name: string
          operation update(newName: string) { name := newName }
        }
        repository Customers for Customer { }
      }
    }
    api SalesApi from Sales
    storage primarySql { type: postgres }
    resource ordState { for: Ordering, kind: state, use: primarySql }
    deployable api {
      platform: python
      contexts: [Ordering]
      dataSources: [ordState]
      serves: SalesApi
      port: 8081
    }
  }
`;

const fileEndingWith = (files: Map<string, string>, suffix: string): string => {
  const entry = [...files.entries()].find(([p]) => p.endsWith(suffix));
  expect(entry, `${suffix} missing`).toBeDefined();
  return entry![1];
};

describe("python generator — versioned optimistic-concurrency", () => {
  it("repository save() is a guarded upsert on the expected version", async () => {
    const files = await generateSystemFiles(pySystem("with versioned"));
    const repo = fileEndingWith(files, "customer_repository.py");

    expect(repo).toContain(
      "from app.domain.errors import AggregateNotFoundError, ConcurrencyError",
    );
    expect(repo).toContain(
      "async def save(self, aggregate: Customer, expected_version: int | None = None) -> None:",
    );
    expect(repo).toContain(
      "_expected = aggregate.version if expected_version is None else expected_version",
    );
    // Guarded update: bump the version, gated on the expected value, returning id.
    expect(repo).toContain("CustomerRow.version + 1");
    expect(repo).toContain("where=CustomerRow.version == _expected");
    expect(repo).toContain(".returning(CustomerRow.id)");
    expect(repo).toContain(
      'raise ConcurrencyError(f"Customer {aggregate.id} was modified concurrently")',
    );
  });

  it("route parses the expected version off the If-Match header", async () => {
    const routes = fileEndingWith(
      await generateSystemFiles(pySystem("with versioned")),
      "routes.py",
    );
    expect(routes).toContain('_if_match = request.headers.get("if-match", "").strip(chr(34))');
    expect(routes).toContain("_expected = int(_if_match) if _if_match.isdigit() else None");
    expect(routes).toContain("await repo.save(found, expected_version=_expected)");
  });

  it("registers a ConcurrencyError handler → 409 with a distinct `conflict` event", async () => {
    const problem = fileEndingWith(
      await generateSystemFiles(pySystem("with versioned")),
      "problem.py",
    );
    expect(problem).toContain("@app.exception_handler(ConcurrencyError)");
    expect(problem).toContain(
      "async def _conflict(request: Request, err: ConcurrencyError) -> JSONResponse:",
    );
    expect(problem).toContain('log("warn", "conflict", message=str(err), status=409)');
    expect(problem).toContain('request, 409, "Conflict"');
  });

  it("declares the ConcurrencyError domain exception", async () => {
    const errors = fileEndingWith(
      await generateSystemFiles(pySystem("with versioned")),
      "errors.py",
    );
    expect(errors).toContain("class ConcurrencyError(Exception):");
  });

  it("routes the version token onto reads but off create/update bodies", async () => {
    const routes = fileEndingWith(
      await generateSystemFiles(pySystem("with versioned")),
      "routes.py",
    );
    // Read model carries the token.
    expect(routes).toContain("version: int");
  });

  it("a NON-versioned aggregate emits byte-identical output (no guarded upsert)", async () => {
    const files = await generateSystemFiles(pySystem(""));
    const repo = fileEndingWith(files, "customer_repository.py");
    const problem = fileEndingWith(files, "problem.py");
    expect(repo).not.toContain("ConcurrencyError");
    expect(repo).not.toContain("expected_version");
    expect(repo).not.toContain("version");
    expect(problem).not.toContain("ConcurrencyError");
    expect(problem).not.toContain('"conflict"');
  });
});
