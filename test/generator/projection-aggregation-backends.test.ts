// M-T1.3 Phase 0, ports — WHOLE-TABLE AGGREGATION on the four non-node
// backends.  The node/Hono leg has its own suite
// (test/generator/hono/projection-aggregation.test.ts); this one pins the same
// contract on python / dotnet / java / elixir in one place, because the
// interesting property is that they AGREE, not that each emits some SQL.
//
// Three things every backend must get right, each of which is silently wrong
// rather than loudly wrong when missed:
//
//  1. The aggregation runs IN SQL.  The naive read is a `SELECT *` over the
//     whole table with every row hydrated into a domain object to produce one
//     integer — the scaling failure M-T2.6 removed from `findAll`.
//  2. A singleton returns ONE ROW, not an array/list of one.
//  3. The coercions follow the DECLARED row type.  Postgres hands numeric
//     aggregates back as strings/Decimals through most drivers and NULL over an
//     empty table; `money` rides every backend's wire as a string, a plain
//     `decimal` as a number.  A coercion that followed the aggregate's own
//     result type instead would disagree with the response schema.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const system = (platform: string) => `system Shop {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed }
      aggregate Order {
        code: string
        total: money
        lineCount: int
        status: OrderStatus
        derived display: string = code
      }
      repository Orders for Order { }
      criterion Confirmed of Order as o = o.status == OrderStatus.Confirmed
      projection SalesTotals {
        orders: int
        revenue: money
        avgLines: decimal
        from Order as o
        where Confirmed
        select orders = count(), revenue = sum(o.total), avgLines = avg(o.lineCount)
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api { platform: ${platform} contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
}`;

async function fileEndingWith(platform: string, suffix: string): Promise<string> {
  const files = await generateSystemFiles(system(platform));
  for (const [path, content] of files) if (path.endsWith(suffix)) return content;
  throw new Error(`no generated file ending with ${suffix} (platform ${platform})`);
}

describe("python", () => {
  it("aggregates in SQL over the source table", async () => {
    const routes = await fileEndingWith("python", "http/query_projections_routes.py");
    expect(routes).toContain(
      "select(func.count(), func.sum(OrderRow.total), func.avg(OrderRow.line_count))" +
        ".select_from(OrderRow)",
    );
    // …and never through the repository, which would materialise rows.
    expect(routes).not.toContain("OrderRepository");
  });

  it("lowers the `where` into the same query", async () => {
    expect(await fileEndingWith("python", "http/query_projections_routes.py")).toContain(
      "OrderStatus.Confirmed",
    );
  });

  it("returns one row — the response model is the row, not a list", async () => {
    const routes = await fileEndingWith("python", "http/query_projections_routes.py");
    expect(routes).toContain("class SalesTotalsResponse(SalesTotalsRow):");
    expect(routes).toContain("-> dict[str, object]:");
    expect(routes).not.toContain("RootModel[list[SalesTotalsRow]]");
  });

  it("coerces to the declared row type", async () => {
    const routes = await fileEndingWith("python", "http/query_projections_routes.py");
    expect(routes).toContain('"orders": int(row[0] or 0),');
    expect(routes).toContain('"revenue": str(row[1] or "0"),');
    expect(routes).toContain('"avgLines": float(row[2] or 0),');
  });
});

describe("dotnet", () => {
  it("aggregates in ONE grouped query, not one round trip per operator", async () => {
    // `GroupBy(_ => 1)` is the EF idiom for a whole-table aggregate in a single
    // query; separate `CountAsync`/`SumAsync` calls would each be their own.
    const handler = await fileEndingWith("dotnet", "Projections/SalesTotalsQpHandler.cs");
    expect(handler).toContain(".GroupBy(_ => 1)");
    expect(handler).toContain(
      "new { Orders = g.Count(), Revenue = g.Sum(o => o.Total), AvgLines = g.Average(o => o.LineCount) }",
    );
    expect(handler).toContain(".Where(o => o.Status == OrderStatus.Confirmed)");
    expect(handler).not.toContain("_repo.");
  });

  it("returns one row through the whole CQRS chain", async () => {
    expect(await fileEndingWith("dotnet", "Projections/SalesTotalsQpQuery.cs")).toContain(
      "IQuery<SalesTotalsRow>",
    );
    expect(await fileEndingWith("dotnet", "Projections/SalesTotalsQpHandler.cs")).toContain(
      "IQueryHandler<SalesTotalsQpQuery, SalesTotalsRow>",
    );
    expect(await fileEndingWith("dotnet", "QueryProjectionsController.cs")).toContain(
      "Task<ActionResult<SalesTotalsRow>>",
    );
  });

  it("casts to the declared row type — LINQ picks its own result type", async () => {
    // `Average` over an `int` returns `double`; a row field declared `decimal`
    // is then `CS1503: cannot convert from 'double' to 'decimal'`.  Found by
    // the real compiler, not by a unit test.
    const handler = await fileEndingWith("dotnet", "Projections/SalesTotalsQpHandler.cs");
    expect(handler).toContain("(decimal)(agg?.AvgLines ?? 0)");
    expect(handler).toContain("(agg?.Revenue ?? 0m).ToString(CultureInfo.InvariantCulture)");
  });
});

describe("java", () => {
  it("aggregates in JPQL through the EntityManager", async () => {
    // Through the EntityManager rather than a Spring Data repository method: a
    // multi-aggregate select has no derived-query spelling, and a `@Query` on
    // the aggregate's repository would make the read model edit the
    // aggregate's own port for a projection it knows nothing about.
    const svc = await fileEndingWith("java", "OrdersQueryProjections.java");
    expect(svc).toContain(
      'entityManager.createQuery("select count(e), sum(e.total), avg(e.lineCount) from Order e where',
    );
    expect(svc).toContain("@PersistenceContext");
    expect(svc).not.toContain(".findAll()");
  });

  it("returns one row from the service and the controller", async () => {
    expect(await fileEndingWith("java", "OrdersQueryProjections.java")).toContain(
      "public SalesTotalsRow salesTotals()",
    );
    expect(await fileEndingWith("java", "OrdersQueryProjectionsController.java")).toContain(
      "public SalesTotalsRow salesTotals()",
    );
  });

  it("reads results through Number/toString, never a provider-specific cast", async () => {
    // JPQL result types are provider-chosen (`Long` for a count, `Double` for
    // an average, `BigDecimal` for a sum), so a direct cast would throw on a
    // different provider.
    const svc = await fileEndingWith("java", "OrdersQueryProjections.java");
    expect(svc).toContain("((Number) r[0]).intValue()");
    expect(svc).toContain('r[1] == null ? "0" : r[1].toString()');
    expect(svc).toContain("r[2] == null ? BigDecimal.ZERO : new BigDecimal(r[2].toString())");
  });

  it("emits the `requires` gate on a gated singleton aggregation — 403 BEFORE the query", async () => {
    // Regression: the singleton arm once `continue`d past the shared gate
    // block, serving a `requires`-gated aggregation UNGATED on Java alone —
    // every other backend enforced it.  The route keeps the one-row shape.
    const gated = system("java")
      .replace("from Order as o", 'from Order as o\n        requires currentUser.role == "admin"')
      .replace("system Shop {", "system Shop {\n  user { id: string role: string }")
      .replace("port: 8080 }", "port: 8080 auth: required }");
    const files = await generateSystemFiles(gated);
    let controller = "";
    for (const [path, content] of files)
      if (path.endsWith("OrdersQueryProjectionsController.java")) controller = content;
    expect(controller).toContain("public SalesTotalsRow salesTotals()");
    const gateAt = controller.indexOf("ForbiddenException");
    const readAt = controller.indexOf("queryProjections.salesTotals()");
    expect(gateAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(gateAt);
  });
});

describe("elixir", () => {
  it("aggregates in the Ecto select, not over loaded rows", async () => {
    const mod = await fileEndingWith("elixir", "query_projections/sales_totals.ex");
    expect(mod).toContain(
      "select: %{orders: count(record.id), revenue: sum(record.total), avgLines: avg(record.line_count)}",
    );
    expect(mod).toContain("|> Repo.one()");
    expect(mod).not.toContain("Repo.all(");
  });

  it("returns one map", async () => {
    expect(await fileEndingWith("elixir", "query_projections/sales_totals.ex")).toContain(
      "@spec run(any()) :: map()",
    );
  });

  it("splits money (string) from plain decimal (number) — RS-24", async () => {
    // Jason encodes a bare `%Decimal{}` as a JSON string, which is what money
    // wants and what a plain `decimal` must NOT be: the other four backends
    // ship it as a number.
    const mod = await fileEndingWith("elixir", "query_projections/sales_totals.ex");
    expect(mod).toContain("revenue: to_string(row.revenue || 0)");
    expect(mod).toContain("Decimal.to_float(");
  });
});
