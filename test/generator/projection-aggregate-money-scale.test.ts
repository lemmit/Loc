// A `money` aggregate in a query-time projection carries the FIXED wire scale
// (RS-12, `MONEY_WIRE_SCALE`) on all five backends — #2549.
//
// The defect this pins: `sum`/`max`/`min` over a money column were shipped
// as-is, so the wire value echoed the scale the ROWS WERE STORED AT rather than
// the canonical 4dp every backend's ordinary aggregate read applies.  Phoenix
// therefore disagreed with ITSELF — `"10.0000"` reading an `Order`, `"40.00"`
// summing the same declared field through a projection — and java and .NET did
// the same.  node and python only looked correct because each writes money at
// 4dp, so the (unconstrained `DECIMAL`) column happened to hold scale 4; their
// coercions formatted nothing either, and a table written by another backend
// would have diverged there too.
//
// The runtime oracle is the wire-golden differential
// (`test/behavioral/wire-golden/projection-{aggregation,groupby}.json`, gated on
// all five behavioral legs).  This is its per-PR structural companion: it needs
// no docker, no boot and no SDK, so a regression in any one backend's coercion
// fails in the fast suite instead of waiting for that backend's leg.
//
// Both arms are covered, because they are separate code paths in every emitter:
// the SINGLETON whole-table aggregation and the GROUPED (`group by`) one.

import { describe, expect, it } from "vitest";
import { MONEY_WIRE_SCALE, MONEY_WIRE_ZERO } from "../../src/generator/money-scale.js";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/index.js";

const SYSTEM = (platform: string) => `system MoneyAgg {
  subdomain Sales { context Orders {
    enum OrderStatus { Draft Confirmed }
    aggregate Order { code: string  total: money  lineCount: int  status: OrderStatus }
    repository Orders for Order { }

    // Singleton: every select aggregates, no grouping.
    projection SalesTotals {
      orders: int
      revenue: money
      biggest: money
      from Order as o
      select orders = count(), revenue = sum(o.total), biggest = max(o.total)
    }

    // Grouped: one row per status, a money aggregate beside a key select.
    projection ByStatus {
      status: OrderStatus
      revenue: money
      from Order as o
      group by o.status
      select status = o.status, revenue = sum(o.total)
    }

    // A money grouping KEY — read off the STORED column, not computed by a SQL
    // aggregate, so it takes a DIFFERENT coercion in every emitter.  Kept as
    // its own projection with NO money aggregate, which also pins the
    // import/helper gate: the formatter must be reachable when only a key
    // needs it.
    projection ByTotal {
      total: money
      orders: int
      from Order as o
      group by o.total
      select total = o.total, orders = count()
    }
  } }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource oState { for: Orders, kind: state, use: pg }
  deployable api { platform: ${platform} contexts: [Orders] dataSources: [oState] serves: SalesApi port: 8080 }
}`;

