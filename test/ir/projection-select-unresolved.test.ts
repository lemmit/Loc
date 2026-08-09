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
import { PROJECTION_READ_FRAMEWORKS } from "../../src/ir/validate/checks/system-checks.js";
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
  // All five backends have now ported the SQL push-down, so the gate is silent
  // everywhere.  The check stays — it is the seam a NEW backend gates on until
  // it ports, and the assertion is what would catch a port being lost.
  for (const platform of ["node", "python", "java", "dotnet", "elixir"]) {
    it(`is silent on ${platform} — its emitter pushes the aggregation down to SQL`, async () => {
      expect(await codes(hostedOn(platform, TOTALS))).not.toContain(
        "loom.projection-whole-table-aggregation-unsupported",
      );
    });
  }
});

describe("loom.projection-groupby-missing", () => {
  it("rejects mixing an aggregation with a per-row select when no 'group by' declares the grouping", async () => {
    // One aggregate + one per-row column is a GROUP BY — one row per distinct
    // `code`, not one row for the table.  The clause exists now (M-T4.2), so
    // the diagnostic names the fix instead of reserving the combination.
    expect(
      await codes(
        context(`projection Rows { code: string  orders: int
          from Order as o
          select code = o.code, orders = count }`),
      ),
    ).toContain("loom.projection-groupby-missing");
  });

  it("accepts an ALL-aggregate select (the singleton)", async () => {
    expect(
      await codes(
        context(`projection SalesTotals { orders: int  revenue: money
          from Order as o
          select orders = count, revenue = sum(o.total) }`),
      ),
    ).not.toContain("loom.projection-groupby-missing");
  });

  it("accepts the mix once 'group by' declares the grouping columns", async () => {
    expect(
      await codes(
        context(`projection Rows { code: string  orders: int
          from Order as o
          group by o.code
          select code = o.code, orders = count }`),
      ),
    ).not.toContain("loom.projection-groupby-missing");
  });
});

