// Regression: the Drizzle schema's id/FK columns must use the same Postgres
// type the migration declares.
//
// A Loom `id`-typed field (and the aggregate PK / containment FK / join-table
// FK) is `UUID` in the generated migration (via `idColumnType(guid) -> UUID`),
// but the Drizzle schema emitter hardcoded `text(...)` for them — while an
// explicit `guid` field correctly used `uuid(...)`.  So the query builder typed
// id columns as `text` against `uuid` DB columns (works only because Postgres
// coerces unknown params; a latent `operator does not exist: uuid = text`
// hazard, and an internal inconsistency within the same table).
//
// id columns now map by their value type, mirroring the migration's
// `idColumnType`: guid -> uuid, int -> integer, long -> bigint, string -> text.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Acme {
  subdomain Sales {
    context S {
      aggregate Engineer { handle: string }
      repository Engineers for Engineer { }
      aggregate Project {
        name: string
        owner: Engineer id
        contains pipelines: Pipeline[]
        entity Pipeline { label: string }
      }
      repository Projects for Project { }
    }
  }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource sState { for: S, kind: state, use: primarySql }
  deployable api {
    platform: node
    contexts: [S]
    dataSources: [sState]
    serves: SalesApi
    port: 3001
  }
}
`;

describe("hono drizzle schema — id columns are uuid, matching the migration", () => {
  it("aggregate PK, the `X id` reference, and the containment FK all use uuid()", async () => {
    const files = await generateSystemFiles(SRC);
    const schema = [...files.entries()].find(([p]) => p.endsWith("db/schema.ts"))?.[1];
    expect(schema, "db/schema.ts").toBeDefined();
    // Aggregate PK.
    expect(schema).toContain('id: uuid("id").primaryKey()');
    // `owner: Engineer id` reference field.
    expect(schema).toContain('uuid("owner")');
    // Containment part FK back to the parent (project_id).
    expect(schema).toContain('uuid("project_id")');
    // No id column should be declared as text.
    expect(schema).not.toContain('text("id").primaryKey()');
    expect(schema).not.toContain('text("project_id")');
  });
});
