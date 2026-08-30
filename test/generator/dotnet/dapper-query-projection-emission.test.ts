// .NET Dapper backend — QUERY-TIME projection read parity (M-T6.25).
//
// The sibling of `dapper-projection-emission.test.ts`, one read shape further
// along.  A query-time projection has FIVE emission arms, and four of them read
// a TABLE rather than a repository: the whole-table aggregation, the grouped
// aggregation, a workflow-sourced read and a projection-sourced read.  All four
// were EF-LINQ over the concrete `AppDbContext`, which `persistence: dapper`
// does not have — so the IR validator refused the whole feature
// (`loom.dapper-unsupported`) rather than emit a project that could not compile.
//
// WHY A STRING TEST AND NOT JUST THE COMPILE TIER.  `dotnet build` proves the
// C# is well-formed; it cannot see whether the SQL is right, because the SQL is
// a string literal.  The two things this pins that the compiler is blind to are
// exactly the two that were wrong-by-construction before: that the aggregation
// happens IN SQL (`count(*)` / `sum(...)`, not a materialised `SELECT *`), and
// that the `where` / `group by` / `order by` clauses carry the SAME predicate
// and the SAME computed bucket the EF path translates.  The corpus compile tier
// (`corpus-dotnet-dapper-build`, all three projection fixtures) is the other
// half; the emitted SQL was run against a real Postgres by hand and returns the
// values the fixtures' `test e2e` blocks assert.

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

// One aggregate carrying: a filtered whole-table aggregation (every operator),
// a grouped aggregation with a COMPUTED (`startOfDay`) key, and a plain per-row
// query-time projection with a `requires` gate.
const SOURCE = (persistence: string) => `
system QpSys {
  user { id: guid  role: string }
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed }
      aggregate Order with crudish {
        code: string
        placedAt: datetime
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

      projection RevenueByDay {
        day: datetime
        orders: int
        revenue: money
        from Order as o
        group by o.placedAt.startOfDay()
        select day = o.placedAt.startOfDay(), orders = count(), revenue = sum(o.total)
      }

      projection OpenOrders requires currentUser.role == "clerk" {
        code: string
        from Order as o
        where o.status == OrderStatus.Confirmed
        select code = o.code
      }
    }
  }
  api OrdersApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable d {
    platform: dotnet { persistence: ${persistence} }
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
    auth: required
  }
}`;

const SINGLETON = "d/Application/Projections/SalesTotalsQpHandler.cs";
const GROUPED = "d/Application/Projections/RevenueByDayQpHandler.cs";
const PER_ROW = "d/Application/Projections/OpenOrdersQpHandler.cs";

