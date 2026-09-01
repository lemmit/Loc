// F2-ADP-9 — the Dapper repository's SQL honoured `ignoring`, its PARAMETER
// BINDING did not.
//
// `capabilityFilterSqlFor(bypass)` drops the bypassed conjuncts from the WHERE,
// but the principal-claim binding was collected once from the FULL
// `capabilityFilters` list and reused for every find.  So an `ignoring *` find
// emitted:
//
//     "… FROM deeps"          ← no WHERE at all
//     new { __cu_tenantId = RequestContext.Current!.CurrentUser!.TenantId }
//
// Two defects in one line: a parameter the statement never references, and a
// null-forgiving dereference of the principal on the one read whose whole
// point is that it runs OUTSIDE the principal scope — so `ignoring *` on an
// unauthenticated call is a NullReferenceException, i.e. a 500.
//
// The fix routes both halves through the same keep/drop decision
// (`keptFilterParts`), so the parameter object binds exactly what the SELECT
// names.  Compile-verified under sdk:10.0 with /warnaserror.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system BypassShop {
  user { id: guid  tenantId: string }

  capability owned {
    tenantId: string
    filter this.tenantId == currentUser.tenantId
  }
  subdomain Sales {
    context Catalog {
      aggregate Deep with owned {
        label: string
        filter this.label != ""
      }
      repository Deeps for Deep {
        find allDeep(): Deep[] ignoring *
        find justCap(): Deep[] ignoring owned
        find scoped(): Deep[] where this.label != "x"
      }
    }
  }
  api CatalogApi from Sales
  storage primary { type: postgres }
  resource catState { for: Catalog, kind: state, use: primary }
  deployable api {
    platform: dotnet { persistence: dapper }
    contexts: [Catalog]
    dataSources: [catState]
    serves: CatalogApi
    port: 8080
    auth: required
  }
}
`;

function methodBody(repo: string, name: string): string {
  const start = repo.indexOf(`public async Task<List<Deep>> ${name}(`);
  if (start < 0) throw new Error(`no ${name} method in the emitted repository`);
  const end = repo.indexOf("\n    public ", start + 1);
  return repo.slice(start, end < 0 ? undefined : end);
}

async function repository(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  const key = [...files.keys()].find((k) =>
    k.endsWith("Infrastructure/Repositories/DeepRepository.cs"),
  );
  if (!key) throw new Error("no DeepRepository.cs");
  return files.get(key)!;
}

describe("dapper — `ignoring` drops the principal BINDING, not just the SQL", () => {
  it("`ignoring *` binds no principal param and never dereferences CurrentUser", async () => {
    const body = methodBody(await repository(), "AllDeep");
    // Both capability conjuncts are gone from the statement …
    expect(body).not.toContain("tenant_id = @__cu_tenantId");
    expect(body).not.toContain("label <> ''");
    // … so neither may be bound, and the ambient principal must not be read.
    expect(body, "an ignoring * read still binds a claim its SQL never names").not.toContain(
      "__cu_tenantId",
    );
    expect(body, "an ignoring * read still dereferences CurrentUser!").not.toContain(
      "CurrentUser!",
    );
  });

  it("`ignoring <Cap>` drops only that capability's claim", async () => {
    const body = methodBody(await repository(), "JustCap");
    // The named capability's predicate is gone …
    expect(body).not.toContain("tenant_id = @__cu_tenantId");
    expect(body).not.toContain("__cu_tenantId");
    // … but the origin-less `filter this.label != ""` is NOT bypassable by name.
    expect(body).toContain("label <> ''");
  });

  it("a plain find is untouched — it names the claim and binds it", async () => {
    const body = methodBody(await repository(), "Scoped");
    expect(body).toContain("tenant_id = @__cu_tenantId");
    expect(body).toContain("__cu_tenantId = RequestContext.Current!.CurrentUser!.TenantId");
  });

  it("GetById keeps the full filter set — it carries no bypass", async () => {
    const repo = await repository();
    const start = repo.indexOf("public async Task<Deep?> GetByIdAsync(");
    expect(start).toBeGreaterThan(-1);
    const body = repo.slice(start, repo.indexOf("\n    public ", start + 1));
    expect(body).toContain("tenant_id = @__cu_tenantId");
  });
});
