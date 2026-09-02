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
    // money goes through `money_str`, not a bare `str` — the aggregate comes
    // back at the scale its rows were stored at, and the wire scale is fixed
    // (RS-12 / #2549).  See `projection-aggregate-money-scale.test.ts`.
    expect(routes).toContain('"revenue": money_str(Decimal(row[1] or 0)),');
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
    // The row field is a `double` (#2563 — a wire `decimal` is the float64
    // the other four backends send), so the LINQ `Average` result crosses
    // unchanged rather than narrowing into a System.Decimal.
    expect(handler).toContain("(double)(agg?.AvgLines ?? 0)");
    // money formats at the FIXED wire scale rather than echoing the aggregate's
    // own (RS-12 / #2549) — `"F4"`, not a bare `ToString`.
    expect(handler).toContain('(agg?.Revenue ?? 0m).ToString("F4", CultureInfo.InvariantCulture)');
  });
});

// ---------------------------------------------------------------------------
// dotnet — an EF aggregate over a `decimal` COLUMN narrows correctly (M-T6.47).
//
// #2631 fixed the dapper aggregate at the SQL seam and recorded that "EF
// materialises `Average` as a real `double`".  That holds only for an INTEGRAL
// column, which is what its fixture aggregated (`avg(o.lineCount)`).  The LINQ
// result type follows the AGGREGATED COLUMN, not the declared row field:
//
//   count → int  |  avg over int → double  |  avg/sum/max/min over decimal → decimal
//
// so a `decimal` column comes back as `System.Decimal` and the `(double)` cast
// that follows is the same not-correctly-rounded conversion (F10 — 9.2% of
// doubles fail to round-trip through it, measured on .NET 10.0.11;
// `99.52989333734583` returns as `…84`).  `csDecimalToWireDouble` replaces it with an exact
// `decimal.ToString` → correctly-rounded `double.Parse` pair.
//
// BOTH arms are pinned — the one that must change and the one that must not —
// which is #2631's own discipline: this is a classifier, and a classifier is
// only proved by its false case.
// ---------------------------------------------------------------------------
const decimalColumnSystem = `system Shop {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed }
      aggregate Order {
        code: string
        total: money
        lineCount: int
        price: decimal
        rate: decimal?
        status: OrderStatus
      }
      repository Orders for Order { }
      projection PriceStats {
        avgPrice: decimal
        maxPrice: decimal
        maxRate: decimal?
        avgLines: decimal
        orders: int
        revenue: money
        from Order as o
        select avgPrice = avg(o.price), maxPrice = max(o.price), maxRate = max(o.rate), avgLines = avg(o.lineCount), orders = count(), revenue = sum(o.total)
      }
      projection PriceByStatus {
        status: OrderStatus
        avgPrice: decimal
        from Order as o
        group by o.status
        select status = o.status, avgPrice = avg(o.price)
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api { platform: dotnet contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
}`;

/** The correctly-rounded narrowing, as `csDecimalToWireDouble` renders it. */
const csParse = (expr: string) =>
  `double.Parse(${expr}.ToString(System.Globalization.CultureInfo.InvariantCulture), ` +
  `System.Globalization.CultureInfo.InvariantCulture)`;

async function decimalColumnFile(suffix: string): Promise<string> {
  const files = await generateSystemFiles(decimalColumnSystem);
  for (const [path, content] of files) if (path.endsWith(suffix)) return content;
  throw new Error(`no generated file ending with ${suffix}`);
}

