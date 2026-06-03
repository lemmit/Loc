// React API-client coverage for discriminated-union finds
// (payload-transport-layer.md, P4b — React slice).  A `find x(): A or B`
// emits a `z.discriminatedUnion("type", …)` response schema (each variant
// tagged + carrying its wire fields), and the generated React Query hook
// parses it — so a hono-served react frontend narrows on the same `type`
// discriminator the backend emits.

import { describe, expect, it } from "vitest";
import { buildApiModule } from "../../../src/generator/react/api-builder.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { allContexts } from "../../../src/ir/types/loom-ir.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Orders {
    aggregate Order ids guid { code: string }
    aggregate Cancel ids guid { reason: string }
    repository Orders for Order { find recent(): Order or Cancel }
  }
`;

async function apiModule(): Promise<string> {
  const { model } = await parseString(SRC, { validate: false });
  const enriched = enrichLoomModel(lowerModel(model));
  const ctx = allContexts(enriched).find((c) => c.name === "Orders")!;
  const agg = ctx.aggregates.find((a) => a.name === "Order")!;
  const repo = ctx.repositories.find((r) => r.aggregateName === "Order");
  return buildApiModule(agg, repo, ctx);
}

describe("react api-builder — discriminated-union finds (P4b)", () => {
  it("emits a z.discriminatedUnion('type', …) schema with both variants tagged", async () => {
    const api = await apiModule();
    expect(api).toContain('export const OrderOrCancel = z.discriminatedUnion("type", [');
    // Order variant: tagged + its wire fields (id + code) flattened.
    expect(api).toContain(
      'z.object({ type: z.literal("Order"), id: z.string(), code: z.string() })',
    );
    // Cancel variant: tagged + its wire fields (id + reason).
    expect(api).toContain(
      'z.object({ type: z.literal("Cancel"), id: z.string(), reason: z.string() })',
    );
    expect(api).toContain("export type OrderOrCancel = z.infer<typeof OrderOrCancel>;");
  });

  it("the find hook parses the union schema", async () => {
    const api = await apiModule();
    expect(api).toContain("export function useRecentOrder(query: RecentQuery) {");
    expect(api).toContain("return OrderOrCancel.parse(r);");
  });
});