describe("loom.projection-aggregate-arg-not-columnar", () => {
  it("rejects a COMPUTED aggregation argument — it used to crash codegen", async () => {
    // `sum(o.total + o.lineCount)` normalised into `select.aggregate` and then
    // threw an internal error in every backend's emitter ("aggregation
    // argument must be a source column reference") from a model that
    // validated clean.  SQL aggregates a column, not a per-row computation.
    expect(
      await codes(
        context(`projection SalesTotals { padded: money
          from Order as o
          select padded = sum(o.total + o.lineCount) }`),
      ),
    ).toContain("loom.projection-aggregate-arg-not-columnar");
  });

  it("rejects a bare unqualified argument, naming the qualified spelling", async () => {
    // `sum(total)` lowers to a this-prop REF, which the emitters' column
    // renderers don't handle — the gate's message says to write `o.total`.
    expect(
      await codes(
        context(`projection SalesTotals { revenue: money
          from Order as o
          select revenue = sum(total) }`),
      ),
    ).toContain("loom.projection-aggregate-arg-not-columnar");
  });

  it("accepts the plain qualified column — and count() with no argument", async () => {
    expect(
      await codes(
        context(`projection SalesTotals { orders: int  revenue: money
          from Order as o
          select orders = count(), revenue = sum(o.total) }`),
      ),
    ).not.toContain("loom.projection-aggregate-arg-not-columnar");
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

describe("loom.ui-projection-read-unsupported — the FLAVOUR half (every target)", () => {
  const withProjection = (decl: string, readExpr: string) => `system S {
  subdomain Sales { context Orders {
    aggregate Order { code: string  total: money  derived display: string = code }
    repository Orders for Order { }
    ${decl}
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

  const SINGLETON = `projection SalesTotals { orders: int
    from Order as o
    select orders = count }`;

  it("ACCEPTS a singleton query-time projection — the shape Phase 1 ships", async () => {
    // Was: `/* unresolved: Sales */ undefined.SalesTotals.isLoading`.
    expect(await codes(withProjection(SINGLETON, "Sales.SalesTotals"))).not.toContain(
      "loom.ui-projection-read-unsupported",
    );
  });

  it("rejects a KEYED projection — it returns a list, not a row", async () => {
    expect(
      await codes(
        withProjection(
          `projection OrderBoard keyed by order { order: Order id
            from Order as o
            select order = o.id }`,
          "Sales.OrderBoard",
        ),
      ),
    ).toContain("loom.ui-projection-read-unsupported");
  });

  it("rejects a FOLDED projection — it is read by key off its row table", async () => {
    expect(
      await codes(
        withProjection(
          `event OrderPlaced { order: Order id }
           projection OrderBook keyed by order { order: Order id
             on(e: OrderPlaced) { order := e.order } }`,
          "Sales.OrderBook",
        ),
      ),
    ).toContain("loom.ui-projection-read-unsupported");
  });

  it("leaves an aggregate read alone — the same receiver shape, a supported member", async () => {
    // F2 exempts an api-handle root, which is why the projection member slipped
    // through; this pins that the exemption still holds for aggregates.
    const reported = await codes(withProjection(SINGLETON, "Sales.Order.all"));
    expect(reported).not.toContain("loom.ui-projection-read-unsupported");
    expect(reported).not.toContain("loom.method-call-unresolved-receiver");
  });
});

describe("loom.ui-projection-read-unsupported — the FRAMEWORK half", () => {
  const onFrontend = (framework: string) => `system S {
  subdomain Sales { context Orders {
    aggregate Order { code: string  derived display: string = code }
    repository Orders for Order { }
    projection SalesTotals { orders: int  from Order as o  select orders = count }
  } }

  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }

  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    page Dash {
      route: "/dash"
      title: "Dash"
      body: Stack { QueryView { of: Sales.SalesTotals, data: r => Text { "x" } } }
    }
  }

  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: ${framework} targets: api ui: WebApp { Sales: api } port: 3002 }
}`;

  // Both lists shift one framework at a time as the ports land (#2324 react,
  // #2366 vue, #2369 svelte, #2376 angular, …).  A sibling port rebasing onto
  // this file moves its OWN name from the second loop to the first — it never
  // rewrites either list wholesale, for the same reason
  // `PROJECTION_READ_FRAMEWORKS` itself must be merged rather than taken from
  // one side.
  for (const framework of ["react", "vue", "svelte", "angular", "flutter"]) {
    it(`is silent on ${framework} — the projection client ships there`, async () => {
      expect(await codes(onFrontend(framework))).not.toContain(
        "loom.ui-projection-read-unsupported",
      );
    });
  }

  // The gated loop that used to sit here is gone: every frontend has ported, so
  // there is no framework left to name.  It is NOT replaced by `for (const f of
  // [])` — an empty loop registers no `it` and reads as coverage while
  // asserting nothing.
  //
  // What replaces it has to answer the question the empty loop cannot: is the
  // check still WIRED, or merely unreachable?  From the outside those look
  // identical once the Set covers everything, so the only honest proof is to
  // take a framework back out and watch the diagnostic return — the same
  // mutation discipline a new gate owes (CLAUDE.md, "Mutation-prove a new gate
  // before trusting it"), applied to a gate that has run out of subjects.
  it("still FIRES for a framework outside the set — proven by removing one", async () => {
    expect(await codes(onFrontend("flutter"))).not.toContain("loom.ui-projection-read-unsupported");
    PROJECTION_READ_FRAMEWORKS.delete("flutter");
    try {
      expect(await codes(onFrontend("flutter"))).toContain("loom.ui-projection-read-unsupported");
    } finally {
      PROJECTION_READ_FRAMEWORKS.add("flutter");
    }
    expect(await codes(onFrontend("flutter"))).not.toContain("loom.ui-projection-read-unsupported");
  });
});
