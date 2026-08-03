// Every backend's `audit_records` writer agrees with the shared descriptor.
//
// The table is emitted six ways — the platform-neutral DDL (MigrationsIR), the
// Hono Drizzle `pgTable`, the MikroORM entity, the EF Core POCO, the JPA entity
// and the Dapper `DbSchema` CREATE TABLE — and each used to carry its own
// hand-written column list.
//
// They drifted, and it cost two CI legs.  `before` / `after` are NULLABLE (a
// `create` has no before-state, a `destroy` has no after-state, and every writer
// passes `null` on exactly those paths), but the Drizzle schema declared them
// `.notNull()` and the MikroORM entity `nullable: false`.  Because
// `web/src/runtime/ddl.ts` synthesises the behavioral DDL from the DRIZZLE
// schema rather than from the migration, those inserts hit a NOT NULL violation
// — on a backend whose own emitted `.sql` said the opposite.
//
// `util/audit-records-table.ts` now holds the facts; this gate holds the
// emitters to them.  Same pure-data-mirror + consistency-test pattern as
// `adapter-metadata.ts` / `adapter-metadata-consistency.test.ts`: the rendering
// stays per-backend (each has its own type vocabulary and casing), only the
// column set and the nullability are shared — because that is what broke.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";
import {
  AUDIT_RECORD_COLUMNS,
  AUDIT_RECORDS_PK,
  AUDIT_RECORDS_TABLE,
} from "../../src/util/audit-records-table.js";
import { expectEmitted } from "../_helpers/emitted.js";

async function build(source: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(source, { validation: true });
  const syntax = doc.parseResult?.parserErrors ?? [];
  if (syntax.length) throw new Error(`fixture syntax error: ${syntax[0]?.message}`);
  return doc.parseResult?.value as Model;
}

/** An audited aggregate on one backend + persistence adapter. */
const sys = (platform: string): string => `
system S {
  subdomain O {
    context O {
      aggregate Doc audited {
        name: string
        create(name: string) { name := name }
        operation rename(name: string) audited { name := name }
        destroy { }
      }
      repository Docs for Doc { }
    }
  }
  api A from O
  storage pg { type: postgres }
  resource st { for: O, kind: state, use: pg }
  deployable d {
    platform: ${platform}
    contexts: [O]
    dataSources: [st]
    serves: A
    port: 4000
  }
}`;

const NULLABLE = AUDIT_RECORD_COLUMNS.filter((c) => c.nullable);
const NOT_NULL = AUDIT_RECORD_COLUMNS.filter((c) => !c.nullable);

