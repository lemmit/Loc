// React API-client coverage for single-success union finds (`find x(): Agg or
// Err`).  Per exception-less.md §4, the 200 body is the SUCCESS variant
// directly (`<Agg>Response`) — the error/absent variant is a thrown non-2xx,
// never part of the 200 schema — so the React Query hook parses `<Agg>Response`
// (identical to `<Agg>?` / `<Agg> option`) and emits no tagged `oneOf` DTO.  A
// discriminated-union component would only be needed for a genuine multi-success
// union, which IR validation rejects for finds (aggregate-or-aggregate is
// `loom.union-find-shape-unsupported`).

import { describe, expect, it } from "vitest";
import { buildApiModule } from "../../../src/generator/_frontend/api-module.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { allContexts } from "../../../src/ir/types/loom-ir.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Orders {
    aggregate Order { code: string }
    error NotFound { resource: string }
    repository Orders for Order { find recent(): Order or NotFound }
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

describe("react api-builder — single-success union finds", () => {
  it("emits NO tagged discriminated-union schema for the find", async () => {
    const api = await apiModule();
    expect(api).not.toContain("z.discriminatedUnion");
    expect(api).not.toContain("OrderOrNotFound");
  });

  it("the find hook parses the success variant's <Agg>Response directly", async () => {
    const api = await apiModule();
    expect(api).toContain("export function useRecentOrder(query: RecentQuery) {");
    expect(api).toContain("return OrderResponse.parse(r);");
  });
});
