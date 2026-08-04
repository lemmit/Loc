// COMPUTED grouping keys — the daily series (`group by o.placedAt.startOfDay()`).
//
// The whole surface is one catalogue row: `startOfDay` is a queryable scalar
// intrinsic on `datetime` (no grammar, no new `ExprIR.kind` — it lowers as an
// ordinary zero-arg `method-call` on the column member), and the shared
// `groupKeyOf` detector reads that shape into `{ column, transform }`.  What
// this pins: the lowered shape stays a plain method-call; the detector names
// BOTH halves; the validator ADMITS exactly this transform while every other
// computed key stays rejected; and the select-vs-group-by match compares the
// whole key, so a bare `select day = o.placedAt` against a bucketed `group by`
// is still "per-row but not one of the group by columns".

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { groupedAggregates, groupKeyOf } from "../../src/ir/util/projection-aggregate.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { intrinsicFor } from "../../src/util/intrinsics.js";
import { parseString } from "../_helpers/parse.js";

const context = (body: string) => `system S {
  subdomain Sales { context Orders {
    enum OrderStatus { Draft Confirmed Cancelled }
    aggregate Order {
      code: string
      status: OrderStatus
      total: money
      placedAt: datetime
      derived display: string = code
    }
    repository Orders for Order { }
    criterion Confirmed of Order as o = o.status == OrderStatus.Confirmed
    ${body}
  } }
}`;

const REVENUE_BY_DAY = `projection RevenueByDay {
  day: datetime
  revenue: money
  from Order as o
  where Confirmed
  group by o.placedAt.startOfDay()
  select day = o.placedAt.startOfDay(), revenue = sum(o.total) }`;

async function projection(src: string, name: string) {
  const { model } = await parseString(src, { validate: false });
  const loom = enrichLoomModel(lowerModel(model));
  const ctx = allContexts(loom).find((c) => c.name === "Orders")!;
  return ctx.projections.find((p) => p.name === name)!;
}

async function codes(src: string): Promise<string[]> {
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
}

describe("the startOfDay intrinsic", () => {
  it("is catalogued on datetime, queryable, zero-arg, datetime-returning", () => {
    const sig = intrinsicFor("datetime", "startOfDay")!;
    expect(sig).toBeDefined();
    expect(sig.params).toEqual([]);
    expect(sig.returns).toBe("datetime");
    expect(sig.queryable).toBe(true);
  });

  it("lowers as a plain zero-arg method-call on the column member — no new IR kind", async () => {
    const p = await projection(context(REVENUE_BY_DAY), "RevenueByDay");
    const g = p.query!.groupBy[0]!;
    expect(g.kind).toBe("method-call");
    if (g.kind !== "method-call") throw new Error("unreachable");
    expect(g.member).toBe("startOfDay");
    expect(g.args).toEqual([]);
    expect(g.isCollectionOp).toBe(false);
    expect(g.receiverType).toEqual({ kind: "primitive", name: "datetime" });
    expect(g.receiver.kind).toBe("member");
    // The receiver is the source column, rooted on the source row candidate.
    if (g.receiver.kind !== "member") throw new Error("unreachable");
    expect(g.receiver.member).toBe("placedAt");
    expect(g.receiver.receiver.kind).toBe("this");
  });
});

describe("groupKeyOf — column + transform", () => {
  it("names the column AND the transform for a bucketed key", async () => {
    const p = await projection(context(REVENUE_BY_DAY), "RevenueByDay");
    expect(groupKeyOf(p.query!.groupBy[0]!)).toEqual({
      column: "placedAt",
      transform: "startOfDay",
    });
  });

  it("leaves a bare column transform-free (the pre-existing shape is unchanged)", async () => {
    const p = await projection(
      context(`projection SalesByStatus { status: OrderStatus  orders: int
        from Order as o
        group by o.status
        select status = o.status, orders = count() }`),
      "SalesByStatus",
    );
    expect(groupKeyOf(p.query!.groupBy[0]!)).toEqual({ column: "status" });
  });

  it("reads the same key off the matching key SELECT, so the two compare equal", async () => {
    const p = await projection(context(REVENUE_BY_DAY), "RevenueByDay");
    const g = groupedAggregates(p)!;
    expect(g.keys.map((k) => k.field)).toEqual(["day"]);
    expect(groupKeyOf(g.keys[0]!.expr)).toEqual(groupKeyOf(g.groupBy[0]!));
    // The key keeps its DECLARED wire type; the aggregate is still per-group.
    expect(g.keys[0]!.type).toEqual({ kind: "primitive", name: "datetime" });
    expect(g.aggregates.map((a) => a.field)).toEqual(["revenue"]);
  });

  it("returns null for a computed key that is not a supported transform", async () => {
    const p = await projection(
      context(`projection Bogus { bucket: money  orders: int
        from Order as o
        group by o.total + 1
        select bucket = o.total + 1, orders = count() }`),
      "Bogus",
    );
    expect(groupKeyOf(p.query!.groupBy[0]!)).toBeNull();
  });
});

describe("validation", () => {
  it("ACCEPTS the canonical daily-series projection", async () => {
    const found = (await codes(context(REVENUE_BY_DAY))).filter((c) =>
      c.startsWith("loom.projection-groupby"),
    );
    expect(found).toEqual([]);
  });

  it("still REJECTS an arithmetic grouping key", async () => {
    expect(
      await codes(
        context(`projection Bogus { bucket: money  orders: int
          from Order as o
          group by o.total + 1
          select bucket = o.total + 1, orders = count() }`),
      ),
    ).toContain("loom.projection-groupby-key-not-columnar");
  });

  it("names startOfDay() in the rejection message, so the supported transform is discoverable", async () => {
    const { model } = await parseString(
      context(`projection Bogus { bucket: money  orders: int
        from Order as o
        group by o.total + 1
        select bucket = o.total + 1, orders = count() }`),
      { validate: false },
    );
    const d = validateLoomModel(enrichLoomModel(lowerModel(model))).find(
      (x) => x.code === "loom.projection-groupby-key-not-columnar",
    )!;
    expect(d.message).toContain("startOfDay()");
  });

  it("REJECTS a select/group-by transform MISMATCH — a bare column against a bucketed group", async () => {
    const codesOut = await codes(
      context(`projection RevenueByDay { day: datetime  revenue: money
        from Order as o
        group by o.placedAt.startOfDay()
        select day = o.placedAt, revenue = sum(o.total) }`),
    );
    expect(codesOut).toContain("loom.projection-groupby-select-not-grouped");
    // The group-by side itself is fine — only the select is ungrouped.
    expect(codesOut).not.toContain("loom.projection-groupby-key-not-columnar");
  });

  it("REJECTS the mirror mismatch — a bucketed select against a bare group by", async () => {
    expect(
      await codes(
        context(`projection RevenueByDay { day: datetime  revenue: money
          from Order as o
          group by o.placedAt
          select day = o.placedAt.startOfDay(), revenue = sum(o.total) }`),
      ),
    ).toContain("loom.projection-groupby-select-not-grouped");
  });
});
