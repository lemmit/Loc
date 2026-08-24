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

/** The fixture's SECOND axis — the same `tenancy by user.orgId` system with a
 *  HIERARCHY on top (`Organization implements tenantRegistry` + `policy allow
 *  deep on Invoice`).
 *
 *  Kept HERE rather than folded into the corpus `.ddd` on purpose.  The two
 *  axes have to cross somewhere: the flat fixture never renders a deep-scope
 *  sentinel at all, and the hierarchy fixture (`tenancy-hierarchy`) spells its
 *  claim `tenantId`, where a backend reaching for the `tenantId` DEFAULT is
 *  indistinguishable from one binding the declared claim.  But `allow deep` is
 *  outside the Dapper SQL subset (`loom.dapper-unsupported`, the reason
 *  `tenancy-hierarchy` sits in that leg's DAPPER_UNSUPPORTED map), so adding it
 *  to the shared fixture would have taken the whole claim-name feature out of
 *  the dapper compile leg — trading away FLAT claim-name coverage on one
 *  adapter to buy hierarchy coverage. An inline source costs nothing. */
const HIERARCHICAL = `
system TenantClaimNameDeep {
  user { id: guid  orgId: string }

  tenancy by user.orgId of Organization

  subdomain Core {
    context Billing {
      aggregate Invoice with tenantOwned, crudish {
        number: string
        amountDue: int
      }
      repository Invoices for Invoice {
        find byNumber(n: string): Invoice[] where this.number == n
      }
      policy {
        allow deep on Invoice
      }
    }
    context Accounts {
      aggregate Organization with crudish {
        name: string
        implements tenantRegistry
      }
    }
  }
  api BillingApi from Core
  storage primary { type: postgres }
  resource billingState { for: Billing, kind: state, use: primary }
  resource accountsState { for: Accounts, kind: state, use: primary }
  deployable d {
    platform: __PLATFORM__
    contexts: [Billing, Accounts]
    dataSources: [billingState, accountsState]
    serves: BillingApi
    port: 4000
    auth: required
  }
}
`;

