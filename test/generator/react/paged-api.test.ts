// React API-client coverage for paged finds (payload-transport-layer.md, P3b
// emission — React slice).  A `find x(): <Agg> paged` emits a `<Agg>Paged`
// response schema, adds 1-based `page`/`pageSize` to the find's query schema,
// and the generated React Query hook parses the paged envelope — so a
// hono-served react frontend consumes the same wire shape the backend emits.

import { describe, expect, it } from "vitest";
import { buildApiModule } from "../../../src/generator/_frontend/api-module.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { allContexts } from "../../../src/ir/types/loom-ir.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Inventory {
    aggregate Warehouse { code: string  region: string }
    repository Warehouses for Warehouse {
      find recent(): Warehouse paged
      find inRegion(region: string): Warehouse paged where this.region == region
    }
  }
`;

async function apiModule(): Promise<string> {
  const { model } = await parseString(SRC, { validate: false });
  const enriched = enrichLoomModel(lowerModel(model));
  const ctx = allContexts(enriched).find((c) => c.name === "Inventory")!;
  const agg = ctx.aggregates.find((a) => a.name === "Warehouse")!;
  const repo = ctx.repositories.find((r) => r.aggregateName === "Warehouse");
  return buildApiModule(agg, repo, ctx);
}

describe("react api-builder — paged finds (P3b)", () => {
  it("emits a <Agg>Paged response schema reusing the carrier's response", async () => {
    const api = await apiModule();
    expect(api).toContain(
      "export const WarehousePaged = z.object({ items: z.array(WarehouseResponse), page: z.number().int(), pageSize: z.number().int(), total: z.number().int(), totalPages: z.number().int() });",
    );
    expect(api).toContain("export type WarehousePaged = z.infer<typeof WarehousePaged>;");
  });

  it("adds 1-based page/pageSize to the paged find's query schema", async () => {
    const api = await apiModule();
    // RecentQuery exists (paged find with no domain params still gets a query).
    expect(api).toContain("export const RecentQuery = z.object({");
    expect(api).toContain("page: z.coerce.number().int().min(1).default(1),");
    expect(api).toContain("pageSize: z.coerce.number().int().min(1).default(20),");
    // The domain param survives alongside the paging controls.
    expect(api).toMatch(/export const InRegionQuery = z\.object\(\{[\s\S]*region:/);
  });

  it("exposes the caller-facing z.input alias for a paged query (page/pageSize optional)", async () => {
    const api = await apiModule();
    // z.output (z.infer) makes the defaulted page/pageSize required; the
    // input alias is what a caller actually supplies — they may omit them.
    expect(api).toContain("export type RecentQueryInput = z.input<typeof RecentQuery>;");
    expect(api).toContain("export type InRegionQueryInput = z.input<typeof InRegionQuery>;");
  });

  it("the find hook accepts the input shape and parses the paged envelope", async () => {
    const api = await apiModule();
    expect(api).toContain("export function useRecentWarehouse(query: RecentQueryInput) {");
    expect(api).toContain("return WarehousePaged.parse(r);");
  });
});
