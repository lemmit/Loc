// M-T1.3 Phase 0 — WHOLE-TABLE AGGREGATION in a query-time projection's
// `select` (read-path-architecture.md rev. 8's singleton read model, whose
// motivating use is a dashboard total / running count).
//
// The surface parsed, lowered and validated on `main` and emitted a free
// identifier (`{ orders: count }` — `TS2304`) on top of a `SELECT *` over the
// whole table with every row rehydrated into a domain object to produce one
// integer.  Now: lowering NORMALISES the aggregation into `select.aggregate`,
// the node/Hono emitter pushes it down to SQL, and the backends that haven't
// ported the emit gate honestly.
//
// Also covers the two neighbouring gates the same slice needed: a genuinely
// unresolved `select` name, and the reserved GROUP BY combination.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** Codes reported for `src`, lowered + enriched + IR-validated (phase ⑦).
 *  Deliberately NOT via `ddd parse`: the CLI's `parse` command runs the AST
 *  tier only, so the IR tier these gates live in is reached by `generate`
 *  (and by this harness) — part of why the holes went unnoticed. */
async function codes(src: string): Promise<string[]> {
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
}

async function projectionQuery(src: string, name: string) {
  const { model } = await parseString(src, { validate: false });
  const loom = lowerModel(model);
  const ctx = allContexts(loom).find((c) => c.name === "Orders")!;
  return ctx.projections.find((p) => p.name === name)!.query;
}

/** A context-only fixture — no deployable, so the per-backend gate is silent
 *  and only the context-level checks speak. */
const context = (body: string) => `system S {
  subdomain Sales { context Orders {
    aggregate Customer { name: string }
    aggregate Order {
      code: string
      total: money
      lineCount: int
      customerId: Customer id
      derived display: string = code
    }
    repository Orders for Order { }
    repository Customers for Customer { }
    ${body}
  } }
}`;

/** The same context hosted on a real deployable, so the per-backend gate runs.
 *  `platform` is the knob under test. */
const hostedOn = (platform: string, body: string) => `system S {
  subdomain Sales { context Orders {
    aggregate Order { code: string  total: money  derived display: string = code }
    repository Orders for Order { }
    ${body}
  } }

  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }

  deployable api { platform: ${platform} contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
}`;

const TOTALS = `projection SalesTotals { orders: int
  from Order as o
  select orders = count }`;

describe("lowering normalises a whole-table aggregation", () => {
  it("recognises a bare `count` — a row count with no column", async () => {
    const q = await projectionQuery(context(TOTALS), "SalesTotals");
    expect(q?.selects?.[0]?.aggregate).toEqual({ op: "count" });
  });

  it("recognises an aggregating CALL, whose IR shape is different", async () => {
    // `count` lowers to an unknown ref; `sum(o.total)` lowers to a free call.
    // Covering only one shape would leak half the vocabulary to the emitter.
    const q = await projectionQuery(
      context(`projection SalesTotals { revenue: money
        from Order as o
        select revenue = sum(o.total) }`),
      "SalesTotals",
    );
    expect(q?.selects?.[0]?.aggregate?.op).toBe("sum");
    expect(q?.selects?.[0]?.aggregate?.arg?.kind).toBe("member");
  });

  it("types the result from the OPERATOR, not the unresolved expression", async () => {
    // A bare `count` infers as `string` through the ordinary expression path,
    // which is simply wrong; `avg` widens to decimal even over an int column.
    const q = await projectionQuery(
      context(`projection SalesTotals { orders: int  avgLines: decimal
        from Order as o
        select orders = count, avgLines = avg(o.lineCount) }`),
      "SalesTotals",
    );
    expect(q?.selects?.[0]?.type).toEqual({ kind: "primitive", name: "int" });
    expect(q?.selects?.[1]?.type).toEqual({ kind: "primitive", name: "decimal" });
  });

  it("leaves a PER-ROW collection op alone — it has a real receiver", async () => {
    // `o.lineCount.count` is a member access, not a keyless aggregation, so a
    // keyed projection's per-row `select` keeps working exactly as before.
    const q = await projectionQuery(
      context(`projection Rows { n: int
        from Order as o
        select n = o.lineCount.count }`),
      "Rows",
    );
    expect(q?.selects?.[0]?.aggregate).toBeUndefined();
  });
});

