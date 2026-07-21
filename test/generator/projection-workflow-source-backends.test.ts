// Cross-backend emission of a query-time projection `from <Workflow>`: every
// backend reads the workflow's persisted saga-state store (NOT an aggregate
// repository, which workflows don't have), applies the `where`, and projects
// instance fields. One generation per backend; asserts the saga-state read
// marker and the ABSENCE of a broken `<Wf>Repository` reference.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseValid } from "../_helpers/parse.js";

const src = (platform: string) => `
  system S {
    subdomain D { context C {
      aggregate Order { total: int  operation place() { emit OrderPlaced { order: id } } }
      repository Orders for Order { }
      event OrderPlaced { order: Order id }
      event Paid { order: Order id }
      workflow Fulfil {
        orderId: Order id
        attempts: int
        create(p: OrderPlaced) by p.order { emit Paid { order: p.order } }
      }
      projection ActiveFulfilments {
        orderId: Order id
        attempts: int
        from Fulfil as f where f.attempts > 0
        select orderId = f.orderId, attempts = f.attempts
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

// The saga-state read marker per backend. A workflow has no `<Wf>Repository`,
// so the broken aggregate-style reference must never appear (java's saga-state
// repository is the distinct `FulfilStateRepository`).
const CASES: { platform: string; sagaRead: RegExp }[] = [
  {
    platform: "node",
    sagaRead:
      /db\.select\(\)\.from\(schema\.fulfils\)\.where\(gt\(schema\.fulfils\.attempts, 0\)\)/,
  },
  { platform: "python", sagaRead: /select\(FulfilRow\)\.where\(\(FulfilRow\.attempts > 0\)\)/ },
  { platform: "java", sagaRead: /fulfilStateRepository\.findAll\(\)\.stream\(\)/ },
  { platform: "dotnet", sagaRead: /_db\.Fulfils\.AsNoTracking\(\)\.Where\(r => r\.Attempts > 0\)/ },
  {
    platform: "elixir",
    sagaRead: /from\(record in Api\.C\.Workflows\.FulfilState, where: record\.attempts > 0\)/,
  },
];

describe("query-time projection `from <Workflow>` cross-backend saga-state read", () => {
  for (const { platform, sagaRead } of CASES) {
    it(`${platform}: reads the saga-state store, no aggregate-style workflow repository`, async () => {
      const all = await allFiles(platform);
      expect(all).toMatch(sagaRead);
      expect(all).not.toMatch(/\bFulfilRepository\b/);
      expect(all).not.toMatch(/\bIFulfilRepository\b/);
    });
  }
});
