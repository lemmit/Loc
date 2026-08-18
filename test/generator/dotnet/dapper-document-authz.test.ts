// `persistence: dapper` + `shape: document` + a `policy { … }` read ladder —
// the two EF leaks #2599 pinned in `DAPPER_COMPILE_SKIP` (fixture
// `policy-document`), plus the silent read-filter gap they sat next to.
//
// A document aggregate is ONE opaque jsonb column, so the capability filter's
// fields (`tenantId`, `dataKey`, `isDeleted`) have no column a WHERE fragment
// could name — the predicate has to run IN-APP over the rehydrated instance,
// exactly as the EF document repository (`renderDocumentRepositoryImpl`) and
// node/java/python do.  The Dapper twin had NEITHER half:
//
//   1. no `_CapabilityVisible` at all — a `tenantOwned` document aggregate read
//      UNFILTERED across tenants under this adapter.  Silent: it compiled, and
//      `validateContextFilterSupport` claims .NET filters every shape.
//   2. no `GetByIdForWriteAsync` — the Domain interface declares it whenever the
//      aggregate carries a `writeScopeFilter`, so the project failed CS0535.
//
// And the hierarchy seam leaked EF outright: `EfOrgPathResolver.cs` was emitted
// whatever the persistence adapter was (`using Microsoft.EntityFrameworkCore;`
// + an `AppDbContext` ctor param — CS0234 + 2x CS0246 on a Dapper project).
//
// The compile halves are gated end-to-end by `corpus-dotnet-dapper-build`
// (`policy-document` is no longer skipped there); this suite is the fast
// structural pin, and the ONLY gate on the silent read-filter half.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

/** A document-shaped, tenant-owned aggregate under a subtree read ladder, plus
 *  the hierarchy registry the `deep` rung's materialized path needs — the
 *  shape of `test/fixtures/corpus/policy-document.ddd`. */
const SRC = `
  system S {
    user { id: guid  role: string  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain D {
      context C {
        aggregate Thing shape: document, with crudish, tenantOwned {
          label: string
        }
        aggregate Note shape: document, with crudish, tenantOwned {
          body: string
        }
        repository Things for Thing {
          find byLabel(l: string): Thing[] where this.label == l
        }
        repository Notes for Note { }
        policy {
          allow deep on Thing
          deny on Note
        }
      }
      context R {
        aggregate Org with crudish { name: string  implements tenantRegistry }
        repository Orgs for Org { }
      }
    }
    api MainApi from D
    storage primary { type: postgres }
    resource mainState { for: C, kind: state, use: primary }
    resource regState { for: R, kind: state, use: primary }
    deployable api {
      platform: dotnet { persistence: dapper }
      contexts: [C, R]
      dataSources: [mainState, regState]
      serves: MainApi
      port: 3000
      auth: required
    }
  }
`;

let cache: Map<string, string> | undefined;
async function files(): Promise<Map<string, string>> {
  cache ??= (await generateSystems(await parseValid(SRC))).files;
  return cache;
}

async function file(suffix: string): Promise<string> {
  const all = await files();
  const key = [...all.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return all.get(key!)!;
}

describe("the hierarchy `orgPath` resolver follows the persistence adapter", () => {
  it("emits the Dapper resolver, not the EF one", async () => {
    const all = await files();
    const paths = [...all.keys()];
    expect(
      paths.filter((p) => p.endsWith("Infrastructure/Persistence/EfOrgPathResolver.cs")),
      "the EF resolver references Microsoft.EntityFrameworkCore + AppDbContext, which a " +
        "`persistence: dapper` project does not have (CS0234 + 2x CS0246)",
    ).toEqual([]);
    expect(
      paths.some((p) => p.endsWith("Infrastructure/Persistence/DapperOrgPathResolver.cs")),
      "a hierarchy registry still needs an IOrgPathResolver implementation",
    ).toBe(true);
  });

  it("the Dapper resolver reads `data_key` over raw Npgsql, never EF", async () => {
    const src = await file("Infrastructure/Persistence/DapperOrgPathResolver.cs");
    expect(src).not.toContain("Microsoft.EntityFrameworkCore");
    expect(src).not.toContain("AppDbContext");
    expect(src).toContain("NpgsqlDataSource");
    expect(src).toContain("SELECT data_key FROM orgs WHERE id = @id");
    // Fail-safe contract, identical to the EF twin: every failure path yields
    // `null` so the middleware falls back to the claim.
    expect(src).toContain("Guid.TryParse(claim, out var id)");
    expect(src).toContain("catch (Exception)");
  });

  it("Program.cs registers the adapter's own resolver", async () => {
    const program = await file("Program.cs");
    expect(program).toContain(
      "builder.Services.AddScoped<IOrgPathResolver, DapperOrgPathResolver>();",
    );
    expect(program).not.toContain("EfOrgPathResolver");
  });
});

describe("the Dapper document repository carries the authorization ladder", () => {
  it("implements the write-scope port member the `allow` ladder declares", async () => {
    const iface = await file("Domain/Things/IThingRepository.cs");
    expect(iface, "precondition: the ladder puts GetByIdForWriteAsync on the port").toContain(
      "GetByIdForWriteAsync",
    );
    const repo = await file("Infrastructure/Repositories/ThingRepository.cs");
    expect(repo, "CS0535 without it").toContain(
      "public async Task<Thing?> GetByIdForWriteAsync(ThingId id, CancellationToken cancellationToken = default)",
    );
    expect(repo).toContain("private static bool _WriteScopeAllows(Thing x) =>");
  });

  it("applies the capability read filter on ALL THREE read paths", async () => {
    const repo = await file("Infrastructure/Repositories/ThingRepository.cs");
    expect(repo).toContain("private static bool _CapabilityVisible(Thing x) =>");
    // GetByIdAsync — an out-of-scope row reads as missing (→ 404), matching
    // what the relational adapter's spliced WHERE does to the same lookup.
    expect(repo).toContain("return _CapabilityVisible(__rec) ? __rec : null;");
    // FindManyByIdsAsync + every author find fold through `.Where(...)`.
    const guarded = repo.split("\n").filter((l) => l.includes(".Where(_CapabilityVisible)"));
    expect(
      guarded.length,
      "FindManyByIdsAsync, findAll and byLabel must each narrow to the visible set",
    ).toBeGreaterThanOrEqual(3);
  });

  it("the subtree (`allow deep`) rung reaches the predicate, not just the flat floor", async () => {
    const repo = await file("Infrastructure/Repositories/ThingRepository.cs");
    // DEEP_SCOPE_SEMANTICS: descendant-or-self on the materialized path, with
    // the NULL-`dataKey` fallback to the flat tenant floor.  Ordinal, because
    // this is an EXECUTED position (no EF expression tree to translate).
    expect(repo).toContain("x.DataKey.StartsWith(");
    expect(repo).toContain("StringComparison.Ordinal");
    expect(repo).toContain("x.DataKey == null && x.TenantId ==");
  });

  it("a `deny` ladder renders as a method body, never an inlined constant", async () => {
    const repo = await file("Infrastructure/Repositories/NoteRepository.cs");
    // Inlined, `false` would make the following statement unreachable — CS0162,
    // an error under /warnaserror.  As a method body it is clean.
    expect(repo).toContain("private static bool _CapabilityVisible(Note x) =>");
    expect(repo).toContain("(false)");
    expect(repo).not.toContain("if (!(false))");
  });
});