describe("Dapper query-time projection handlers", () => {
  it("the WHOLE-TABLE aggregation is one raw SELECT that materialises no rows", async () => {
    const files = generateSystems(await build(SOURCE("dapper"))).files;
    const src = files.get(SINGLETON);
    expect(src, "the singleton handler is emitted under `persistence: dapper`").toBeDefined();

    // No EF coupling — this is exactly what the validator used to refuse over.
    expect(src!).not.toContain("Microsoft.EntityFrameworkCore");
    expect(src!).not.toContain("AppDbContext");
    expect(src!).toContain("using Dapper;");
    expect(src!).toContain("using Npgsql;");
    expect(src!).toContain("private readonly NpgsqlDataSource _db;");

    // The aggregation happens IN SQL — every operator, and the criterion `where`
    // folded into the SAME statement rather than applied after.  The `::int` /
    // `::numeric` / `::double precision` casts are load-bearing: they pin the
    // CLR type each aggregate lands on, which is what `csCoerce` then converts
    // to the declared row type.  See the dedicated suite below for why
    // `avgLines` (a declared `decimal`, so a `double` on the wire) must NOT
    // arrive as `numeric`.
    expect(src!).toContain(
      'new CommandDefinition("SELECT count(*)::int AS orders, sum(total)::numeric AS revenue, ' +
        "avg(line_count)::double precision AS avg_lines FROM orders WHERE (status = 'Confirmed')\", " +
        "cancellationToken: cancellationToken)",
    );
    // No GROUP BY ⇒ Postgres always returns exactly one row (count 0 / NULL
    // sums over an empty table), so the read is `QuerySingleAsync`.
    expect(src!).toContain("QuerySingleAsync<AggRow>");
    expect(src!).not.toContain("SELECT *");

    // The row DTO is snake-named after the SQL aliases (Dapper's column→property
    // match), and the wire coercion is the SHARED one: count zero-defaults,
    // money formats InvariantCulture, decimal casts to the declared type.
    expect(src!).toContain("public int orders { get; set; }");
    expect(src!).toContain("public decimal? revenue { get; set; }");
    // The money scale is the FIXED wire scale (RS-12 / #2549), not the scale the
    // rows were stored at — and the Dapper arm gets that for free because it
    // shares `csCoerce` with the EF arm rather than re-deriving the coercion.
    // That sharing is the property under test here: a second copy would have
    // shipped `"40.00"` where the EF path ships `"40.0000"`.
    expect(src!).toContain(
      "return new SalesTotalsRow(agg?.orders ?? 0, (agg?.revenue ?? 0m)" +
        // `(double)`, not `(decimal)`: a wire `decimal` leaves the .NET
        // response as the float64 the other four backends send (#2563), so
        // the LINQ/Dapper average crosses without narrowing.
        '.ToString("F4", CultureInfo.InvariantCulture), (double)(agg?.avg_lines ?? 0));',
    );
  });

  it("the GROUPED aggregation renders the computed key identically in SELECT, GROUP BY and ORDER BY", async () => {
    const files = generateSystems(await build(SOURCE("dapper"))).files;
    const src = files.get(GROUPED)!;
    expect(src).not.toContain("Microsoft.EntityFrameworkCore");

    // Postgres matches a grouped select against the GROUP BY expression
    // SYNTACTICALLY, so the three clause positions must carry the byte-identical
    // `date_trunc` — a backend that grouped by the raw timestamp buckets every
    // row into its own group.  The ORDER BY is REQUIRED: without it the group
    // order is engine-chosen and the cross-backend wire differential flakes on
    // row order rather than values.
    expect(src).toContain(
      "new CommandDefinition(\"SELECT date_trunc('day', placed_at) AS placed_at_start_of_day, " +
        "count(*)::int AS orders, sum(total)::numeric AS revenue FROM orders " +
        "GROUP BY date_trunc('day', placed_at) ORDER BY date_trunc('day', placed_at)\", " +
        "cancellationToken: cancellationToken)",
    );
    expect(src).toContain("public DateTime placed_at_start_of_day { get; set; }");
    // The key rides the wire through the SAME projection the EF arm uses.
    expect(src).toContain("r.placed_at_start_of_day.ToUniversalTime()");
  });

  it("the per-row arm was already persistence-neutral — it reads the repository, gate included", async () => {
    const files = generateSystems(await build(SOURCE("dapper"))).files;
    const src = files.get(PER_ROW)!;
    // This arm never touched EF: it goes through `I<Agg>Repository`, whose
    // Dapper implementation has always emitted the synthesized find.  The
    // blanket refusal took it down with the other four anyway.
    expect(src).toContain("private readonly IOrderRepository _repo;");
    expect(src).toContain("await _repo.OpenOrders(cancellationToken)");
    expect(src).not.toContain("NpgsqlDataSource");
    // The 403-before-read gate is unchanged across adapters.
    expect(src).toContain('if (!(currentUser.Role == "clerk")) throw new ForbiddenException(');
    // …and the Dapper repository really does carry that find.
    expect(files.get("d/Infrastructure/Repositories/OrderRepository.cs")!).toContain(
      "public async Task<List<Order>> OpenOrders(CancellationToken cancellationToken = default)",
    );
  });

  it("keeps the default EF-Core adapter on AppDbContext (unchanged)", async () => {
    const files = generateSystems(await build(SOURCE("efcore"))).files;
    const singleton = files.get(SINGLETON)!;
    expect(singleton).toContain("using Microsoft.EntityFrameworkCore;");
    expect(singleton).toContain("private readonly AppDbContext _db;");
    expect(singleton).toContain(".GroupBy(_ => 1)");
    expect(singleton).not.toContain("NpgsqlDataSource");
    expect(singleton).not.toContain("CommandDefinition");

    const grouped = files.get(GROUPED)!;
    expect(grouped).toContain("private readonly AppDbContext _db;");
    expect(grouped).toContain(".GroupBy(o => new { PlacedAtStartOfDay = o.PlacedAt.Date })");
    expect(grouped).not.toContain("date_trunc");
  });
});

