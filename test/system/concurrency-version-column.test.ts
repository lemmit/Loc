// `with versioned` → the state table carries a `version INTEGER NOT NULL
// DEFAULT 1` column (uniqueness/optimistic-concurrency, versioned-capability.ts).
// The column is derived ONCE in the shared MigrationsIR builder
// (migrations-builder.ts, gated on `aggregateIsVersioned`) and rendered by every
// backend that owns schema migrations: Postgres DDL via `sql-pg` (TS/.NET/Java/
// Python) and the Ecto migration for Phoenix.  The `DEFAULT 1` is what keeps the
// ADD COLUMN non-destructive (a NOT NULL add WITH a default doesn't trip the
// destructive-migration gate).  A NON-versioned aggregate has no version column.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const nodeSystem = (cap: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Customer ${cap} {
          email: string
          name: string
        }
        repository Customers for Customer { }
      }
    }
    api SalesApi from Sales
    storage primarySql { type: postgres }
    resource ordState { for: Ordering, kind: state, use: primarySql }
    deployable api {
      platform: node
      contexts: [Ordering]
      dataSources: [ordState]
      serves: SalesApi
      port: 3001
    }
  }
`;

const elixirSystem = (cap: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Customer ${cap} {
          email: string
          name: string
        }
        repository Customers for Customer { }
      }
    }
    deployable api {
      platform: elixir { foundation: vanilla }
      contexts: [Ordering]
    }
  }
`;

const sqlOf = (files: Map<string, string>): string =>
  [...files.entries()]
    .filter(([p]) => p.endsWith(".sql"))
    .map(([, c]) => c)
    .join("\n");

describe("versioned → Postgres version column DDL", () => {
  it("emits `version INTEGER NOT NULL DEFAULT 1` on the state table", async () => {
    const files = await generateSystemFiles(nodeSystem("with versioned"));
    // Identifiers are quote-always in the DDL; assert quote-agnostically.
    expect(sqlOf(files)).toMatch(/"?version"? INTEGER NOT NULL DEFAULT 1/);
  });

  it("emits no version column when the aggregate is not versioned", async () => {
    const files = await generateSystemFiles(nodeSystem(""));
    expect(sqlOf(files)).not.toMatch(/"?version"?\s+INTEGER/);
  });
});

describe("versioned → Ecto version column", () => {
  it("adds the version column with default: 1 in the create migration", async () => {
    const files = await generateSystemFiles(elixirSystem("with versioned"));
    const migration = [...files.entries()].find(
      ([p]) => p.includes("priv/repo/migrations/") && p.endsWith("create_customers.exs"),
    )?.[1];
    expect(migration, "create_customers.exs").toBeDefined();
    expect(migration).toContain(":version");
    expect(migration).toContain("default: 1");
  });

  it("adds no version column when the aggregate is not versioned", async () => {
    const files = await generateSystemFiles(elixirSystem(""));
    const migration = [...files.entries()].find(
      ([p]) => p.includes("priv/repo/migrations/") && p.endsWith("create_customers.exs"),
    )?.[1];
    expect(migration, "create_customers.exs").toBeDefined();
    expect(migration).not.toContain(":version");
  });
});
