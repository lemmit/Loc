import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// Vanilla (Ecto/Phoenix, non-Ash) foundation — a `unique (...)` domain
// invariant maps a Postgres unique_violation (SQLSTATE 23505) to HTTP 409
// Conflict, cross-backend parity with the Hono 23505 → 409 mapping
// (uniqueness-and-indexes.md, D-UNIQUE-DB-AUTHORITATIVE).
//
// Two emitter surfaces cooperate, both under src/generator/elixir/vanilla/:
//   1. The per-aggregate Changeset adds `unique_constraint/3` tied to the SAME
//      deterministic index name the migration emits (`<table>_<cols>_uq`), so
//      the DB violation surfaces as `{:error, changeset}` (a `constraint:
//      :unique` error) instead of raising `Ecto.ConstraintError` → 500.
//   2. `<App>Web.ProblemDetails.validation_error_response/2` — the single
//      changeset-error chokepoint every write path funnels through — routes a
//      unique-constraint changeset to 409 Conflict (else the usual 422).

const SOURCE = `
system Acme {
  subdomain Accounts {
    context Users {
      aggregate User with crudish {
        email: string
        name: string
        unique (email)
      }
      repository Users for User { }
    }
  }
  api UsersApi from Accounts
  storage primary { type: postgres }
  resource usersState { for: Users, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Users]
    dataSources: [usersState]
    serves: UsersApi
    port: 4000
  }
}
`;

describe("vanilla — unique (...) → 409 Conflict", () => {
  it("changeset adds unique_constraint tied to the migration index name", async () => {
    const files = await generateSystemFiles(SOURCE);
    const cs = files.get([...files.keys()].find((k) => k.endsWith("user_changeset.ex"))!)!;
    expect(cs).toBeDefined();
    // The constraint name is the deterministic `<plural(snake(agg))>_<snake(cols)>_uq`
    // — byte-identical to the Ecto migration's `create index(..., name: ...)`.
    expect(cs).toContain('|> unique_constraint(:email, name: "users_email_uq")');
  });

  it("migration and changeset reference the SAME constraint name", async () => {
    const files = await generateSystemFiles(SOURCE);
    const migration = files.get(
      [...files.keys()].find((k) => k.includes("migrations/") && k.endsWith("_create_users.exs"))!,
    )!;
    expect(migration).toBeDefined();
    expect(migration).toContain("unique: true");
    expect(migration).toContain('name: "users_email_uq"');
  });

  it("ProblemDetails routes a unique-constraint changeset to 409 Conflict", async () => {
    const files = await generateSystemFiles(SOURCE);
    const pd = files.get([...files.keys()].find((k) => k.endsWith("_web/problem_details.ex"))!)!;
    expect(pd).toBeDefined();

    // The changeset-error chokepoint branches on a unique-constraint error.
    expect(pd).toContain("if unique_conflict?(changeset) do");
    expect(pd).toContain("problem_response(");
    expect(pd).toContain("409,");
    expect(pd).toContain('"Conflict",');

    // The predicate keys off Ecto's `constraint: :unique` error tag (added by
    // `unique_constraint/3` when the DB reports 23505), which plain validation
    // errors never carry.
    expect(pd).toContain("defp unique_conflict?(%Ecto.Changeset{errors: errors}) do");
    expect(pd).toContain("Keyword.get(opts, :constraint) == :unique");

    // A non-unique validation failure still funnels to the 422 envelope.
    expect(pd).toContain("validation_failed_response(conn, changeset)");
    expect(pd).toContain("status: 422");
  });
});