// ---------------------------------------------------------------------------
// A `double`-on-the-wire aggregate must arrive from Postgres AS a double.
//
// #2575 retyped .NET wire `decimal` RESPONSE fields to `double` (RS-24: the
// other four backends carry the JSON number through an IEEE-754 double, and
// `System.Decimal` truncated it).  On EF that is invisible — the provider
// materialises `Average` as a real `double`.  On DAPPER the SQL said
// `avg(line_count)::numeric`, Npgsql maps `numeric` to `System.Decimal`, and
// the `(double)` coercion that follows is a decimal→double conversion which
// .NET rounds to **15 significant digits**:
//
//     avg of 7/3  ->  2.333333333333333        (dapper, wrong)
//                     2.3333333333333335       (every other backend, and the
//                                               true nearest double)
//
// That turned the wire-golden differential red on `behavioral-dapper` — on
// `main` itself and on every open PR — while the dapper compile leg stayed
// green, because the divergence lives in a SQL string literal and a runtime
// numeric conversion. Not a golden rebaseline: node is the oracle and correct.
//
// The fix is one cast, and the two halves must move TOGETHER — the SQL cast and
// the row DTO's CLR type are the same decision, and a mismatch is a silent
// Npgsql conversion, not a compile error.  Hence both are pinned here.
//
// The aggregate still ACCUMULATES in `numeric` (`avg`/`sum` over `integer` or
// `numeric` return `numeric`); only the result is converted, by Postgres'
// correctly-rounded numeric→float8. Casting the ARGUMENT instead would move the
// accumulation into binary floating point and diverge for real.
// ---------------------------------------------------------------------------
describe("dapper aggregates land on the CLR type their wire field crosses as", () => {
  it("a `decimal`-declared aggregate casts to `double precision`, and its row DTO is `double?`", async () => {
    const files = generateSystems(await build(SOURCE("dapper"))).files;
    const src = files.get(SINGLETON)!;
    expect(src).toContain("avg(line_count)::double precision AS avg_lines");
    expect(src).toContain("public double? avg_lines { get; set; }");
    // The `(double)` coercion is now an identity conversion — no narrowing.
    expect(src).toContain("(double)(agg?.avg_lines ?? 0)");
    // The defect, stated so a regression reads as itself.
    expect(
      src,
      "numeric -> System.Decimal -> double rounds to 15 significant digits",
    ).not.toContain("avg(line_count)::numeric");
  });

  it("money aggregates stay `numeric`/`decimal` — they ship as a fixed-scale STRING", async () => {
    const files = generateSystems(await build(SOURCE("dapper"))).files;
    const src = files.get(SINGLETON)!;
    // `revenue` is declared `money`, so it never becomes a JSON number: it is
    // formatted `F4` from a decimal (RS-12).  Casting it to float8 would lose
    // the exactness that scale depends on.
    expect(src).toContain("sum(total)::numeric AS revenue");
    expect(src).toContain("public decimal? revenue { get; set; }");
  });

  it("`count` is unchanged — an int is an int on every backend", async () => {
    const files = generateSystems(await build(SOURCE("dapper"))).files;
    expect(files.get(SINGLETON)!).toContain("count(*)::int AS orders");
    expect(files.get(SINGLETON)!).toContain("public int orders { get; set; }");
  });

  it("the GROUPED arm takes the same decision — one classifier, both arms", async () => {
    const files = generateSystems(await build(SOURCE("dapper"))).files;
    const grouped = files.get(GROUPED)!;
    // This fixture's grouped projection aggregates only `count` and a money
    // `sum`, so the pin here is that neither is disturbed…
    expect(grouped).toContain("count(*)::int AS orders");
    expect(grouped).toContain("sum(total)::numeric AS revenue");
    // …and that the arm reads the shared helper rather than a second copy: a
    // `double` field in the SINGLETON arm implies the same rule applies here,
    // which `corpus-dotnet-dapper-build`'s `projection-groupby` fixture (whose
    // `ByStatus` groups an `avgLines: decimal`) exercises end to end.
    expect(grouped).not.toContain("::double precision");
  });
});

