// Honest gates for the two SILENT holes under M-T1.3 (charts & dashboards):
// a projection `select` whose expression doesn't resolve, and a ui that reads a
// projection.  Both validated clean on `main` and emitted broken code — a free
// identifier in the backend's row mapper, and `undefined.<Projection>` in a
// React page — from models with no diagnostic at all.
//
// The motivating shape is the WHOLE-TABLE aggregation
// (read-path-architecture.md rev. 8's singleton read model — "dashboard total /
// running count"): designed, parsed, lowered, and never implemented, so `count`
// stayed an unknown ref and reached the generated source verbatim.  Each gate
// is lifted when its feature lands (M-T1.3 Phase 0 / Phase 1).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** Codes reported for `src`, lowered + enriched + IR-validated (phase ⑦).
 *  Deliberately NOT via `ddd parse`: the CLI's `parse` command runs the AST
 *  tier only, so the IR tier these gates live in is reached by `generate`
 *  (and by this harness), which is part of why the holes went unnoticed. */
async function codes(src: string): Promise<string[]> {
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
}

const context = (body: string) => `system S {
  subdomain Sales { context Orders {
    aggregate Customer { name: string }
    aggregate Order {
      code: string
      total: money
      customerId: Customer id
      derived display: string = code
    }
    repository Orders for Order { }
    repository Customers for Customer { }
    ${body}
  } }
}`;

describe("loom.projection-whole-table-aggregation-unsupported", () => {
  it("rejects a bare `count` in a singleton projection's select", async () => {
    // Emitted `{ orders: count }` — `TS2304: Cannot find name 'count'`.
    expect(
      await codes(
        context(`projection SalesTotals { orders: int
          from Order as o
          select orders = count }`),
      ),
    ).toContain("loom.projection-whole-table-aggregation-unsupported");
  });

  it("rejects an aggregating call — `sum(o.total)` lowers to an unresolved free call", async () => {
    // A different IR shape from the bare ref (`callKind: "free"`), same defect,
    // so the detector must cover both or half the vocabulary still leaks.
    expect(
      await codes(
        context(`projection SalesTotals { revenue: money
          from Order as o
          select revenue = sum(o.total) }`),
      ),
    ).toContain("loom.projection-whole-table-aggregation-unsupported");
  });

  it("reports one diagnostic per offending select, not one per projection", async () => {
    const reported = (
      await codes(
        context(`projection SalesTotals { orders: int  revenue: money
          from Order as o
          select orders = count, revenue = sum(o.total) }`),
      )
    ).filter((c) => c === "loom.projection-whole-table-aggregation-unsupported");
    expect(reported).toHaveLength(2);
  });
});

describe("loom.projection-select-unresolved", () => {
  it("rejects a select naming nothing at all (and does NOT call it an aggregation)", async () => {
    const reported = await codes(
      context(`projection Rows { label: string
        from Order as o
        select label = nonesuch }`),
    );
    expect(reported).toContain("loom.projection-select-unresolved");
    expect(reported).not.toContain("loom.projection-whole-table-aggregation-unsupported");
  });
});

describe("a resolving select stays clean", () => {
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
    // Guards the obvious false positive: `c` in `select customerName = c.name`
    // is bound by the join, so the alias must not be mistaken for a bad name.
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
