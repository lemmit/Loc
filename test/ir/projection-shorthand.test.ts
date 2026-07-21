// Shorthand (`select`-less) query-time projection: `projection P { from <Agg>
// as a where <filter> }` — NO declared fields, NO `select`.  The row shape is
// the SOURCE AGGREGATE's full wire shape (enriched from `wireFieldsForAggregate`),
// and the read returns the filtered source rows serialized to that wire shape.
// This is the projection replacement for the removed `view X = A where P` form.
//
// Gates covered here:
//   loom.projection-fields-without-select     — declared row fields but no `select`
//                                               to fill them (NOT shorthand — a
//                                               half-written projection)
//   loom.projection-shorthand-nonaggregate    — the shorthand form over a
//                                               workflow/projection source (only
//                                               an aggregate source is supported)

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts, isShorthandProjection } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const wrap = (body: string, platform = "node"): string => `
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
    ${body}
  }}
  storage sql { type: postgres }
  resource st { for: C, kind: state, use: sql }
  deployable api { platform: ${platform}  contexts: [C]  dataSources: [st] }
}
`;

async function codes(body: string, platform = "node"): Promise<string[]> {
  const { model } = await parseString(wrap(body, platform), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code?.startsWith("loom.projection-"))
    .map((d) => d.code!);
}

describe("shorthand (`select`-less) query-time projection", () => {
  it("accepts a shorthand aggregate-source projection", async () => {
    expect(
      await codes(`projection ActiveOrders { from Order as o where o.status == "active" }`),
    ).toEqual([]);
  });

  it("accepts a shorthand aggregate-source projection with no `where` (whole-aggregate read)", async () => {
    expect(await codes(`projection AllOrders { from Order as o }`)).toEqual([]);
  });

  it("row shape is the source aggregate's full wire shape", async () => {
    const { model } = await parseString(
      wrap(`projection ActiveOrders { from Order as o where o.status == "active" }`),
      { validate: false },
    );
    const enriched = enrichLoomModel(lowerModel(model));
    const proj = allContexts(enriched)
      .flatMap((c) => c.projections)
      .find((p) => p.name === "ActiveOrders")!;
    expect(isShorthandProjection(proj)).toBe(true);
    // The wire shape equals the Order aggregate wire shape: id + total + status.
    expect((proj.wireShape ?? []).map((f) => f.name)).toEqual(
      expect.arrayContaining(["id", "total", "status"]),
    );
  });

  it("rejects declared row fields with no `select` (not shorthand)", async () => {
    expect(
      await codes(
        `projection Half { orderId: Order id  total: int  from Order as o where o.total > 0 }`,
      ),
    ).toContain("loom.projection-fields-without-select");
  });

  it("rejects the shorthand form over a projection source (aggregate-only)", async () => {
    const c = await codes(`projection ShortProj { from OrderTotals as t }`);
    expect(c).toContain("loom.projection-shorthand-nonaggregate");
    // It is NOT the half-written-projection diagnostic — it IS shorthand, just
    // over an unsupported source kind.
    expect(c).not.toContain("loom.projection-fields-without-select");
  });
});
