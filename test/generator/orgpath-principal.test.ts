// `currentUser.orgPath` — the derived tenant materialized-path principal
// member (multi-tenancy Phase 2, plan P2.1) — across all five backends.
//
// `orgPath` is NOT a `user {}` claim: the `claims:` map is a static
// token→field projection with no derived-value carrier, so each backend
// exposes `orgPath` as a computed accessor on the request principal, derived
// per-request from the tenancy claim (the root-segment path — the defined
// fallback while the registry carries no `dataKey` column yet, P2.2).  This
// pins both halves: the accessor DEFINITION on the principal shape, and a
// USE site where a filter referencing `currentUser.orgPath` renders through
// each backend's principal accessor.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const system = (platform: string) => `
  system Shop {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        aggregate Doc with tenantOwned {
          owner: string
          filter this.owner == currentUser.orgPath
        }
        aggregate Org { name: string }
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
  const files = await generateSystemFiles(system(platform));
  return [...files.values()].join("\n\n");
};

// Per-backend: [accessor definition, use-site rendering] — both must appear.
const cases: Record<string, [RegExp, RegExp]> = {
  // Hono: `orgPath` on the request principal `User` (derived in the middleware
  // from the verifier's claims), read via `requireCurrentUser().orgPath`.
  node: [/const orgPath = String\(claims\.tenantId \?\? ""\)/, /requireCurrentUser\(\)\.orgPath/],
  // .NET: computed record property `OrgPath`, read off the current user.
  dotnet: [
    /public string OrgPath => \$"\{TenantId\}";/,
    /(_currentUser\.User|CurrentUser!)\.OrgPath/,
  ],
  // Python: computed `@property org_path`, read via `.org_path`.
  python: [/def org_path\(self\) -> str:/, /require_current_user\(\)\.org_path/],
  // Java: record accessor `orgPath()`, read via `.orgPath()` in the SpEL query.
  java: [/public String orgPath\(\) \{/, /\.orgPath\(\)/],
  // Elixir: `put_org_path/1` derivation step, read via `current_user.org_path`.
  elixir: [/defp put_org_path\(user\), do: Map\.put\(user, :org_path/, /current_user\.org_path/],
};

describe("currentUser.orgPath — derived principal member across backends", () => {
  for (const [platform, [accessor, useSite]] of Object.entries(cases)) {
    it(`${platform}: exposes and consumes the orgPath principal accessor`, async () => {
      const files = await allFiles(platform);
      expect(files).toMatch(accessor);
      expect(files).toMatch(useSite);
    });
  }
});

// `currentUser.rootOrg` — the ROOT-org segment principal member (multi-tenancy
// Phase 2, plan P2.5): the first segment of `orgPath`, a PURE string derivation
// off the already-resolved `orgPath` (no extra DB read).  It anchors the
// `global` read level's root-subtree widening.  Because it is derived off
// `orgPath`, a dotless (root-only) `orgPath` yields `rootOrg == orgPath` — the
// documented flat-tenancy coincidence.
const rootOrgSystem = (platform: string) => `
  system Shop {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        aggregate Doc with tenantOwned {
          owner: string
          filter this.owner == currentUser.rootOrg
        }
        aggregate Org { name: string }
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

const rootOrgCases: Record<string, [RegExp, RegExp]> = {
  // Hono: `rootOrg` derived from the computed `orgPath` in the middleware +
  // the `rootOrgOf(...)` helper; read via `requireCurrentUser().rootOrg`.
  node: [/rootOrg: rootOrgOf\(orgPath\)/, /requireCurrentUser\(\)\.rootOrg/],
  // .NET: computed record property `RootOrg` (first segment of OrgPath).
  dotnet: [/public string RootOrg/, /\.RootOrg/],
  // Python: computed `@property root_org` off `self.org_path`.
  python: [/def root_org\(self\) -> str:/, /\.root_org/],
  // Java: record accessor `rootOrg()` off `orgPath()`.
  java: [/public String rootOrg\(\) \{/, /\.rootOrg\(\)/],
  // Elixir: `put_root_org/1` derivation step off `:org_path`.
  elixir: [/defp put_root_org\(user\), do: Map\.put\(user, :root_org/, /current_user\.root_org/],
};

describe("currentUser.rootOrg — derived principal member across backends", () => {
  for (const [platform, [accessor, useSite]] of Object.entries(rootOrgCases)) {
    it(`${platform}: exposes and consumes the rootOrg principal accessor`, async () => {
      const files = await generateSystemFiles(rootOrgSystem(platform));
      const text = [...files.values()].join("\n\n");
      expect(text).toMatch(accessor);
      expect(text).toMatch(useSite);
    });
  }
});
