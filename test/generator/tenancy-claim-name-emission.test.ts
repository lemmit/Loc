// Cross-backend emission gate for the tenancy claim NAME (M-T3.7(a)).
//
// `tenancy by user.<claim>` is documented as taking any claim name, but the
// `tenantOwned` capability hardcoded `currentUser.tenantId` on the principal
// side of its stamp and filter — so the feature only worked when the author
// happened to name the claim `tenantId`, which every fixture did.  Enrichment
// now binds the declared claim (`bindTenancyClaim`).
//
// This pins the emitted result on all five backends, because the IR-level test
// (`test/ir/tenancy-claim-binding.test.ts`) cannot see a backend that reaches
// for the `TENANT_OWNED_TENANT_ID_FIELD` constant on the principal side of its
// own scope-sentinel renderer — which four of the five did.
//
// Both halves matter, so both are asserted:
//   - the ROW column stays `tenantId` (the capability owns it), and
//   - the PRINCIPAL member follows the declaration (`orgId`).
// Asserting only the second would pass a backend that renamed the column too.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const FIXTURE = readFileSync("test/fixtures/corpus/tenancy-claim-name.ddd", "utf8");
const src = (platform: string) => FIXTURE.replace("__PLATFORM__", platform);

/** Concatenated contents of every emitted file whose path matches. */
async function emitted(platform: string, match: RegExp): Promise<string> {
  const files = await generateSystemFiles(src(platform));
  const hits = [...files.entries()].filter(([p]) => match.test(p));
  expect(hits.length, `no emitted file matched ${match} for ${platform}`).toBeGreaterThan(0);
  return hits.map(([, c]) => c).join("\n");
}

describe("tenancy claim name — emitted principal reads follow the declaration", () => {
  it("node: the tenant floor compares the row column to the DECLARED claim", async () => {
    const repo = await emitted("node", /invoice-repository\.ts$/);
    expect(repo).toContain("eq(schema.invoices.tenantId, requireCurrentUser().orgId)");
    expect(repo).not.toContain("requireCurrentUser().tenantId");
  });

  it("node: the create stamp copies the DECLARED claim into the row column", async () => {
    const stamp = await emitted("node", /audit-stamp\.ts$/);
    expect(stamp).toContain("tenantId: currentUser.orgId");
  });

  it("python: filter and stamp read `org_id`", async () => {
    const repo = await emitted("python", /invoice_repository\.py$/);
    expect(repo).toContain("InvoiceRow.tenant_id == require_current_user().org_id");
    expect(repo).not.toContain("require_current_user().tenant_id");
  });

  it("dotnet: the EF query filter reads the DECLARED claim", async () => {
    const ctx = await emitted("dotnet", /AppDbContext\.cs$/);
    expect(ctx).toContain("x.TenantId == _currentUser.User.OrgId");
    expect(ctx).not.toContain("_currentUser.User.TenantId");
  });

  it("java: the JPQL principal accessor reads the DECLARED claim", async () => {
    const repo = await emitted("java", /InvoiceJpaRepository\.java$/);
    expect(repo).toContain("e.tenantId = :#{@currentUserAccessor.user()?.orgId()}");
    expect(repo).not.toContain("user()?.tenantId()");
  });

  it("elixir: the Ecto filter reads the DECLARED claim", async () => {
    const repo = await emitted("elixir", /invoice_repository\.ex$/);
    expect(repo).toContain("current_user.org_id");
    expect(repo).not.toContain("current_user.tenant_id");
  });

  it("every backend keeps the ROW column named `tenantId` (the capability owns it)", async () => {
    // The declaration renames the CLAIM, never the column — a backend that
    // followed the claim on both sides would emit a schema that disagrees with
    // the shared MigrationsIR.  Emitted DDL is snake_case on every backend.
    for (const platform of ["node", "python", "java", "dotnet", "elixir"] as const) {
      const files = await generateSystemFiles(src(platform));
      // .NET emits EF migrations as `.cs`; the SQL backends as `.sql`/`.exs`.
      const migration = [...files.entries()].find(
        ([p]) => /\.(sql|exs|cs)$/.test(p) && /migrat/i.test(p),
      );
      expect(migration, `${platform}: no migration emitted`).toBeDefined();
      expect(migration![1], platform).toContain("tenant_id");
      expect(migration![1], platform).not.toContain("org_id");
    }
  });
});
