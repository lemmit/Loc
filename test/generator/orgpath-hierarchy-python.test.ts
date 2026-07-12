// `currentUser.orgPath` under HIERARCHY on the PYTHON backend (multi-tenancy
// Phase 2, plan P2.2 — the python sibling of orgpath-hierarchy.test.ts, which
// covers node): once the registry opts into `tenantRegistry` (a `data_key`
// column exists), the principal's `org_path` becomes a per-request memoized
// read of the caller org's materialized `data_key` from the registry table,
// keyed by the tenancy claim, falling back to the claim (root-segment path)
// when the row / dataKey is absent (fail-safe).  Flat tenancy keeps P2.1's
// claim-copy `@property` (pinned by orgpath-principal.test.ts); this pins the
// python hierarchy swap.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const hierarchy = `
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
      platform: python
      contexts: [C]
      dataSources: [shopState]
      serves: ShopApi
      port: 3001
      auth: required
    }
  }
`;

describe("currentUser.orgPath — registry data_key read under hierarchy (python)", () => {
  it("python: resolves org_path from the registry `data_key`, memoized per request, fail-safe to claim", async () => {
    const files = await generateSystemFiles(hierarchy);
    const middleware = files.get("api/app/auth/middleware.py");
    const userMod = files.get("api/app/auth/user.py");
    expect(middleware).toBeDefined();
    expect(userMod).toBeDefined();

    // The middleware queries the registry's `data_key` (schema-qualified table:
    // context C's schema `c`, table `orgs`).
    expect(middleware).toMatch(/text\("SELECT data_key FROM c\.orgs WHERE id = :claim LIMIT 1"\)/);
    // Resolved once per request and stored on the (frozen) principal.
    expect(middleware).toMatch(/object\.__setattr__\(user, "org_path", await _resolve_org_path\(/);
    // Fail-safe: a missing row / NULL data_key / any error falls back to the claim.
    expect(middleware).toMatch(/return data_key if isinstance\(data_key, str\) else claim/);
    expect(middleware).toMatch(/except Exception:\n {8}return claim/);
    // The lookup uses the module-level per-request session factory.
    expect(middleware).toMatch(/from app\.db\.engine import session_factory/);
    expect(middleware).toMatch(/async with session_factory\(\) as session:/);

    // `org_path` is a stored attribute (NOT the P2.1 @property), so it's off
    // asdict()/the /auth/me wire and set once per request.
    expect(userMod).toMatch(/^ {4}org_path = ""$/m);
    expect(userMod).not.toMatch(/def org_path\(self\) -> str:/);

    // The use-site (`filter this.owner == currentUser.orgPath`) still renders
    // through the ambient principal accessor — unchanged from P2.1.
    const all = [...files.values()].join("\n\n");
    expect(all).toMatch(/require_current_user\(\)\.org_path/);
  });
});