describe("audit_records agrees with the shared descriptor", () => {
  it("the emitted Postgres DDL matches column-for-column", async () => {
    const files = generateSystems(await build(sys("node"))).files;
    const sql = [...files.entries()].find(([p]) => p.includes("migrations") && p.endsWith(".sql"));
    expect(sql, "no migration emitted").toBeDefined();
    const ddl = sql![1];
    const table = ddl.slice(ddl.indexOf(`CREATE TABLE "${AUDIT_RECORDS_TABLE}"`));
    const body = table.slice(0, table.indexOf(");"));

    for (const c of AUDIT_RECORD_COLUMNS) {
      expect(body, `column '${c.column}' missing from DDL`).toContain(`"${c.column}"`);
      // The DDL spells nullability explicitly, so it can be read back exactly.
      const line = body.split("\n").find((l) => l.includes(`"${c.column}"`));
      expect(line, `no DDL line for '${c.column}'`).toBeDefined();
      if (c.nullable) {
        expect(line, `'${c.column}' should be NULL in the DDL`).toMatch(/\bNULL\b/);
        expect(line, `'${c.column}' should not be NOT NULL`).not.toMatch(/NOT NULL/);
      } else {
        expect(line, `'${c.column}' should be NOT NULL in the DDL`).toMatch(/NOT NULL/);
      }
    }
  });

  it("the Hono Drizzle table matches — the copy that broke behavioral", async () => {
    const files = generateSystems(await build(sys("node"))).files;
    const schema = expectEmitted(files, "d/db/schema.ts");
    const block = schema.slice(schema.indexOf("export const auditRecords"));
    const table = block.slice(0, block.indexOf("}, (t)"));

    for (const c of AUDIT_RECORD_COLUMNS) {
      // Match on the opening `("<col>"` only — a column with options spells
      // `timestamp("at", { withTimezone: true })`, so requiring the closing
      // paren would miss it.
      const line = table.split("\n").find((l) => l.includes(`("${c.column}"`));
      expect(line, `drizzle column '${c.column}' missing`).toBeDefined();
      if (c.column === AUDIT_RECORDS_PK) {
        // A primary key is NOT NULL by definition, so the emitter spells
        // `.primaryKey()` and not `.notNull()` — both are correct, and the
        // constraint is stronger.
        expect(line, "the PK column must declare primaryKey()").toContain(".primaryKey()");
        continue;
      }
      // `.notNull()` present iff the descriptor says NOT NULL.  This is the
      // exact assertion that would have caught the original drift.
      expect(
        line!.includes(".notNull()"),
        `drizzle '${c.column}': .notNull() should be ${!c.nullable}`,
      ).toBe(!c.nullable);
    }
    // Belt and braces on the two that actually regressed.
    expect(table).toContain('before: jsonb("before"),');
    expect(table).toContain('after: jsonb("after"),');
  });

  it("the MikroORM entity matches", async () => {
    const files = generateSystems(await build(sys("node { persistence: mikroorm }"))).files;
    const entities = [...files.entries()].find(([, v]) => v.includes("AuditRecordRow"));
    expect(entities, "no MikroORM entity emitted").toBeDefined();
    const src = entities![1];
    const block = src.slice(src.indexOf("AuditRecordRow"));

    for (const c of NULLABLE) {
      // Nullable columns declare it; the emitter spells `nullable: true`.
      const decl = block.slice(block.indexOf(`${c.prop}:`));
      expect(decl.slice(0, 120), `mikroorm '${c.prop}' should be nullable`).toContain(
        "nullable: true",
      );
    }
  });

  it("the .NET EF entity matches (nullable reference types)", async () => {
    const files = generateSystems(await build(sys("dotnet"))).files;
    const poco = expectEmitted(files, "d/Infrastructure/Persistence/AuditRecord.cs");
    for (const c of AUDIT_RECORD_COLUMNS) {
      const prop = c.prop[0]!.toUpperCase() + c.prop.slice(1);
      const line = poco.split("\n").find((l) => l.includes(` ${prop} `));
      expect(line, `EF property '${prop}' missing`).toBeDefined();
      // EF infers requiredness from the reference type's nullability, so `?`
      // IS the nullability declaration — a non-nullable `string` becomes a NOT
      // NULL column.  Only reference-typed (text/json) columns participate;
      // `at` is a value type (DateTime) and carries no `?`.
      if (c.type === "datetime") continue;
      expect(line!.includes("?"), `EF '${prop}': nullable should be ${c.nullable}`).toBe(
        c.nullable,
      );
    }
  });

  it("the Dapper DbSchema CREATE TABLE matches", async () => {
    const files = generateSystems(await build(sys("dotnet { persistence: dapper }"))).files;
    const schema = expectEmitted(files, "d/Infrastructure/Persistence/DbSchema.cs");
    const table = schema.slice(schema.indexOf(`CREATE TABLE IF NOT EXISTS ${AUDIT_RECORDS_TABLE}`));
    const body = table.slice(0, table.indexOf(");"));

    for (const c of AUDIT_RECORD_COLUMNS) {
      const line = body.split("\n").find((l) => l.trim().startsWith(c.column));
      expect(line, `dapper column '${c.column}' missing`).toBeDefined();
      if (c.column === AUDIT_RECORDS_PK) {
        // Same as drizzle: `primary key` already implies NOT NULL.
        expect(line, "the PK column must declare primary key").toMatch(/primary key/i);
        continue;
      }
      expect(
        /\bnot null\b/i.test(line!),
        `dapper '${c.column}': not-null should be ${!c.nullable}`,
      ).toBe(!c.nullable);
    }
  });

  it("the descriptor itself is coherent", () => {
    // Guards the guard: a descriptor that accidentally listed everything as
    // nullable (or nothing) would make every assertion above pass trivially.
    expect(NULLABLE.length).toBeGreaterThan(0);
    expect(NOT_NULL.length).toBeGreaterThan(0);
    expect(new Set(AUDIT_RECORD_COLUMNS.map((c) => c.column)).size).toBe(
      AUDIT_RECORD_COLUMNS.length,
    );
    // The two that regressed must stay nullable — the reason this file exists.
    for (const name of ["before", "after"]) {
      expect(AUDIT_RECORD_COLUMNS.find((c) => c.column === name)?.nullable).toBe(true);
    }
  });
});
