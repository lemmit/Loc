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
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = readFileSync("test/fixtures/corpus/tenancy-owned.ddd", "utf8").replace(
  "__PLATFORM__",
  "dotnet",
);

describe("dotnet generator — derived registry self-scope filter", () => {
  it("installs the self-scope as a named HasQueryFilter with the Guid.Parse binding", async () => {
    const files = await generateSystemFiles(SRC);
    const cfg = files.get(
      "d/Infrastructure/Persistence/Configurations/OrganizationConfiguration.cs",
    )!;
    expect(cfg).toContain(
      'builder.HasQueryFilter("IdFilter", x => x.Id == new OrganizationId(Guid.Parse(RequestContext.Current!.CurrentUser!.TenantId)));',
    );
  });

  it("binds a same-typed guid claim without the parse", async () => {
    const files = await generateSystemFiles(SRC.replace("tenantId: string", "tenantId: guid"));
    const cfg = files.get(
      "d/Infrastructure/Persistence/Configurations/OrganizationConfiguration.cs",
    )!;
    expect(cfg).toContain(
      'builder.HasQueryFilter("IdFilter", x => x.Id == new OrganizationId(RequestContext.Current!.CurrentUser!.TenantId));',
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
