// Hono emit for a GROUPED query-time projection (`group by` — M-T4.2): one row
// per distinct grouping-key combination, aggregates computed per group IN SQL.
//
// Like the whole-table singleton this replaces a rehydrate-and-fold read, so
// the assertions are as much about what is NOT emitted (no repository row
// loading) as about what is: ONE query carrying the `where`, GROUP BY *and*
// ORDER BY on exactly the grouping columns (the ORDER BY is what makes the
// read deterministic across backends), the LIST response shape, and per-field
// coercion — keys to their declared wire types, aggregates through the same
// coercions the singleton uses.

import { describe, expect, it } from "vitest";
import { generateHono, generateSystemFiles } from "../../_helpers/generate.js";
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
    projection SalesByStatus {
      status: OrderStatus
      orders: int
      revenue: money
      from Order as o
      where Confirmed
      group by o.status
      select status = o.status, orders = count(), revenue = sum(o.total)
    }
  }
`;

async function routes(): Promise<string> {
  const files = await generateHono(await parseValid(SRC));
  return files.get("http/query-projections.ts")!;
}

describe("hono grouped aggregation (group by)", () => {
  it("emits ONE SQL query with the keys and aggregates, grouped AND ordered by the key column", async () => {
    const p = await routes();
    expect(p).toContain(
      "const rows = await db.select({ status: schema.orders.status, orders: count(), " +
        "revenue: sum(schema.orders.total) }).from(schema.orders)" +
        '.where(eq(schema.orders.status, "Confirmed"))' +
        ".groupBy(schema.orders.status).orderBy(schema.orders.status);",
    );
  });

  it("does NOT load rows through the repository", async () => {
    // The rehydrate-and-fold read this shape exists to avoid.
    const p = await routes();
    expect(p).not.toContain("await repo.salesByStatus()");
    expect(p).not.toMatch(/const rows = await repo\./);
  });

  it("responds with the LIST shape — an array of the declared row, not the singleton object", async () => {
    const p = await routes();
    expect(p).toContain("const SalesByStatusResponse = z.array(SalesByStatusRow).openapi(");
    expect(p).not.toContain("const SalesByStatusResponse = SalesByStatusRow.openapi(");
  });

  it("declares the key field in the row schema with its wire type (enum literal union)", async () => {
    expect(await routes()).toContain('status: z.enum(["Draft", "Confirmed"])');
  });

  it("maps each row: key passed through, aggregates coerced to their declared wire types", async () => {
    // The enum key column already returns the wire string — no rewrap; the
    // aggregates reuse the singleton coercions (`numeric` sum is a driver
    // string, so a money row field stays a string, an int count a number).
    const p = await routes();
    expect(p).toContain("const projected = rows.map((r) => ({");
    expect(p).toContain("      status: r.status,");
    expect(p).toContain("      orders: Number(r.orders ?? 0),");
    // money pins the fixed wire scale (RS-12 / #2549); `String()` shipped
    // whatever scale the driver returned.
    expect(p).toContain("      revenue: new Decimal(r.revenue ?? 0).toFixed(4),");
  });

  it("imports the drizzle helpers it calls, and `schema` as a VALUE", async () => {
    const p = await routes();
    expect(p).toContain('import { count, eq, sum } from "drizzle-orm";');
    expect(p).toContain('import * as schema from "../db/schema";');
    expect(p).not.toContain('import type * as schema from "../db/schema";');
  });
});

// The `requires` gate (403-before-query) — same emission as every other
// query-time projection route: read `currentUser`, throw ForbiddenError BEFORE
// the grouped query runs.
const GATED = `
  system S {
    user { id: string role: string }
    subdomain D { context C {
      enum OrderStatus { Draft Confirmed }
      aggregate Order { status: OrderStatus  total: money }
      repository Orders for Order { }
      projection AdminSalesByStatus requires currentUser.role == "admin" {
        status: OrderStatus
        orders: int
        from Order as o
        group by o.status
        select status = o.status, orders = count()
      }
    }}
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    api Api from D
    deployable api { platform: node  contexts: [C]  dataSources: [cState]  serves: Api  port: 3000  auth: required }
  }
`;

describe("hono grouped aggregation `requires` gate", () => {
  it("reads currentUser and throws 403 BEFORE the grouped query", async () => {
    const files = await generateSystemFiles(GATED);
    const k = [...files.keys()].find((key) => key.endsWith("http/query-projections.ts"))!;
    const p = files.get(k)!;
    expect(p).toContain('.get("currentUser")');
    expect(p).toContain(
      'if (!(currentUser.role === "admin")) throw new ForbiddenError("Forbidden");',
    );
    // The gate precedes the grouped SQL read.
    expect(p.indexOf('throw new ForbiddenError("Forbidden")')).toBeLessThan(
      p.indexOf(".groupBy(schema.orders.status)"),
    );
  });
});
