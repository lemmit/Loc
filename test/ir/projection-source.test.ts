// Query-time projection `from <OtherProjection>` — the projection twin of the
// removed projection-source view (projection.md v1.1).  A projection reads a
// SOURCE folded/materialized projection's persisted `<Proj>Row` read-model table
// at query time, with `where`/`select` only.
//
// Gates:
//   loom.projection-source-not-materialized   — the source projection is itself
//                                                query-time (no read-model table)
//   loom.projection-source-self               — a projection sourcing itself
//   loom.projection-source-join-unsupported   — a `join` over a projection source
//   loom.projection-source-ignoring-unsupported — an `ignoring` over a projection source
//   loom.projection-source-unsupported-backend  — a backend that hasn't ported the emit

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function codes(body: string, platform = "node"): Promise<string[]> {
  const src = `
system S {
  subdomain D { context C {
    aggregate Order { total: int  status: string  operation place() { emit OrderPlaced { order: id, total: 1 } } }
    repository Orders for Order { }
    event OrderPlaced { order: Order id  total: int }
    projection OrderTotals keyed by orderId {
      orderId: Order id
      total: int
      on(e: OrderPlaced) by e.order { orderId := e.order  total := e.total }
    }
    projection LiveTotals {
      orderId: Order id
      total: int
      from Order as o where o.total > 0
      select orderId = o.id, total = o.total
    }
    ${body}
  }}
  storage sql { type: postgres }
  resource st { for: C, kind: state, use: sql }
  deployable api { platform: ${platform}  contexts: [C]  dataSources: [st] }
}
`;
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code?.startsWith("loom.projection-source"))
    .map((d) => d.code!);
}

describe("query-time projection `from <Projection>` validation", () => {
  it("accepts a materialized (folded) projection source on node", async () => {
    expect(
      await codes(
        `projection BigOrders { orderId: Order id  total: int  from OrderTotals as t where t.total > 100 select orderId = t.orderId, total = t.total }`,
      ),
    ).toEqual([]);
  });

  it("rejects a query-time (non-materialized) projection source", async () => {
    // LiveTotals is itself query-time (`from Order …`, no folds) → no row table.
    expect(
      await codes(
        `projection Derived { orderId: Order id  total: int  from LiveTotals as t where t.total > 100 select orderId = t.orderId, total = t.total }`,
      ),
    ).toContain("loom.projection-source-not-materialized");
  });

  it("rejects a projection sourcing itself", async () => {
    expect(
      await codes(
        `projection Loopy { orderId: Order id  total: int  from Loopy as t where t.total > 100 select orderId = t.orderId, total = t.total }`,
      ),
    ).toContain("loom.projection-source-self");
  });

  it("rejects a `join` over a projection source", async () => {
    expect(
      await codes(
        `projection Joined { orderId: Order id  total: int  from OrderTotals as t where t.total > 100 join Order as o on t.orderId select orderId = t.orderId, total = t.total }`,
      ),
    ).toContain("loom.projection-source-join-unsupported");
  });

  it("rejects an `ignoring` over a projection source", async () => {
    expect(
      await codes(
        `projection Bypassing { orderId: Order id  total: int  from OrderTotals as t where t.total > 100 ignoring * select orderId = t.orderId, total = t.total }`,
      ),
    ).toContain("loom.projection-source-ignoring-unsupported");
  });
});
