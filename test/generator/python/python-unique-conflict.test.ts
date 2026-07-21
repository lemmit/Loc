import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// A `unique (...)` domain invariant derives a Postgres unique index; a breach
// surfaces as a driver unique_violation (SQLSTATE 23505) wrapped in
// SQLAlchemy's IntegrityError.  The generated FastAPI app must map that to a
// friendly 409 Conflict instead of a raw 500.
const UNIQUE = `
  system US {
    subdomain D { context Sales {
      aggregate Customer {
        email: string
        unique (email)
      }
      repository Customers for Customer { }
    }}
    api A from D
    storage primary { type: postgres }
    resource st { for: Sales, kind: state, use: primary }
    deployable api { platform: python, contexts: [Sales], dataSources: [st], serves: A, port: 8081 }
  }
`;

describe("python generator — unique_violation → 409", () => {
  it("registers an IntegrityError handler that maps SQLSTATE 23505 to 409", async () => {
    const files = await generateSystemFiles(UNIQUE);
    const problem = files.get("api/app/http/problem.py")!;
    expect(problem, "problem.py missing").toBeTruthy();

    // Imports the SQLAlchemy wrapper.
    expect(problem).toContain("from sqlalchemy.exc import IntegrityError");

    // Registers a typed handler for it.
    expect(problem).toContain("@app.exception_handler(IntegrityError)");
    expect(problem).toContain(
      "async def _integrity(request: Request, err: IntegrityError) -> JSONResponse:",
    );

    // Detects the unique_violation SQLSTATE via the driver `.orig`.
    expect(problem).toContain('getattr(getattr(err, "orig", None), "sqlstate", None)');
    expect(problem).toContain('if sqlstate == "23505":');

    // Returns a friendly 409 Conflict.
    expect(problem).toContain(
      'return problem(\n                request, 409, "Conflict", "A resource with these values already exists."\n            )',
    );

    // The non-23505 fallback path's fault counter sits at the handler-body
    // indent (8 spaces) — an over-indented line here is an IndentationError
    // that crashes the app at import (the parity gate's python_api boot).
    expect(problem).toContain(
      '        log("warn", "disallowed", message=str(err), status=409)\n        record_domain_fault("disallowed")\n        return problem(request, 409, "Conflict",',
    );
    expect(problem).not.toMatch(/\n {9,}record_domain_fault\("disallowed"\)\n {8}return/);
  });
});
