// `currentUser.orgPath` under HIERARCHY (multi-tenancy Phase 2, plan P2.2):
// once the registry opts into `tenantRegistry` (a `dataKey` column exists), the
// principal's `orgPath` becomes a per-request memoized read of the caller org's
// materialized `data_key` from the registry table, keyed by the tenancy claim —
// falling back to the claim (root-segment path) when the row / dataKey is
// absent (fail-safe).  Flat tenancy keeps P2.1's claim-copy (pinned by
// orgpath-principal.test.ts); this pins the hierarchy swap.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const hierarchy = (platform: string) => `
  system Shop {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        aggregate Doc with tenantOwned {
          owner: string
          filter this.owner == currentUser.orgPath
        }
        aggregate Org ids guid {
          name: string
          implements tenantRegistry
        }
        repository Docs for Doc { }
        repository Orgs for Org { }
      }
    }
    api ShopApi from S
    storage primarySql { type: postgres }
    resource shopState { for: C, kind: state, use: primarySql }
    deployable api {
      platform: ${platform}
      contexts: [C]
      dataSources: [shopState]
      serves: ShopApi
      port: 3001
      auth: required
    }
  }
`;

const allFiles = async (platform: string): Promise<string> => {
  const files = await generateSystemFiles(hierarchy(platform));
  return [...files.values()].join("\n\n");
};

describe("currentUser.orgPath — registry dataKey read under hierarchy (node)", () => {
  it("node: resolves orgPath from the registry `data_key`, memoized per request, fail-safe to claim", async () => {
    const files = await allFiles("node");
    // The middleware resolves orgPath via the registered resolver seam.
    expect(files).toMatch(/await resolveOrgPath\(String\(claims\.tenantId \?\? ""\)\)/);
    expect(files).toMatch(/export function registerOrgPathResolver/);
    // Fail-safe: the resolver result falls back to the claim on null/error.
    expect(files).toMatch(/return dataKey \?\? claim;/);
    // Boot registers a db-backed closure reading the registry's data_key.
    expect(files).toMatch(/registerOrgPathResolver\(async \(claim\) => \{/);
    expect(files).toMatch(/\.select\(\{ dataKey: schema\.orgs\.dataKey \}\)/);
    expect(files).toMatch(/\.where\(eq\(schema\.orgs\.id, claim\)\)/);
  });
});
