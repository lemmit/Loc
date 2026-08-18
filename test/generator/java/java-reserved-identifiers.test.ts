// Java (Spring Boot + JPA) backend — reserved-word identifier quoting (M-T6.43).
//
// The sibling of `dotnet/dapper-reserved-identifiers.test.ts`, one backend over,
// and the reason this needs its own gate is that the Java defect is QUIETER than
// the Dapper one it mirrors:
//
//   - the DDL is Flyway's, derived from `MigrationsIR` through `sql-pg.ts`,
//     which quotes ALWAYS.  So the table is created with a perfectly good
//     `"order"` column and `schema-load` is green.
//   - the mapping is a Java STRING in an annotation.  `gradle bootJar` compiles
//     whatever it contains, so `java-build` and `corpus-java-build` are green.
//   - Hibernate derives the SQL from that mapping at RUNTIME, so the first
//     insert is a syntax error — a 500 that only a booted backend can see.
//
// Every compile-tier gate was therefore blind to it, which is exactly how it
// survived M-T6.42 (found there against a real booted Spring Boot + Postgres,
// filed as M-T6.43, deliberately not fixed).  `run-java.mjs reserved-words` is
// the runtime proof; this is the fast per-PR pin on the same emission.
//
// WHAT MAKES THE JAVA SPELLING DIFFERENT.  Two of the three positions below
// take different quote characters, and getting either wrong is silent:
//
//   - a MAPPING annotation takes a Hibernate identifier, whose portable quote
//     is the BACKTICK — Hibernate re-renders it as the dialect's quote
//     character.  Writing `\"order\"` there would make the identifier literally
//     contain the quote characters.
//   - `@SQLRestriction` takes a raw SQL fragment Hibernate appends verbatim, so
//     it needs Postgres' own `"order"`.
//   - `@AttributeOverride(name = …)` is a Java PROPERTY PATH, not an identifier,
//     and must stay bare or the mapping stops resolving.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

async function build(source: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper<Model>(services.Ddd)(source, { validation: true });
  const errs = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  expect(
    errs.map((d) => d.message),
    "source validation errors",
  ).toEqual([]);
  return doc.parseResult.value;
}

// `order` / `group` / `limit` / `column` are Postgres reserved words; `total`
// is the control.  The `X id` reference (`column: Person id`) is there to
// separate the two annotation shapes — a scalar rides a bare `@Column`, a typed id rides
// `@AttributeOverride(name = "value", column = @Column(...))`, and only the
// inner `@Column` is an identifier.  `end` sits inside a value object so the
// FLATTENED column (`window_end`) can be shown to stay unquoted.
const SOURCE = `
system ReservedSys {
  subdomain Sales {
    context Orders {
      valueobject Span { start: datetime  end: datetime }
      aggregate Person with crudish { name: string }
      repository People for Person { }
      criterion Live of Ticket = this.limit > 0
      aggregate Ticket with crudish {
        order: int
        group: string
        limit: int
        total: money
        column: Person id
        window: Span
        filter Live
      }
      repository Tickets for Ticket {
        find byGroup(g: string): Ticket[] where group == g
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d {
    platform: java
    contexts: [Orders]
    dataSources: [st]
    serves: SalesApi
    port: 4000
  }
}`;

const ENTITY = "d/src/main/java/com/loom/d/features/tickets/Ticket.java";

describe("the Java backend quotes reserved-word columns", () => {
  it("backtick-quotes them in the JPA mapping annotations, and only there", async () => {
    const src = generateSystems(await build(SOURCE)).files.get(ENTITY)!;

    // Scalars — the plain `@Column` arm.
    expect(src).toContain('@Column(name = "`order`")');
    expect(src).toContain('@Column(name = "`group`")');
    expect(src).toContain('@Column(name = "`limit`")');

    // A typed id reference (`column: Person id`) rides an embeddable: the OUTER
    // `name = "value"` is the Java property path inside the id record and stays
    // bare; the INNER `@Column` is the identifier and is quoted.  Getting this
    // pair backwards is the failure mode the shape exists to pin.
    expect(src).toContain(
      '@AttributeOverride(name = "value", column = @Column(name = "`column`"))',
    );

    // The CONTROL — unreserved columns are untouched.  Reserved-only quoting is
    // justified entirely by "existing output does not move", so that is an
    // assertion here rather than an assumption.
    expect(src).toContain('@Column(name = "total")');
    expect(src).toContain('@AttributeOverride(name = "value", column = @Column(name = "id"))');
    expect(src).not.toContain("`total`");
    expect(src).not.toContain("`id`");
    // `end` is a reserved word, but the value object FLATTENS it to
    // `window_end`, which is not — a compound name can never collide, so it
    // must not pick up quotes either.
    expect(src).toContain('@Column(name = "window_end")');
    expect(src).not.toContain("`window_end`");
    // The table name is `plural(snake(...))` and unreserved here — pinned so a
    // future "quote everything" reading of this fix is visible.
    expect(src).toContain('@Table(name = "tickets"');
  });

  it("uses POSTGRES quoting — not backticks — in the raw-SQL @SQLRestriction", async () => {
    const src = generateSystems(await build(SOURCE)).files.get(ENTITY)!;
    // A capability `filter` becomes a static WHERE fragment Hibernate appends
    // to every SELECT verbatim — raw SQL, so the column takes POSTGRES quotes.
    // A backtick here would reach the server as a literal backtick and every
    // read on this entity would be a syntax error, which is why the two
    // spellings are asserted against each other rather than one in isolation.
    expect(src).toContain('@SQLRestriction("\\"limit\\" > 0")');
    expect(src).not.toContain('@SQLRestriction("`');
  });
});
