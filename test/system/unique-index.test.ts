// `unique (...)` → derived DB unique index (uniqueness-and-indexes.md §4).
// The DB unique index is the enforcement contract (D-UNIQUE-DB-AUTHORITATIVE),
// derived once in the shared MigrationsIR builder and rendered by every
// backend that owns schema migrations.  Verified here through the generated
// output: the Postgres DDL (shared by TS/.NET/Java/Python via `sql-pg`), the
// partial predicate under `softDeletable`, and the Hono 23505 → 409 mapping.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const nodeSystem = (agg: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        ${agg}
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

const sqlOf = (files: Map<string, string>): string =>
  [...files.entries()]
    .filter(([p]) => p.endsWith(".sql"))
    .map(([, c]) => c)
    .join("\n");

describe("unique (...) → Postgres unique index DDL", () => {
  it("derives a UNIQUE INDEX with the deterministic `<table>_<cols>_uq` name", async () => {
    const files = await generateSystemFiles(
      nodeSystem(`aggregate Customer { email: string  name: string  unique (email) }`),
    );
    // Identifiers are quote-always in the DDL (audit A1); assert quote-agnostically.
    expect(sqlOf(files)).toMatch(/CREATE UNIQUE INDEX "?customers_email_uq"?/);
  });

  it("derives a composite UNIQUE INDEX over the listed columns in order", async () => {
    const files = await generateSystemFiles(
      nodeSystem(
        `aggregate Customer { tenantId: string  email: string  unique (tenantId, email) }`,
      ),
    );
    expect(sqlOf(files)).toMatch(/CREATE UNIQUE INDEX "?customers_tenant_id_email_uq"?/);
    expect(sqlOf(files)).toMatch(
      /customers_tenant_id_email_uq"? ON \S+ \("?tenant_id"?, "?email"?\)/,
    );
  });

  it("makes the index PARTIAL under softDeletable (re-create after soft-delete)", async () => {
    const files = await generateSystemFiles(
      nodeSystem(
        `aggregate Customer with softDeletable, softDelete { email: string  unique (email) }`,
      ),
    );
    expect(sqlOf(files)).toMatch(
      /CREATE UNIQUE INDEX "?customers_email_uq"? ON \S+ \("?email"?\) WHERE is_deleted = false;/,
    );
  });

  it("emits no unique index when the aggregate declares no `unique` key", async () => {
    const files = await generateSystemFiles(
      nodeSystem(`aggregate Customer { email: string  name: string }`),
    );
    expect(sqlOf(files)).not.toContain("_uq");
    expect(sqlOf(files)).not.toContain("CREATE UNIQUE INDEX");
  });
});

const elixirSystem = (agg: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        ${agg}
        repository Customers for Customer { }
      }
    }
    deployable api {
      platform: elixir
      contexts: [Ordering]
    }
  }
`;

describe("unique (...) → Ecto unique index", () => {
  it("emits a named unique index, partial under softDeletable", async () => {
    const files = await generateSystemFiles(
      elixirSystem(
        `aggregate Customer with softDeletable, softDelete { email: string  unique (email) }`,
      ),
    );
    const migration = [...files.entries()].find(
      ([p]) => p.includes("priv/repo/migrations/") && p.endsWith("create_customers.exs"),
    )?.[1];
    expect(migration, "create_customers.exs").toBeDefined();
    expect(migration).toContain("unique: true");
    expect(migration).toContain('where: "is_deleted = false"');
    expect(migration).toContain('name: "customers_email_uq"');
  });
});

describe("unique (...) → Hono 23505 conflict mapping", () => {
  it("maps a PG unique_violation to 409 Conflict in the router's onError", async () => {
    const files = await generateSystemFiles(
      nodeSystem(`aggregate Customer { email: string  unique (email) }`),
    );
    const routes = [...files.entries()].find(([p]) => p.endsWith("customer.routes.ts"))?.[1];
    expect(routes, "customer.routes.ts").toBeDefined();
    // Reads the SQLSTATE off `err.cause.code` (drizzle wraps the driver error)
    // as well as the raw `err.code`, so a genuine breach 409s instead of 500ing.
    expect(routes).toContain(
      '(((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code) === "23505")',
    );
    expect(routes).toMatch(/return problem\(409, "Conflict",/);
  });
});