describe("dotnet EF aggregates land on the CLR type their COLUMN produces", () => {
  it("a `decimal`-column aggregate narrows through the correctly-rounded pair", async () => {
    const handler = await decimalColumnFile("Projections/PriceStatsQpHandler.cs");
    // `Average`/`Max` over a `decimal` property both return `decimal`.
    expect(handler).toContain(csParse("(agg?.AvgPrice ?? 0)"));
    expect(handler).toContain(csParse("(agg?.MaxPrice ?? 0)"));
    // The defect, stated so a regression reads as itself.
    expect(
      handler,
      "the CLR decimal->double cast is a double rounding — it disagrees with node",
    ).not.toContain("(double)(agg?.AvgPrice ?? 0)");
  });

  it("an OPTIONAL decimal-column aggregate unwraps via a pattern match, then parses", async () => {
    // `agg?.MaxRate!.Value.ToString(…)` is a `string?` conditional chain and
    // fails `/warnaserror` (CS8604); the `is { } v` pattern hands the Parse a
    // real `decimal`.  Compile-proved by the dotnet build witness.
    const handler = await decimalColumnFile("Projections/PriceStatsQpHandler.cs");
    expect(handler).toContain(
      `(agg?.MaxRate is { } __decMaxRate ? (double?)${csParse("__decMaxRate")} : null)`,
    );
  });

  it("an INT-column aggregate keeps the plain cast — no needless Parse", async () => {
    // `Average` over an `int` really does materialise as a `double`, so the
    // cast is an identity and converting again would be noise.  This is
    // #2631's fixture shape, and it must not move.
    const handler = await decimalColumnFile("Projections/PriceStatsQpHandler.cs");
    expect(handler).toContain("(double)(agg?.AvgLines ?? 0)");
    expect(handler).not.toContain("double.Parse((agg?.AvgLines");
  });

  it("money and `count` are untouched", async () => {
    const handler = await decimalColumnFile("Projections/PriceStatsQpHandler.cs");
    // money never becomes a JSON number — it is a fixed-scale string (RS-12).
    expect(handler).toContain('(agg?.Revenue ?? 0m).ToString("F4", CultureInfo.InvariantCulture)');
    expect(handler).not.toContain("double.Parse((agg?.Revenue");
    expect(handler).toContain("agg?.Orders ?? 0");
  });

  it("the GROUPED arm takes the same decision — one classifier, both arms", async () => {
    const grouped = await decimalColumnFile("Projections/PriceByStatusQpHandler.cs");
    // The chain materialises FIRST (`ToListAsync`), then maps in memory — so
    // the Parse is LINQ-to-Objects and never has to translate to SQL.
    expect(grouped).toContain(".ToListAsync(cancellationToken);");
    expect(grouped).toContain(csParse("(x?.AvgPrice ?? 0)"));
    expect(grouped).not.toContain("(double)(x?.AvgPrice ?? 0)");
    // The aggregation itself still happens in SQL — this changes the RESULT
    // conversion, never where the accumulation runs.
    expect(grouped).toContain("AvgPrice = g.Average(o => o.Price)");
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
    // Still `toString()` on the provider's own type rather than a cast — but
    // money is then pinned to the fixed wire scale, and its empty-table zero is
    // `"0.0000"` (RS-12 / #2549).
    expect(svc).toContain(
      'r[1] == null ? "0.0000" : new java.math.BigDecimal(r[1].toString()).setScale(4, java.math.RoundingMode.HALF_UP).toPlainString()',
    );
    // A plain `decimal` lands on the RESPONSE wire's `double` (RS-24 /
    // M-T6.46), so it reads through `Number` like the count does and its
    // empty-table zero is `0.0`, not `BigDecimal.ZERO` — the aggregate arm used
    // to re-wrap into a BigDecimal and ship the stored column's full precision.
    expect(svc).toContain("r[2] == null ? 0.0 : ((Number) r[2]).doubleValue()");
    expect(svc).not.toContain("BigDecimal.ZERO");
  });

  it("binds a SINGLE-select aggregation as a bare scalar — no Object[] cast", async () => {
    // Regression (`OrderVolume` in test/fixtures/corpus/projection-aggregation.ddd):
    // JPA returns an `Object[]` row only for a MULTI-column selection.  With one
    // `select`, `getSingleResult()` hands back the bare scalar (a `Long` for a
    // count), so the unconditional `(Object[])` cast was a ClassCastException →
    // 500 on the smallest useful KPI there is.  Nothing caught it because the
    // whole corpus had no single-select query projection until that fixture
    // gained a runtime caller — and the cast is only wrong at RUNTIME, so every
    // compile tier stayed green.  The coercion is the SAME `jpqlCoerce` the
    // multi-column arm applies to that column; only the read expression moves.
    const single = system("java")
      .replace("        revenue: money\n        avgLines: decimal\n", "")
      .replace(
        "select orders = count(), revenue = sum(o.total), avgLines = avg(o.lineCount)",
        "select orders = count()",
      );
    const files = await generateSystemFiles(single);
    let svc = "";
    for (const [path, content] of files)
      if (path.endsWith("OrdersQueryProjections.java")) svc = content;
    expect(svc).toContain(
      'Object r = entityManager.createQuery("select count(e) from Order e where',
    );
    expect(svc).not.toContain("(Object[])");
    expect(svc).toContain("return new SalesTotalsRow(((Number) r).intValue());");
  });

  it("emits the `requires` gate on a gated singleton aggregation — 403 BEFORE the query", async () => {
    // Regression: the singleton arm once `continue`d past the shared gate
    // block, serving a `requires`-gated aggregation UNGATED on Java alone —
    // every other backend enforced it.  The route keeps the one-row shape.
    const gated = system("java")
      .replace(
        "projection SalesTotals",
        'projection SalesTotals requires currentUser.role == "admin"',
      )
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
    // money rides the wire as a string — now at the FIXED scale rather than
    // whatever the aggregate returned (RS-12 / #2549) — while a plain decimal
    // is still floated into a JSON number.
    expect(mod).toContain("revenue: __money_wire(row.revenue || 0)");
    expect(mod).toContain("Decimal.to_float(");
  });
});
