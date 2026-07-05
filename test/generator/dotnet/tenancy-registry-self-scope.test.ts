// ---------------------------------------------------------------------------
// .NET backend — derived tenancy registry self-scope filter (multi-tenancy
// Phase 1b, capstone decision 4).
//
// The registry's derived `this.id == currentUser.tenantId` rides the same EF
// named-query-filter path as `tenantOwned`'s predicate.  `Id` is the
// strongly-typed `<Agg>Id` record struct, so the string claim is bound as the
// id's value type at the accessor site: `new OrganizationId(Guid.Parse(...))`.
// The wrapped side references no lambda parameter, so EF funcletizes it into
// a query parameter and translates the comparison through the id's
// `HasConversion` — exactly like `GetByIdAsync`'s `x.Id == id`.
//
// Principal-referencing filters install on AppDbContext (via `OnModelCreating`)
// and read the injected scoped `ICurrentUserAccessor` (`_currentUser.User`), NOT
// a static ambient — a static filter is baked once at model build and fails to
// isolate per request (verified at runtime).  The stateless per-entity config
// carries only principal-free filters.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = readFileSync("test/fixtures/corpus/tenancy-owned.ddd", "utf8").replace(
  "__PLATFORM__",
  "dotnet",
);

describe("dotnet generator — derived registry self-scope filter", () => {
  it("installs the self-scope as a per-request HasQueryFilter on AppDbContext (Guid.Parse binding)", async () => {
    const files = await generateSystemFiles(SRC);
    const ctx = files.get("d/Infrastructure/Persistence/AppDbContext.cs")!;
    expect(ctx).toContain(
      'modelBuilder.Entity<Organization>().HasQueryFilter("IdFilter", x => x.Id == new OrganizationId(Guid.Parse(_currentUser.User.TenantId)));',
    );
    // The filter reads an INJECTED scoped accessor (proper DI) so EF re-evaluates
    // it per request — not a static ambient baked at model build.
    expect(ctx).toContain(
      "public AppDbContext(DbContextOptions<AppDbContext> options, ICurrentUserAccessor currentUser)",
    );
    // …and the stateless per-entity config no longer carries the principal filter.
    const cfg = files.get(
      "d/Infrastructure/Persistence/Configurations/OrganizationConfiguration.cs",
    )!;
    expect(cfg).not.toContain("HasQueryFilter");
  });

  it("binds a same-typed guid claim without the parse", async () => {
    const files = await generateSystemFiles(SRC.replace("tenantId: string", "tenantId: guid"));
    const ctx = files.get("d/Infrastructure/Persistence/AppDbContext.cs")!;
    expect(ctx).toContain(
      'modelBuilder.Entity<Organization>().HasQueryFilter("IdFilter", x => x.Id == new OrganizationId(_currentUser.User.TenantId));',
    );
  });

  it("does NOT thread the claim into the registry's create path (no stamp interceptor arm)", async () => {
    const files = await generateSystemFiles(SRC);
    const interceptor = files.get("d/Infrastructure/Persistence/AuditableInterceptor.cs");
    // The interceptor (if emitted for tenantOwned's stamp) must not touch the
    // registry — only Invoice carries the tenantId stamp.
    if (interceptor) {
      expect(interceptor).not.toContain("case Organization");
    }
  });
});
