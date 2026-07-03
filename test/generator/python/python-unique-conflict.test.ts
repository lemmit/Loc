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
  });
});
