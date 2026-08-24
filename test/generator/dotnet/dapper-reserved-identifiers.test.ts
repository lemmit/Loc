// .NET Dapper backend — reserved-word identifier quoting (M-T6.42).
//
// WHY THIS EXISTS ALONGSIDE `schema-load`.  The two halves of this fix fail in
// different places and only one of them has a cheap oracle:
//
//   - the DDL half is gated by `schema-load`'s dapper leg, which `psql -f`s the
//     emitted `DbSchema.Sql` into a real Postgres.  Nothing else needed.
//   - the DML half — SELECT / INSERT / ON CONFLICT / WHERE / ORDER BY — is a
//     C# STRING.  It compiles whatever it contains, `schema-load` never
//     executes it, and no per-PR tier boots this adapter against a database.
//     So a fix that quoted only the schema would leave every query broken while
//     every gate stayed green, which is strictly worse than the original defect
//     (the stack would start, then fail on first read).
//
// This pins the DML half, clause position by clause position, and pins that the
// UNRESERVED columns are untouched — the whole argument for quoting only the
// reserved words is that existing output does not move.

import { describe, expect, it } from "vitest";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

// `order` / `group` / `limit` are Postgres reserved words; `total` is the
// control.  All four are valid C# identifiers, so the row DTO is not the
// subject here — the SQL is.
const SOURCE = (persistence: string) => `
system ReservedSys {
  subdomain Sales {
    context Orders {
      aggregate Ticket with crudish {
        order: int
        group: string
        limit: int
        total: money
      }
      repository Tickets for Ticket {
        find byGroup(g: string): Ticket[] where group == g
      }
      criterion Live of Ticket as t = t.limit > 0
      retrieval OpenByOrder() of Ticket {
        where: Live
        sort:  [order asc]
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg, index: [Ticket.group] }
  deployable d {
    platform: dotnet { persistence: ${persistence} }
    contexts: [Orders]
    dataSources: [st]
    serves: SalesApi
    port: 4000
  }
}`;

const REPO = "d/Infrastructure/Repositories/TicketRepository.cs";
const SCHEMA = "d/Infrastructure/Persistence/DbSchema.cs";

describe("Dapper quotes reserved-word identifiers", () => {
  it("quotes them in every DML clause position, escaped for a C# regular literal", async () => {
    const src = (await generateSystemFiles(SOURCE("dapper"))).get(REPO)!;

    // The SQL lives in `new CommandDefinition("…")` — a REGULAR C# literal — so
    // a quote has to arrive as `\"`.  A bare `"` would end the literal and the
    // file would not compile; `""` would be the VERBATIM spelling and is wrong
    // here.  Asserting the escaped form is what keeps the two contexts apart.
    const q = '\\"';

    // SELECT column list (by id, by ids, and the paged read).
    expect(src).toContain(
      `SELECT id, ${q}order${q}, ${q}group${q}, ${q}limit${q}, total, version FROM tickets WHERE id = @id`,
    );
    // INSERT column list AND the ON CONFLICT … DO UPDATE SET assignments — the
    // upsert names each column twice, on both sides of `= excluded.`.
    expect(src).toContain(
      `INSERT INTO tickets (id, ${q}order${q}, ${q}group${q}, ${q}limit${q}, total, version)`,
    );
    expect(src).toContain(`SET ${q}order${q} = excluded.${q}order${q}`);
    // A find's WHERE — `whereToSql`'s column arm.
    expect(src).toContain(`FROM tickets WHERE (${q}group${q} = @g)`);
    // A retrieval's WHERE + ORDER BY.
    expect(src).toContain(`WHERE (${q}limit${q} > 0) ORDER BY ${q}order${q} ASC`);
    // The paged `findAll` sort allowlist: the KEY is the wire sort name and
    // stays bare, the VALUE is spliced into `ORDER BY {sortColumn}` and is
    // therefore an identifier.  This one is invisible to every other check —
    // it only breaks when a caller actually sorts by that column.
    expect(src).toContain(`"order" => "${q}order${q}"`);

    // The CONTROL: an unreserved column is never quoted, anywhere.  This is the
    // whole justification for reserved-only quoting — existing output does not
    // move — so it is an assertion, not an assumption.
    expect(src).not.toContain(`${q}total${q}`);
    expect(src).not.toContain(`${q}id${q}`);
    expect(src).not.toContain(`${q}version${q}`);
    // Dapper PARAMETERS are not identifiers and must stay bare, or the
    // parameter object's property names stop matching.
    expect(src).toContain("@order");
    expect(src).not.toContain(`@${q}order${q}`);
  });

  it("quotes them in the self-applied DDL, in the VERBATIM spelling", async () => {
    const src = (await generateSystemFiles(SOURCE("dapper"))).get(SCHEMA)!;
    // `public const string Sql = @"…"` is a verbatim literal: a quote is `""`
    // and a backslash is just a backslash.  The DML's `\"` spelling here would
    // put a literal backslash into the SQL Postgres receives.
    expect(src).toContain('""order"" integer not null');
    expect(src).toContain('""group"" text not null');
    expect(src).toContain('""limit"" integer not null');
    expect(src).toContain("total numeric not null");
    expect(src).not.toContain('\\"order\\"');
  });

  it("leaves the EF Core adapter alone — it quotes through its own provider", async () => {
    const files = await generateSystemFiles(SOURCE("efcore"));
    // EF builds its own SQL and quotes identifiers itself, so nothing in this
    // fix should reach it.  There is no DbSchema at all on that adapter.
    expect(files.has(SCHEMA)).toBe(false);
    const repo = files.get(REPO)!;
    expect(repo).not.toContain('\\"order\\"');
  });
});
