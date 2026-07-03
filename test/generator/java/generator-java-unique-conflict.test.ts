// ---------------------------------------------------------------------------
// Java backend — a `unique (...)` domain invariant derives a Postgres unique
// index; a breach surfaces as a Postgres 23505 unique_violation, which
// Spring's JdbcTemplate/JPA translate into a DataIntegrityViolationException.
// The RFC 7807 advice must catch that and return a friendly 409 Conflict
// instead of a bare 500.
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
  deployable dirApi {
    platform: java
    contexts: [People]
    dataSources: [peopleState]
    serves: PeopleApi
    port: 8081
  }
}
`;

const ROOT = "dir_api/src/main/java/com/loom/dirapi";

describe("java generator — unique breach maps to 409", () => {
  it("advice registers a DataIntegrityViolationException → 409 handler", async () => {
    const advice = (await generateSystemFiles(SRC)).get(`${ROOT}/api/ApiExceptionAdvice.java`)!;
    expect(advice).toContain("import org.springframework.dao.DataIntegrityViolationException;");
    expect(advice).toContain("@ExceptionHandler(DataIntegrityViolationException.class)");
    expect(advice).toContain(
      'return respond(problem(409, "Conflict", "A resource with these values already exists.", request), 409);',
    );
    expect(advice).toContain(
      'CatalogLog.event("disallowed", "warn", "message", "A resource with these values already exists.", "status", 409);',
    );
  });
});