// ---------------------------------------------------------------------------
// …and dapper does NOT then convert a second time (M-T6.47).
//
// The continuation of the fix above took the two hops #2631 could not reach —
// the per-row response funnel and the EF aggregate arm over a `decimal` COLUMN
// — and routes both through a correctly-rounded
// `double.Parse(d.ToString(InvariantCulture), InvariantCulture)`.
//
// Dapper must stay exactly as #2631 left it.  After the SQL cast the row DTO
// already declares `double?`, so the value arriving in C# IS a double: adding a
// Parse would be converting an already-converted number — harmless
// numerically, but it would put a `decimal`-shaped fix on a path that has no
// decimal, and the next edit to either arm would have two conversions to keep
// in step instead of one decision. Hence a `decimal` COLUMN is added here too,
// and pinned to the SQL-side answer.
// ---------------------------------------------------------------------------
const DECIMAL_COLUMN_SOURCE = SOURCE("dapper")
  .replace("        lineCount: int\n", "        lineCount: int\n        price: decimal\n")
  .replace(
    "      projection RevenueByDay {",
    `      projection PriceStats {
        avgPrice: decimal
        from Order as o
        select avgPrice = avg(o.price)
      }

      projection RevenueByDay {`,
  );

describe("dapper fixes the decimal narrowing in SQL, and only there", () => {
  it("a `decimal`-COLUMN aggregate still casts in SQL and grows no `double.Parse`", async () => {
    const files = generateSystems(await build(DECIMAL_COLUMN_SOURCE)).files;
    const src = files.get("d/Application/Projections/PriceStatsQpHandler.cs")!;
    // Postgres' own numeric→float8 is correctly rounded, so the value reaches
    // C# already narrowed — nothing left to convert.
    expect(src).toContain("avg(price)::double precision AS avg_price");
    expect(src).toContain("public double? avg_price { get; set; }");
    expect(src).toContain("(double)(agg?.avg_price ?? 0)");
    expect(
      src,
      "the dapper value is already a double — a Parse here would convert twice",
    ).not.toContain("double.Parse");
  });

  it("the EF twin of the same projection DOES parse — one decision, two seams", async () => {
    // The false case of the classifier, on the identical `.ddd`: EF has no SQL
    // to cast in, so it narrows in C#.  Both arms end up shipping the nearest
    // double to the stored value; only the seam differs.
    const files = generateSystems(
      await build(DECIMAL_COLUMN_SOURCE.replace("dapper", "efcore")),
    ).files;
    const src = files.get("d/Application/Projections/PriceStatsQpHandler.cs")!;
    expect(src).toContain(
      "double.Parse((agg?.AvgPrice ?? 0).ToString(System.Globalization.CultureInfo.InvariantCulture), " +
        "System.Globalization.CultureInfo.InvariantCulture)",
    );
    expect(src).not.toContain("::double precision");
  });
});
