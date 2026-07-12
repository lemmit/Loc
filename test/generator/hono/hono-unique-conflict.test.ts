// ---------------------------------------------------------------------------
// Hono backend — a `unique (...)` domain invariant derives a Postgres unique
// index; a breach surfaces as a Postgres 23505 unique_violation.  The router's
// `app.onError` must map it to a friendly 409 Conflict instead of a raw 500.
//
// The subtlety this pins: drizzle-orm (the v5 zod-4 stack pins >= the
// DrizzleQueryError era) WRAPS the driver error, so the pg SQLSTATE rides
// `err.cause.code`, not `err.code`.  Reading only `err.code` (undefined on the
// wrapper) silently fell through to the 500 fallback — a genuine duplicate 500'd
// instead of 409 (caught only once the conformance suite actually ran under
// auth).  The onError arm therefore reads BOTH shapes.
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
    platform: node
    contexts: [People]
    dataSources: [peopleState]
    serves: PeopleApi
    port: 3000
  }
}
`;

describe("Hono generator — unique breach maps to 409 (drizzle-wrapped)", () => {
  it("onError reads the SQLSTATE off err.cause (wrapped) AND err.code (raw), maps 23505 → 409", async () => {
    const router = [...(await generateSystemFiles(SRC)).entries()].find(([k]) =>
      k.endsWith("/person.routes.ts"),
    )?.[1];
    expect(router, "person.routes.ts missing").toBeTruthy();

    // The 23505 guard unwraps `err.cause.code` (DrizzleQueryError) as well as
    // `err.code` (an unwrapped/older driver) — the fix for the silent 500.
    expect(router).toContain(
      '(((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code) === "23505")',
    );
    // The reported constraint name is likewise read off either shape.
    expect(router).toContain(
      "(err as { constraint?: string }).constraint ?? (err as { cause?: { constraint?: string } }).cause?.constraint",
    );
    // Friendly 409 Conflict problem response.
    expect(router).toContain(
      'return problem(409, "Conflict", `A Person with these values already exists.`);',
    );
    // Regression guard: never the bare `err.code`-only check that misses the
    // wrapped driver error.
    expect(router).not.toContain('(err as { code?: string }).code === "23505"');
  });
});
