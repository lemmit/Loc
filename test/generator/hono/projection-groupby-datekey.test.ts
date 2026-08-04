// Hono emit for a COMPUTED grouping key — the daily series
// (`group by o.placedAt.startOfDay()`).
//
// The bucketed key is the one grouping shape whose SELECT expression is not a
// bare column, so the assertions centre on the thing Postgres actually
// requires: the IDENTICAL `date_trunc('day', …)` expression in the SELECT, the
// GROUP BY and the ORDER BY (a SELECT expression that doesn't match a GROUP BY
// one is a SQL error, not a wrong answer).  Everything else stays the grouped
// contract: ONE query, no repository row loading, the LIST response, and the
// key coerced to its declared wire type — a `datetime` key ships as an ISO
// string.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Orders {
    enum OrderStatus { Draft Confirmed }
    aggregate Order {
      code: string
      total: money
      status: OrderStatus
      placedAt: datetime
      derived display: string = code
    }
    repository Orders for Order {}
    criterion Confirmed of Order as o = o.status == OrderStatus.Confirmed
    projection RevenueByDay {
      day: datetime
      revenue: money
      from Order as o
      where Confirmed
      group by o.placedAt.startOfDay()
      select day = o.placedAt.startOfDay(), revenue = sum(o.total)
    }
  }
`;

const KEY_SQL = "sql`date_trunc('day', ${schema.orders.placedAt})`";

async function routes(): Promise<string> {
  const files = await generateHono(await parseValid(SRC));
  return files.get("http/query-projections.ts")!;
}

describe("hono grouped aggregation with a computed date key", () => {
  it("emits ONE query carrying the same date_trunc expression in select, groupBy AND orderBy", async () => {
    expect(await routes()).toContain(
      `const rows = await db.select({ day: ${KEY_SQL}.mapWith(schema.orders.placedAt), revenue: sum(schema.orders.total) })` +
        ".from(schema.orders)" +
        '.where(eq(schema.orders.status, "Confirmed"))' +
        `.groupBy(${KEY_SQL}).orderBy(${KEY_SQL});`,
    );
  });

  it("decodes the SELECTed bucket with .mapWith — Drizzle hands a raw `sql` member back as TEXT", async () => {
    // Regression: Drizzle does NOT apply the driver's type parser to a raw
    // `sql` select member — it returns the wire text (`"2026-08-01
    // 00:00:00+00"`), so the emitted `(… as Date).toISOString()` died with
    // `r.day.toISOString is not a function` against a real Postgres.  The cast
    // made it invisible to `tsc`.  `.mapWith(<column>)` reuses that column's
    // own `mapFromDriverValue`, so the bucket decodes like the bare column.
    const p = await routes();
    expect(p).toContain(`${KEY_SQL}.mapWith(schema.orders.placedAt)`);
    // …and ONLY in the select: group/order read nothing back, and they must
    // stay byte-identical to the select's SQL for Postgres to accept it.
    expect(p).not.toContain(`.groupBy(${KEY_SQL}.mapWith`);
    expect(p).not.toContain(`.orderBy(${KEY_SQL}.mapWith`);
  });

  it("uses date_trunc('day', …) exactly three times — select, group, order — and no raw column grouping", async () => {
    const p = await routes();
    expect(p.split("date_trunc('day'").length - 1).toBe(3);
    expect(p).not.toContain(".groupBy(schema.orders.placedAt)");
  });

  it("imports `sql` from drizzle-orm alongside the aggregate helpers, and `schema` as a VALUE", async () => {
    const p = await routes();
    expect(p).toContain('import { eq, sql, sum } from "drizzle-orm";');
    expect(p).toContain('import * as schema from "../db/schema";');
    expect(p).not.toContain('import type * as schema from "../db/schema";');
  });

  it("does NOT load rows through the repository", async () => {
    const p = await routes();
    expect(p).not.toContain("await repo.revenueByDay()");
    expect(p).not.toMatch(/const rows = await repo\./);
  });

  it("responds with the LIST shape", async () => {
    expect(await routes()).toContain("const RevenueByDayResponse = z.array(RevenueByDayRow)");
  });

  it("coerces the datetime key to an ISO string, re-asserting the Date the raw sql select types `unknown`", async () => {
    const p = await routes();
    expect(p).toContain("      day: (r.day as Date).toISOString(),");
    expect(p).toContain('      revenue: String(r.revenue ?? "0"),');
  });
});