async function build(platform: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SYSTEM(platform));
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no generated file ending in ${suffix}`);
  return files.get(key)!;
}

/** Every emitted file that carries a projection's aggregate coercions, joined —
 *  .NET splits the two arms across two handler files, the rest emit one. */
function projectionSources(files: Map<string, string>, suffixes: string[]): string {
  return suffixes.map((s) => file(files, s)).join("\n");
}

describe("money aggregate — the fixed wire scale, all five backends (#2549)", () => {
  it("node formats through decimal.js at the canonical scale, and imports it", async () => {
    const src = file(await build("node"), "http/query-projections.ts");
    // The defect: `String(row?.revenue ?? "0")` — no formatting, and a bare
    // `"0"` for the empty table where money's zero is `"0.0000"`.
    expect(src).not.toContain(`String(row?.revenue`);
    expect(src).toContain(`new Decimal(row?.revenue ?? 0).toFixed(${MONEY_WIRE_SCALE})`);
    expect(src).toContain(`new Decimal(row?.biggest ?? 0).toFixed(${MONEY_WIRE_SCALE})`);
    // Grouped arm — same treatment off the per-group row.
    expect(src).toContain(`new Decimal(r.revenue ?? 0).toFixed(${MONEY_WIRE_SCALE})`);
    // Emitting the call without the import is a TS2304.
    expect(src).toContain(`import Decimal from "decimal.js";`);
  });

  it("python routes money through money_str, importing it and Decimal", async () => {
    const src = file(await build("python"), "query_projections_routes.py");
    expect(src).toContain("money_str(Decimal(");
    expect(src).not.toMatch(/"revenue":\s*str\(/);
    // Emitting either call without its import is a NameError at request time —
    // the same 500 the coercion exists to prevent.
    expect(src).toContain("money_str");
    expect(src).toContain("from decimal import Decimal");
    expect(src).toMatch(/from app\.db\.wire import .*money_str/);
  });

  it("java pins the scale with setScale(HALF_UP), including the empty-table zero", async () => {
    const src = file(await build("java"), "OrdersQueryProjections.java");
    expect(src).toContain(
      `.setScale(${MONEY_WIRE_SCALE}, java.math.RoundingMode.HALF_UP).toPlainString()`,
    );
    expect(src).toContain(`"${MONEY_WIRE_ZERO}"`);
  });

  it("dotnet formats F4 with InvariantCulture on both arms", async () => {
    const src = projectionSources(await build("dotnet"), [
      "SalesTotalsQpHandler.cs",
      "ByStatusQpHandler.cs",
    ]);
    // Two occurrences per singleton money select + one for the grouped one.
    expect(
      src.split(`ToString("F${MONEY_WIRE_SCALE}", CultureInfo.InvariantCulture)`).length - 1,
    ).toBeGreaterThanOrEqual(3);
    // The unformatted `.ToString(CultureInfo.InvariantCulture)` arm is `guid`'s,
    // and must not be what money takes.
    expect(src).not.toMatch(/\?\?\s*0m\)\.ToString\(CultureInfo\.InvariantCulture\)/);
  });

  it("elixir rounds through __money_wire, and emits the helper it calls", async () => {
    const files = await build("elixir");
    for (const [suffix, read] of [
      ["sales_totals.ex", "row.revenue"],
      ["by_status.ex", "row.revenue"],
    ] as const) {
      const src = file(files, suffix);
      expect(src).toContain(`__money_wire(${read} || 0)`);
      expect(src).not.toContain(`to_string(${read} || 0)`);
      // A `--warnings-as-errors` compile fails on a call to an undefined
      // private fn, so the helper must travel with the call.
      expect(src).toContain(
        `defp __money_wire(%Decimal{} = dec), do: dec |> Decimal.round(${MONEY_WIRE_SCALE}) |> to_string()`,
      );
    }
  });

  // A money grouping KEY is a separate coercion from the aggregate one, and it
  // was left unformatted on three backends after #2549 fixed the aggregates —
  // java and .NET already routed their key through the money renderer.
  it("pins a money grouping KEY at the same scale on all five backends", async () => {
    const node = file(await build("node"), "http/query-projections.ts");
    expect(node).toContain(`total: new Decimal(r.total).toFixed(${MONEY_WIRE_SCALE})`);
    expect(node).not.toContain("total: String(r.total)");

    const py = file(await build("python"), "query_projections_routes.py");
    expect(py).toContain('"total": money_str(r[0])');
    expect(py).not.toContain('"total": str(r[0])');

    const ex = file(await build("elixir"), "by_total.ex");
    expect(ex).toContain("total: __money_wire(row.total)");
    expect(ex).not.toContain("total: to_string(row.total)");
    // The key alone must pull the helper in — this projection aggregates no
    // money at all, so a gate that only looked at aggregates would emit the
    // call and not the `defp` (a `--warnings-as-errors` failure).
    expect(ex).toContain("defp __money_wire(");

    const java = file(await build("java"), "OrdersQueryProjections.java");
    expect(java).toMatch(
      new RegExp(
        `ByTotalRow\\(new (java\\.math\\.)?BigDecimal\\(r\\[0\\]\\.toString\\(\\)\\)\\.setScale\\(${MONEY_WIRE_SCALE}`,
      ),
    );

    const cs = file(await build("dotnet"), "ByTotalQpHandler.cs");
    expect(cs).toContain(`ToString("F${MONEY_WIRE_SCALE}"`);
  });

  it("leaves a non-money aggregate alone (the coercion is money-specific)", async () => {
    // `count()` stays an integer on every backend — the money arm must not
    // swallow the other coercions.  `guid` shares money's `asString` arm and
    // must keep its unformatted stringification, which is why `isMoney` is a
    // separate flag rather than a widening of `asString`.
    const node = file(await build("node"), "http/query-projections.ts");
    expect(node).toContain("Number(row?.orders ?? 0)");
    expect(node).not.toContain("new Decimal(row?.orders");
  });
});
