// ---------------------------------------------------------------------------
// .NET backend — a `unique (...)` domain invariant derives a Postgres unique
// index; a breach surfaces as a Postgres 23505 unique_violation.  EF Core
// wraps it in a `Microsoft.EntityFrameworkCore.DbUpdateException`; the Dapper
// adapter throws the bare `Npgsql.PostgresException`.  The DomainExceptionFilter
// must catch both and return a friendly 409 Conflict instead of a raw 500.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Directory {
  context People {
    aggregate Person {
      email: string
      name: string
      unique (email)
    }
    repository People for Person {}
  }
  api PeopleApi from People
  storage primary { type: postgres }
  resource peopleState { for: People, kind: state, use: primary }
  deployable api {
    platform: dotnet
    contexts: [People]
    dataSources: [peopleState]
    serves: PeopleApi
    port: 8081
  }
}
`;

describe(".NET generator — unique breach maps to 409", () => {
  it("DomainExceptionFilter maps a Postgres 23505 unique_violation to 409 Conflict", async () => {
    const filter = (await generateSystemFiles(SRC)).get("api/Api/DomainExceptionFilter.cs")!;
    expect(filter, "DomainExceptionFilter.cs missing").toBeTruthy();

    // Bare Npgsql (Dapper path) + EF-wrapped DbUpdateException (EF path).
    expect(filter).toContain('context.Exception is Npgsql.PostgresException { SqlState: "23505" }');
    expect(filter).toContain(
      "context.Exception is Microsoft.EntityFrameworkCore.DbUpdateException due",
    );
    expect(filter).toContain(
      'due.InnerException is Npgsql.PostgresException { SqlState: "23505" }',
    );

    // Friendly 409 Conflict problem response.
    expect(filter).toContain(
      'context.Result = Problem(context, 409, "Conflict", "A resource with these values already exists.", trace_id);',
    );
  });
});
