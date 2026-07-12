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
        aggregate Org {
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

describe("currentUser.orgPath — registry dataKey read under hierarchy (java)", () => {
  it("java: `orgPath()` delegates to a per-request memoized registry `data_key` read, fail-safe to claim", async () => {
    const files = await allFiles("java");
    // The User record accessor still exists (the SpEL use-site
    // `@currentUserAccessor.user().orgPath()` binds it) — but now delegates.
    expect(files).toMatch(/public String orgPath\(\) \{/);
    expect(files).toMatch(/\.orgPath\(\)/);
    expect(files).toMatch(/return OrgPathResolver\.resolve\(/);
    // The static holder memoizes per request and falls back to the claim.
    expect(files).toMatch(/public static String resolve\(String claim\)/);
    expect(files).toMatch(/resolved = dataKey == null \? claim : dataKey;/);
    // Boot @Component registers a JdbcTemplate closure reading the registry
    // `data_key`, binding the string claim as the guid id (fail-closed parse).
    expect(files).toMatch(/OrgPathResolver\.register\(claim -> \{/);
    expect(files).toMatch(
      /"SELECT data_key FROM c\.orgs WHERE id = \?", String\.class, java\.util\.UUID\.fromString\(claim\)/,
    );
  });
});

describe("currentUser.orgPath — registry dataKey read under hierarchy (dotnet)", () => {
  it("dotnet: memoized OrgPath slot + EF resolver reading the registry `data_key`, fail-safe to claim", async () => {
    const files = await allFiles("dotnet");
    // The User record's OrgPath becomes a settable slot memoizing the resolved
    // path, defaulting to the claim (fail-safe) — no longer the flat computed
    // property.
    expect(files).toMatch(
      /public string OrgPath\s*\{\s*get => _orgPath \?\? \$"\{TenantId\}";\s*set => _orgPath = value;\s*\}/,
    );
    // The middleware method-injects the resolver, resolves once per request,
    // and memoizes onto the principal.
    expect(files).toMatch(/IUserVerifier verifier, IOrgPathResolver orgPathResolver/);
    expect(files).toMatch(
      /await orgPathResolver\.ResolveAsync\(user\.TenantId, ctx\.RequestAborted\)/,
    );
    expect(files).toMatch(/user\.OrgPath = orgPath;/);
    // The EF resolver reads the registry's `data_key` by id, ignoring the
    // registry's own self-scope query filter, wrapping the claim to the id type.
    expect(files).toMatch(/public interface IOrgPathResolver/);
    expect(files).toMatch(/Guid\.TryParse\(claim, out var raw\)/);
    expect(files).toMatch(
      /_db\.Orgs\s*\.IgnoreQueryFilters\(\)\s*\.Where\(o => o\.Id == id\)\s*\.Select\(o => o\.DataKey\)\s*\.FirstOrDefaultAsync\(cancellationToken\)/,
    );
    // Boot registers the scoped resolver.
    expect(files).toMatch(/builder\.Services\.AddScoped<IOrgPathResolver, EfOrgPathResolver>\(\)/);
  });
});

describe("currentUser.orgPath — registry dataKey read under hierarchy (elixir)", () => {
  it("elixir: put_org_path reads the registry `data_key` via the Repo, fail-safe to claim", async () => {
    const files = await allFiles("elixir");
    // `put_org_path` now delegates to a per-request registry read.
    expect(files).toMatch(
      /defp put_org_path\(user\), do: Map\.put\(user, :org_path, resolve_org_path/,
    );
    // The read goes through the registry's Ecto schema module (schema prefix +
    // binary_id cast) via the app `Repo`, selecting the `data_key` column.
    expect(files).toMatch(/Api\.Repo\.one\(/);
    expect(files).toMatch(/from o in Api\.C\.Org, where: o\.id == \^claim, select: o\.data_key/);
    // Fail-safe: nil/blank/malformed claim and any query error fall back to the
    // claim (the root-segment path) — never crashes.
    expect(files).toMatch(/defp resolve_org_path\(claim\) when is_binary\(claim\) and claim != ""/);
    expect(files).toMatch(/rescue\n\s*_ -> claim/);
    expect(files).toMatch(/defp resolve_org_path\(claim\), do: to_string\(claim\)/);
    // The `from/2` import is present (hierarchy mode only).
    expect(files).toMatch(/import Ecto\.Query, only: \[from: 2\]/);
  });
});
