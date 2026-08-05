// `scaffoldDashboard` emits a per-day SERIES beside the singleton totals
// (M-T1.3 Phase 5) — the read model a dashboard chart plots.
//
// It rides the GROUPED read model (M-T4.2) on the catalogued
// `datetime.startOfDay()` key, so the day buckets are cut by
// `date_trunc('day', …)` in SQL rather than by loading rows and grouping them
// in the browser (`.all` is paged, so a client-side grouping would bucket ONE
// PAGE).
//
// The series is conditional on the aggregate having a datetime column to group
// on, and the ui-side derivation answers the same question — so a chart tile
// can never bind a projection this macro did not emit.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts, isGroupedProjection } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/parse.js";

async function projections(body: string) {
  const { model } = await parseString(
    `system S { subdomain D { context Orders with scaffoldDashboard {
      ${body}
      repository Orders for Order { } } } }`,
    { validate: false },
  );
  const loom = enrichLoomModel(lowerModel(model));
  return allContexts(loom).find((c) => c.name === "Orders")?.projections ?? [];
}

describe("scaffoldDashboard per-day series", () => {
  it("emits <Agg>PerDay as a GROUPED projection on the startOfDay bucket", async () => {
    const ps = await projections("aggregate Order { code: string  placedAt: datetime }");
    const series = ps.find((p) => p.name === "OrderPerDay");
    expect(series, "expected a per-day series projection").toBeDefined();
    if (!series) return;
    expect(isGroupedProjection(series)).toBe(true);
    expect(series.query?.groupBy).toHaveLength(1);
    // day + rowCount, and the count is a real SQL aggregate.
    expect(series.wireShape?.map((f) => f.name)).toEqual(["day", "rowCount"]);
    expect(series.query?.selects?.find((s) => s.field === "rowCount")?.aggregate?.op).toBe("count");
  });

  it("prefers a declared `createdAt` over another datetime — the created-per-day series", async () => {
    // NOTE: a `createdAt` contributed by the `auditable` CAPABILITY may not be
    // visible here — macro expansion is source order, so the capability has
    // not necessarily expanded when `scaffoldDashboard` runs, and the series
    // then falls back to the first declared datetime.  That is a real ordering
    // caveat, not a preference this test can assert; it asserts the preference
    // for a DECLARED field, which is what the derivation guarantees.
    const ps = await projections("aggregate Order { placedAt: datetime  createdAt: datetime }");
    const series = ps.find((p) => p.name === "OrderPerDay");
    const key = series?.query?.groupBy?.[0];
    // The key is `<alias>.createdAt.startOfDay()` — a method call on the column.
    expect(JSON.stringify(key)).toContain("createdAt");
    expect(JSON.stringify(key)).toContain("startOfDay");
  });

  it("emits NO series when the aggregate has no datetime to group on", async () => {
    const ps = await projections("aggregate Order { code: string  total: money }");
    expect(ps.map((p) => p.name)).toContain("OrderTotals");
    expect(ps.map((p) => p.name)).not.toContain("OrderPerDay");
  });

  it("skips an optional datetime — a NULL row would vanish from the series", async () => {
    // …while still counting in the `rowCount` tile beside it: two numbers on
    // one dashboard that quietly disagree about which rows they cover.
    const ps = await projections("aggregate Order { code: string  placedAt: datetime? }");
    expect(ps.map((p) => p.name)).not.toContain("OrderPerDay");
  });
});
