// Hono emit for a WHOLE-TABLE AGGREGATION in a query-time projection's
// `select` — read-path-architecture.md rev. 8's singleton read model, whose
// motivating use is a dashboard total / running count (M-T1.3 Phase 0).
//
// The shape's whole reason to exist is that the aggregation runs IN SQL.  The
// naive read this replaces was a `SELECT *` over the source table with every
// row rehydrated into a domain object to produce one integer — the scaling
// failure M-T2.6 removed from `findAll` — with the operator name emitted as a
// free identifier on top of it.  So these assertions are as much about what is
// NOT emitted as about what is.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Orders {
    enum OrderStatus { Draft Confirmed }
    aggregate Order {
      code: string
      total: money
      lineCount: int
      status: OrderStatus
      derived display: string = code
    }
    repository Orders for Order {}
    criterion Confirmed of Order as o = o.status == OrderStatus.Confirmed
    projection SalesTotals {
      orders: int
      revenue: money
      avgLines: decimal
      biggest: money
      from Order as o
      where Confirmed
      select orders = count, revenue = sum(o.total), avgLines = avg(o.lineCount), biggest = max(o.total)
    }
  }
`;

async function routes(): Promise<string> {
  const files = await generateHono(await parseValid(SRC));
  return files.get("http/query-projections.ts")!;
}

describe("hono whole-table aggregation", () => {
  it("pushes every operator down to a single SQL aggregate query", async () => {
    const p = await routes();
    expect(p).toContain(
      "const [row] = await db.select({ orders: count(), revenue: sum(schema.orders.total), " +
        "avgLines: avg(schema.orders.lineCount), biggest: max(schema.orders.total) })" +
        ".from(schema.orders)",
    );
  });

  it("does NOT load rows through the repository", async () => {
    // The defect this replaces: `repo.salesTotals()` → `SELECT *` → rehydrate
    // every row → map to one integer.
    const p = await routes();
    expect(p).not.toContain("await repo.salesTotals()");
    expect(p).not.toMatch(/const rows = await repo\./);
  });

  it("lowers the projection's `where` into the SAME query, not a post-filter", async () => {
    const p = await routes();
    expect(p).toContain('.where(eq(schema.orders.status, "Confirmed"))');
  });

  it("counts ROWS, not a column", async () => {
    // `count` is the one operator with no argument — `COUNT(*)`.
    expect(await routes()).toContain("orders: count()");
  });

  it("returns ONE row — the response is the row, not an array of one", async () => {
    const p = await routes();
    expect(p).toContain("const SalesTotalsResponse = SalesTotalsRow.openapi(");
    expect(p).not.toContain("z.array(SalesTotalsRow)");
  });

  it("coerces each result to its declared wire type", async () => {
    // Postgres returns `numeric` aggregates as STRINGS through the driver, and
    // NULL over an empty table — so this is load-bearing, not cosmetic.  A
    // money row field is `z.string()`; an int/decimal one is a number.
    const p = await routes();
    expect(p).toContain("orders: Number(row?.orders ?? 0),");
    expect(p).toContain('revenue: String(row?.revenue ?? "0"),');
    expect(p).toContain("avgLines: Number(row?.avgLines ?? 0),");
    expect(p).toContain('biggest: String(row?.biggest ?? "0"),');
  });

  it("imports the drizzle aggregate helpers it calls", async () => {
    expect(await routes()).toContain('import { avg, count, eq, max, sum } from "drizzle-orm";');
  });

  it("imports `schema` as a VALUE, since the query names a table", async () => {
    // Found by the real compiler: the file's default `import type * as schema`
    // makes `schema.orders` a `TS1361` in value position.  The same latent
    // break sits on the raw-table-source path, which no fixture compiled.
    const p = await routes();
    expect(p).toContain('import * as schema from "../db/schema";');
    expect(p).not.toContain('import type * as schema from "../db/schema";');
  });
});