async function emittedDeep(platform: string, match: RegExp): Promise<string> {
  const files = await generateSystemFiles(HIERARCHICAL.replace("__PLATFORM__", platform));
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

  // ─── claim name × HIERARCHICAL scope ──────────────────────────────────────
  //
  // The flat-floor assertions above only reach the principal member access the
  // shared enrichment rewrites.  `policy { allow deep on Invoice }` routes the
  // read through each backend's DEEP-SCOPE SENTINEL instead, which spells the
  // claims ITSELF — the anchor (`orgPath`) and, in the NULL-`dataKey` floor arm,
  // the declared tenancy claim.  Elixir defaulted that second one to `tenantId`
  // at three of four call sites, emitting `current_user.tenant_id` for a
  // principal that carries `orgId`: a `KeyError` on every deep/global read.
  it("elixir: the deep-scope floor compares against the DECLARED claim, not `tenantId`", async () => {
    const repo = await emittedDeep("elixir", /invoice_repository\.ex$/);
    // The sentinel is what is under test — assert we are reading the deep form.
    expect(repo).toContain("record.data_key");
    // The floor arm: `(? IS NULL AND ? = ?)` binds the row column against the
    // principal's DECLARED claim.
    expect(repo).toContain("record.tenant_id, ^(current_user && current_user.org_id)");
    // The anchor claim is a different field and stays `orgPath`.
    expect(repo).toContain("current_user.org_path");
    expect(repo).not.toContain("current_user.tenant_id");
  });

  it("elixir: the deep-scope claim is threaded on the WRITE-scope seam too", async () => {
    // `vanillaWriteScopeFilter` is the third of the three sites that dropped
    // the claim; the load-before-write in the canonical update/destroy renders
    // through it, so a claim-name miss there 404s a row the read can see.
    const repo = await emittedDeep("elixir", /invoice_repository\.ex$/);
    const writeGuards = repo
      .split("\n")
      .filter((l) => /record\.id == \^id/.test(l))
      .join("\n");
    expect(writeGuards.length, "no load-before-write guard emitted").toBeGreaterThan(0);
    expect(writeGuards).not.toContain("current_user.tenant_id");
  });

  it("the other four backends already bind the declared claim in the same floor arm", async () => {
    // The cross is elixir's bug, but the ASSERTION is cross-backend: this is
    // what says the fix is parity, not a new elixir-only convention.  Each
    // spells the anchor (`orgPath`) and the tenant floor (`orgId`) separately.
    const cases: [string, RegExp, string, string][] = [
      ["node", /invoice-repository\.ts$/, "requireCurrentUser().orgPath", "requireCurrentUser().orgId"],
      ["python", /invoice_repository\.py$/, "require_current_user().org_path", "require_current_user().org_id"],
      ["java", /InvoiceJpaRepository\.java$/, "user()?.orgPath()", "user()?.orgId()"],
      ["dotnet", /AppDbContext\.cs$/, "_currentUser.User.OrgPath", "_currentUser.User.OrgId"],
    ];
    for (const [platform, file, anchor, tenant] of cases) {
      const out = await emittedDeep(platform, file);
      expect(out, `${platform}: no deep-scope anchor claim`).toContain(anchor);
      expect(out, `${platform}: the NULL-dataKey floor lost the declared claim`).toContain(tenant);
    }
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

// ─── The realtime room key (A2) ─────────────────────────────────────────────
//
// The four SSE backends key their per-tenant rooms off the PRINCIPAL, and all
// four spelled `tenantId` literally — the row column, not the claim.  Under
// this fixture's `tenancy by user.orgId` that member does not exist on the
// emitted `User` shape: .NET/Java fail to compile, python raises per publish,
// and node reads `undefined` through its cast, so every connection joins no
// room and every tenant-scoped event degrades to a cross-tenant broadcast.
// The claim now rides the shared plan (`realtimeRoomPlan`), cased per backend.

describe("realtime room key — the SSE backends read the DECLARED claim", () => {
  it("node: the ambient + connect-time room keys read `orgId`", async () => {
    const rt = await emitted("node", /http\/realtime\.ts$/);
    expect(rt).toContain("const user = requestContext()?.currentUser as { orgId?: unknown }");
    expect(rt).toContain('typeof principal?.orgId === "string" ? principal.orgId : undefined');
    expect(rt).not.toContain("tenantId");
  });

  it("dotnet: the hub and the SSE endpoint read `OrgId`", async () => {
    const hub = await emitted("dotnet", /Infrastructure\/Realtime\/RealtimeHub\.cs$/);
    expect(hub).toContain("user.OrgId.ToString()");
    expect(hub).not.toContain("TenantId");
    // Program.cs derives the connecting principal's room independently.
    const program = await emitted("dotnet", /Program\.cs$/);
    expect(program).toContain("__rtUser.OrgId.ToString()");
    expect(program).not.toContain("__rtUser.TenantId");
  });

  it("java: the room-key accessor reads `orgId()`", async () => {
    const rt = await emitted("java", /RealtimeController\.java$/);
    expect(rt).toContain("user.orgId() == null ? null : String.valueOf(user.orgId())");
    expect(rt).not.toContain("tenantId");
  });

  it("python: the room-key helper reads `org_id`", async () => {
    const rt = await emitted("python", /app\/realtime\.py$/);
    expect(rt).toContain(
      "return None if user is None or user.org_id is None else str(user.org_id)",
    );
    expect(rt).not.toContain("tenant_id");
  });

  // The A4 half, asserted on the emitted artefact rather than the plan: the
  // fixture's `InvoiceReminderSent` carries no `<Agg> id`, so the id-reference
  // classifier put it in the GLOBAL set and streamed one tenant's invoice
  // number to every connected tenant.
  it("an id-less event out of the tenant-owned context is tenant-scoped, not global", async () => {
    const rt = await emitted("node", /http\/realtime\.ts$/);
    expect(rt).toContain(
      'const TENANT_SCOPED_EVENT_TYPES: ReadonlySet<string> = new Set(["InvoiceIssued", "InvoiceReminderSent"]);',
    );
    // With no id reference the ticket degrades to the `type` alone.
    expect(rt).toContain("InvoiceReminderSent: [],");
  });
});
