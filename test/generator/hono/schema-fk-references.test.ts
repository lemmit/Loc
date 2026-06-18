// Regression: a containment part's Drizzle schema must agree with the migration
// on the FK — same index NAME and an explicit `.references()`.
//
// The part table's parent FK column is `<parent>_id` (e.g. `project_id`), but
// the schema named its index `<table>_parent_id_idx` (literal "parent_id") while
// the migration creates `<table>_project_id_idx` + `FOREIGN KEY … REFERENCES …
// ON DELETE CASCADE`.  The schema also omitted `.references()`.  Loom ships its
// own SQL migrations (so the DB is correct either way), but the Drizzle schema's
// FK/index metadata drifted from it — aligned here for consistency.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Acme {
  subdomain Sales {
    context S {
      aggregate Project {
        name: string
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

describe("hono drizzle schema — containment FK matches the migration", () => {
  it("indexes the FK by its real column name and declares .references()", async () => {
    const files = await generateSystemFiles(SRC);
    const schema = [...files.entries()].find(([p]) => p.endsWith("db/schema.ts"))?.[1];
    expect(schema, "db/schema.ts").toBeDefined();
    // Index name uses the real FK column (`project_id`), matching the migration.
    expect(schema).toContain('index("pipelines_project_id_idx")');
    expect(schema).not.toContain('index("pipelines_parent_id_idx")');
    // The FK is declared so Drizzle's metadata mirrors the migration's
    // FOREIGN KEY … ON DELETE CASCADE.
    expect(schema).toMatch(
      /parentId:\s*uuid\("project_id"\)\.notNull\(\)\.references\(\(\) => projects\.id, \{ onDelete: "cascade" \}\)/,
    );
  });
});