describe("loom.projection-whole-table-aggregation-unsupported (per-backend)", () => {
  it("is silent on node — the Hono emitter has ported the SQL push-down", async () => {
    expect(await codes(hostedOn("node", TOTALS))).not.toContain(
      "loom.projection-whole-table-aggregation-unsupported",
    );
  });

  for (const platform of ["python", "java", "dotnet", "elixir"]) {
    it(`gates ${platform} honestly until its emitter ports`, async () => {
      expect(await codes(hostedOn(platform, TOTALS))).toContain(
        "loom.projection-whole-table-aggregation-unsupported",
      );
    });
  }
});

describe("loom.projection-groupby-unsupported", () => {
  it("rejects mixing an aggregation with a per-row select", async () => {
    // One aggregate + one per-row column is a GROUP BY — one row per distinct
    // `code`, not one row for the table.  Reserved, not guessed at.
    expect(
      await codes(
        context(`projection Rows { code: string  orders: int
          from Order as o
          select code = o.code, orders = count }`),
      ),
    ).toContain("loom.projection-groupby-unsupported");
  });

  it("accepts an ALL-aggregate select (the singleton)", async () => {
    expect(
      await codes(
        context(`projection SalesTotals { orders: int  revenue: money
          from Order as o
          select orders = count, revenue = sum(o.total) }`),
      ),
    ).not.toContain("loom.projection-groupby-unsupported");
  });
});

describe("loom.projection-select-unresolved", () => {
  it("rejects a select naming nothing at all", async () => {
    const reported = await codes(
      context(`projection Rows { label: string
        from Order as o
        select label = nonesuch }`),
    );
    expect(reported).toContain("loom.projection-select-unresolved");
  });

  it("rejects a bare `sum` — it names no column to aggregate", async () => {
    // Only `count` is meaningful without an argument.  A bare `sum` must NOT be
    // normalised into an aggregation, or the emitter would have nothing to sum.
    expect(
      await codes(
        context(`projection Rows { revenue: money
          from Order as o
          select revenue = sum }`),
      ),
    ).toContain("loom.projection-select-unresolved");
  });

  it("accepts per-row source-field reads", async () => {
    expect(
      await codes(
        context(`projection Rows { code: string  total: money
          from Order as o
          select code = o.code, total = o.total }`),
      ),
    ).not.toContain("loom.projection-select-unresolved");
  });

  it("accepts a `join` alias read — the alias resolves, so it is not an unknown ref", async () => {
    const reported = await codes(
      context(`projection Rows { customerName: string
        from Order as o
        join Customer as c on o.customerId
        select customerName = c.name }`),
    );
    expect(reported).not.toContain("loom.projection-select-unresolved");
    expect(reported).not.toContain("loom.projection-whole-table-aggregation-unsupported");
  });
});

describe("loom.ui-projection-read-unsupported", () => {
  const withUi = (readExpr: string) => `system S {
  subdomain Sales { context Orders {
    aggregate Order { code: string  derived display: string = code }
    repository Orders for Order { }
    projection SalesTotals keyed by order { order: Order id }
  } }

  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }

  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    page Dash {
      route: "/dash"
      title: "Dash"
      body: Stack { QueryView { of: ${readExpr}, data: r => Text { "x" } } }
    }
  }

  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: react targets: api ui: WebApp { Sales: api } port: 3002 }
}`;

  it("rejects a page reading a projection through its api handle", async () => {
    // Emitted `/* unresolved: Sales */ undefined.SalesTotals.isLoading`.
    expect(await codes(withUi("Sales.SalesTotals"))).toContain(
      "loom.ui-projection-read-unsupported",
    );
  });

  it("leaves an aggregate read alone — the same receiver shape, a supported member", async () => {
    // F2 exempts an api-handle root, which is why the projection member slipped
    // through; this pins that the exemption still holds for aggregates.
    const reported = await codes(withUi("Sales.Order.all"));
    expect(reported).not.toContain("loom.ui-projection-read-unsupported");
    expect(reported).not.toContain("loom.method-call-unresolved-receiver");
  });
});
