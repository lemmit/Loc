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

  it("indents the fall-through domain-fault counter to its block (no IndentationError)", async () => {
    const problem = (await generateSystemFiles(UNIQUE)).get("api/app/http/problem.py")!;
    // The 23505 branch's `record_domain_fault` is nested under the `if` (12
    // spaces); the FALL-THROUGH one after the `if` must sit at the handler-body
    // level (8 spaces) with its sibling `log`/`return`.  A 12-space over-indent
    // there is `IndentationError: unexpected indent` — the module won't import
    // and the FastAPI backend never boots.
    expect(problem).toContain(
      '        log("warn", "disallowed", message=str(err), status=409)\n' +
        '        record_domain_fault("disallowed")\n' +
        '        return problem(request, 409, "Conflict", "The request conflicts with the current state.")',
    );
    // The exact bug shape — an 8-space `log` immediately followed by a 12-space
    // `record_domain_fault` — must never be emitted.
    expect(problem).not.toMatch(/\n {8}log\([^\n]*\n {12}record_domain_fault/);
  });
});
