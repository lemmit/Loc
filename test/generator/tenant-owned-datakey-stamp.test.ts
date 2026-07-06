// `dataKey := currentUser.orgPath` — the `tenantOwned` capability's second
// stamp assignment (multi-tenancy Phase 2, plan P2.3 —
// docs/plans/multi-tenancy-phase2.md), across all five backends that execute
// domain logic. Rides the exact `contextStamps` pipeline `tenantId :=
// currentUser.tenantId` already uses — same expression renderer, same
// lifecycle-stamp emission per backend — so each backend needs no new code,
// only a new stamp assignment in the value list.
//
// Pins two facts per backend: (1) the stamp assignment renders
// `currentUser.orgPath` (the P2.1 principal accessor) into the create
// lifecycle hook beside the `tenantId` claim stamp, and (2) the persisted
// `dataKey`/`data_key` column exists on the entity/schema side while staying
// OFF every read-response / DTO surface (authorization.md §2 — "never
// serialized").

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const system = (platform: string) => `
  system Shop {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        aggregate Account with tenantOwned {
          balance: int
        }
        aggregate Org { name: string }
        repository Accounts for Account { }
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

const filesFor = (platform: string): Promise<Map<string, string>> =>
  generateSystemFiles(system(platform));

describe("tenantOwned dataKey stamp — node (Hono/Drizzle)", () => {
  it("stamps dataKey from currentUser.orgPath in the persist-time audit helper", async () => {
    const files = await filesFor("node");
    const helper = files.get("api/db/audit-stamp.ts")!;
    expect(helper).toContain("tenantId: currentUser.tenantId");
    expect(helper).toContain("dataKey: currentUser.orgPath");
  });

  it("the drizzle schema carries a nullable data_key column, absent from the response DTO", async () => {
    const files = await filesFor("node");
    const schema = files.get("api/db/schema.ts")!;
    expect(schema).toContain(`dataKey: text("data_key")`);
    const routes = files.get("api/http/account.routes.ts")!;
    expect(routes).not.toMatch(/dataKey/);
  });
});

describe("tenantOwned dataKey stamp — .NET (EF Core)", () => {
  it("the AuditableInterceptor stamps DataKey from the ambient OrgPath accessor", async () => {
    const files = await filesFor("dotnet");
    const src = files.get("api/Infrastructure/Persistence/AuditableInterceptor.cs")!;
    expect(src).toMatch(
      /ctx\.Entry\(e\)\.Property\(x => x\.TenantId\)\.CurrentValue = RequestContext\.Current!\.CurrentUser!\.TenantId;/,
    );
    expect(src).toMatch(
      /ctx\.Entry\(e\)\.Property\(x => x\.DataKey\)\.CurrentValue = RequestContext\.Current!\.CurrentUser!\.OrgPath;/,
    );
  });

  it("the entity carries a nullable DataKey column, absent from the response DTO", async () => {
    const files = await filesFor("dotnet");
    const entity = files.get("api/Domain/Accounts/Account.cs")!;
    expect(entity).toMatch(/public string\? DataKey \{ get; private set; \}/);
    const dto = [...files.entries()].find(
      ([p]) => p.includes("Response") && p.includes("Account"),
    )?.[1];
    expect(dto).toBeDefined();
    expect(dto!).not.toMatch(/DataKey/);
  });
});

describe("tenantOwned dataKey stamp — Python (FastAPI/SQLAlchemy)", () => {
  it("the domain _stamp_on_create sets _data_key from current_user.org_path", async () => {
    const files = await filesFor("python");
    const domain = files.get("api/app/domain/account.py")!;
    expect(domain).toContain("        self._tenant_id = current_user.tenant_id");
    expect(domain).toContain("        self._data_key = current_user.org_path");
  });

  it("the response schema never carries data_key", async () => {
    const files = await filesFor("python");
    const routes = files.get("api/app/http/account_routes.py")!;
    expect(routes).not.toMatch(/data_key/);
  });
});

describe("tenantOwned dataKey stamp — Java (Spring/JPA)", () => {
  it("the @PrePersist hook sets dataKey from currentUser.orgPath()", async () => {
    const files = await filesFor("java");
    const entity = [...files.entries()].find(
      ([p]) => p.endsWith("/Account.java") && p.includes("features"),
    )?.[1];
    expect(entity).toBeDefined();
    expect(entity).toContain("        this.tenantId = currentUser.tenantId();");
    expect(entity).toContain("        this.dataKey = currentUser.orgPath();");
  });

  it("the response DTO never carries dataKey", async () => {
    const files = await filesFor("java");
    const dto = files.get("api/src/main/java/com/loom/api/features/accounts/AccountResponse.java");
    expect(dto).toBeDefined();
    expect(dto!).not.toMatch(/dataKey/);
  });
});

describe("tenantOwned dataKey stamp — Elixir (plain Ecto/Phoenix)", () => {
  it("the repository put_changes :data_key from current_user.org_path", async () => {
    const files = await filesFor("elixir");
    const repo = [...files.entries()].find(([p]) => p.endsWith("account_repository.ex"))?.[1];
    expect(repo).toBeDefined();
    expect(repo).toContain(
      "|> Ecto.Changeset.put_change(:tenant_id, current_user && current_user.tenant_id)",
    );
    expect(repo).toContain(
      "|> Ecto.Changeset.put_change(:data_key, current_user && current_user.org_path)",
    );
  });

  it("the response schema never renders data_key", async () => {
    const files = await filesFor("elixir");
    const view = files.get("api/lib/api_web/api/schemas/account_response.ex");
    expect(view).toBeDefined();
    expect(view!).not.toMatch(/data_key/);
  });
});
