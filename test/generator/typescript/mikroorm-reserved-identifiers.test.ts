// node/MikroORM adapter — reserved-word identifier quoting inside `raw()`
// fragments (F2-ADP-6, the node twin of M-T6.42's Dapper fix).
//
// A queryable scalar intrinsic (`startsWith`, `trim`, `abs`, `round`, …) cannot
// be said in MikroORM's FilterQuery operator vocabulary, so it reaches SQL
// through a `raw("<sql>", [<params>])` KEY — and the column identifier is
// INLINED into that string (only VALUES bind).  A column named after a Postgres
// reserved word (`end`, `group`, `limit`) therefore produced `starts_with(end,
// $1)`, a syntax error on the first request.
//
// Nothing else catches it: the fragment is a TS string literal, so `tsc
// --noEmit` and `tsup` are blind, and MikroORM's own `updateSchema()` quotes
// the column when it CREATES it — the table is fine and only the query breaks.
// The sibling adapters already get this right (drizzle interpolates the schema
// column object, dapper quotes explicitly), so this pins the third one.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// `end` / `group` / `limit` are Postgres reserved words (categories R/T);
// `total` is the CONTROL — an unreserved column must stay bare, which is the
// whole argument for reserved-only quoting: existing output does not move.
const SOURCE = (persistence: string) => `
system ReservedSys {
  subdomain Sales {
    context Orders {
      aggregate Ticket with crudish {
        end: string
        group: string
        limit: int
        total: int
      }
      repository Tickets for Ticket {
        find rooted(p: string): Ticket[] where this.end.startsWith(p)
        find trimmed(g: string): Ticket[] where this.group.trim() == g
        find capped(n: int): Ticket[] where this.limit.abs() == n
        find totalled(n: int): Ticket[] where this.total.abs() == n
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d {
    platform: node { persistence: ${persistence} }
    contexts: [Orders]
    dataSources: [st]
    serves: SalesApi
    port: 4000
  }
}`;

const REPO = "d/db/repositories/ticket-repository.ts";

describe("MikroORM quotes reserved-word columns in raw() fragments", () => {
  it("quotes the receiver column of every queryable intrinsic", async () => {
    const src = (await generateSystemFiles(SOURCE("mikroorm"))).get(REPO)!;
    // The fragment is `JSON.stringify`d into a TS string literal, so the quote
    // arrives as `\"` — no verbatim/regular split to worry about (unlike C#).
    expect(src).toContain('raw("starts_with(\\"end\\", ?)", [p])');
    expect(src).toContain('raw("trim(\\"group\\")", [])');
    expect(src).toContain('raw("abs(\\"limit\\")", [])');
    // The CONTROL: an unreserved column is never quoted.
    expect(src).toContain('raw("abs(total)", [])');
    expect(src).not.toContain('\\"total\\"');
    // Bind placeholders are VALUES, not identifiers — they stay bare.
    expect(src).not.toContain('\\"?\\"');
  });

  it("leaves the drizzle adapter alone — it interpolates the schema column", async () => {
    const src = (await generateSystemFiles(SOURCE("drizzle"))).get(REPO)!;
    // Drizzle never writes the identifier itself: `${schema.tickets.end}` is a
    // column OBJECT the driver renders (quoted) at query-build time.
    expect(src).toContain("schema.tickets.end");
    expect(src).not.toContain('raw("');
  });
});
