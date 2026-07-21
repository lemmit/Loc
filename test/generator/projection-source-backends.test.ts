// Cross-backend emission of a query-time projection `from <OtherProjection>`:
// every backend reads the SOURCE folded projection's persisted `<Proj>Row`
// read-model table (NOT an aggregate repository — a folded projection has none),
// applies the `where`, and projects row fields. One generation per backend;
// asserts the read-model read marker and the ABSENCE of a broken aggregate-style
// `<Source>Repository` reference (java's legit read-model repo is the distinct
// `<Source>RowRepository`, which the `\bOrderTotalsRepository\b` word-boundary
// negative assertions deliberately do not match).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseValid } from "../_helpers/parse.js";

const src = (platform: string) => `
  system S {
    subdomain D { context C {
      aggregate Order { total: int  status: string }
      repository Orders for Order { }
      event OrderPlaced { order: Order id  total: int }
      projection OrderTotals keyed by orderId {
        orderId: Order id
        total: int
        on(e: OrderPlaced) by e.order { orderId := e.order  total := e.total }
      }
      projection BigOrders {
        orderId: Order id
        total: int
        from OrderTotals as t where t.total > 100
        select orderId = t.orderId, total = t.total
      }
    }}
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable api { platform: ${platform}  contexts: [C]  dataSources: [cState] }
  }
`;

async function allFiles(platform: string): Promise<string> {
  const files = (await generateSystems(await parseValid(src(platform)))).files;
  return [...files.values()].join("\n \n");
}

// The read-model read marker per backend. The source `OrderTotals` is a folded
// projection with a persisted `<Proj>Row` table, read directly (no aggregate
// repository).
const CASES: { platform: string; read: RegExp }[] = [
  {
    platform: "node",
    read: /db\.select\(\)\.from\(schema\.orderTotalses\)\.where\(gt\(schema\.orderTotalses\.total, 100\)\)/,
  },
  {
    platform: "python",
    read: /select\(OrderTotalsRow\)\.where\(\(OrderTotalsRow\.total > 100\)\)/,
  },
  { platform: "java", read: /orderTotalsRowRepository\.findAll\(\)\.stream\(\)/ },
  {
    platform: "dotnet",
    read: /_db\.OrderTotalses\.AsNoTracking\(\)\.Where\(r => r\.Total > 100\)/,
  },
  {
    platform: "elixir",
    read: /from\(record in Api\.C\.Projections\.OrderTotalsRow, where: record\.total > 100\)/,
  },
];

describe("query-time projection `from <Projection>` cross-backend read-model read", () => {
  for (const { platform, read } of CASES) {
    it(`${platform}: reads the source folded projection's <Proj>Row, no aggregate-style repository`, async () => {
      const all = await allFiles(platform);
      expect(all).toMatch(read);
      // The broken aggregate-style repo must never appear (the read-model repo
      // `OrderTotalsRowRepository` is legit and does NOT match these).
      expect(all).not.toMatch(/\bOrderTotalsRepository\b/);
      expect(all).not.toMatch(/\bIOrderTotalsRepository\b/);
    });
  }
});
