// .NET emission for `retrieval` (PR3-C): a context retrieval emits a
// Run<Name>Async repository method (where + sort + paging), and a
// workflow `Repo.run` + `for` loop renders as the method call + a
// `foreach` with a per-iteration SaveAsync.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    aggregate Customer {
      active: bool
      region: string
      name: string
      operation deactivate() { active := false }
    }
    repository Customers for Customer { }
    criterion InRegion(rgn: string) of Customer = region == rgn
    retrieval ByRegion(rgn: string) of Customer { where: InRegion(rgn) sort: [name desc] }

    workflow deactivateRegion {
      create(rgn: string) {
      let matched = Customers.run(ByRegion(rgn), page: { offset: 0, limit: 100 })
      for c in matched {
        c.deactivate()
      }
    }
    }
  }
`;

async function files() {
  return generateDotnet(await parseValid(SRC));
}

describe(".NET generator — retrieval", () => {
  it("emits a Run<Name>Async that applies a reified Specification + paging", async () => {
    const out = await files();
    const repo = out.get("Infrastructure/Repositories/CustomerRepository.cs")!;
    // The signature carries the two trailing optional filter-bypass params
    // (named-filter-bypass.md §11) so an inline `Repo.findAll(...) ignoring …`
    // can name them; `cancellationToken` stays LAST (CA1068) and callers pass
    // it named (it follows the optional `page` + `ignore*` params).
    expect(repo).toMatch(
      /public async Task<IReadOnlyList<Customer>> RunByRegionAsync\(string rgn, \(int\? offset, int\? limit\)\? page = null, FilterBypass bypass = default, CancellationToken cancellationToken = default\)/,
    );
    // The retrieval is a reified Ardalis Specification, applied via
    // `.WithSpecification(...)` + the shared `.ApplyPaging(page)` extension over
    // the `__q` IQueryable (which the bypass params optionally `IgnoreQueryFilters`).
    expect(repo).toMatch(
      /var result = await __q\.WithSpecification\(new ByRegionSpec\(rgn\)\)\.ApplyPaging\(page\)\.ToListAsync\(cancellationToken\);/,
    );
    expect(repo).toMatch(/using Ardalis\.Specification\.EntityFrameworkCore;/);
    // The spec carries the where (reified criterion `where: InRegion(rgn)`) + sort.
    const spec = out.get("Domain/Customers/ByRegionSpec.cs")!;
    expect(spec).toBeDefined();
    expect(spec).toMatch(/public sealed class ByRegionSpec : Specification<Customer>/);
    expect(spec).toMatch(
      /Query\.Where\(new InRegionCriterion\(rgn\)\.ToExpression\(\)\)\.OrderByDescending\(x => x\.Name\);/,
    );
  });

  it("emits the shared ApplyPaging extension + EF-only Ardalis csproj deps", async () => {
    const out = await files();
    const ext = out.get("Infrastructure/Persistence/QueryablePagingExtensions.cs")!;
    expect(ext).toMatch(
      /public static IQueryable<T> ApplyPaging<T>\(this IQueryable<T> query, \(int\? offset, int\? limit\)\? page\)/,
    );
    const csproj = [...out.entries()].find(([k]) => k.endsWith(".csproj"))![1];
    expect(csproj).toMatch(
      /<PackageReference Include="Ardalis\.Specification" Version="9\.3\.1" \/>/,
    );
    expect(csproj).toMatch(
      /<PackageReference Include="Ardalis\.Specification\.EntityFrameworkCore" Version="9\.3\.1" \/>/,
    );
  });

  it("declares the method on the repository interface", async () => {
    const out = await files();
    const iface = out.get("Domain/Customers/ICustomerRepository.cs")!;
    expect(iface).toMatch(
      /Task<IReadOnlyList<Customer>> RunByRegionAsync\(string rgn, \(int\? offset, int\? limit\)\? page = null, FilterBypass bypass = default, CancellationToken cancellationToken = default\);/,
    );
  });

  it("renders the workflow Repo.run + for loop as the call + a foreach with SaveAsync", async () => {
    const out = await files();
    const handler = [...out.entries()].find(
      ([k, v]) => k.includes("DeactivateRegion") && v.includes("RunByRegionAsync"),
    )?.[1];
    expect(handler).toBeDefined();
    expect(handler!).toMatch(
      /var matched = await _customers\.RunByRegionAsync\(command\.Rgn, \(0, 100\), cancellationToken: cancellationToken\);/,
    );
    expect(handler!).toMatch(/foreach \(var c in matched\)/);
    expect(handler!).toMatch(/c\.Deactivate\(\);/);
    expect(handler!).toMatch(/await _customers\.SaveAsync\(c, cancellationToken\);/);
  });
});

// DEBT-24 — a retrieval whose `where` references the principal (`currentUser`)
// reifies its predicate inside the `Specification<T>` ctor, a static position
// with no `currentUser` local.  The principal must resolve through the same
// ambient accessor the EF capability filters use (`RequestContext.Current!.
// CurrentUser!`); otherwise the spec names an unbound `currentUser` (CS0103).
// (A `currentUser` criterion is excluded from `Criterion<T>` reification, so it
// falls to the inline spec path where this binding lives.)  Full system: the
// `user { }` shape is what makes `currentUser` lower to a `current-user` ref.
const PRINCIPAL_SYS = `
system Tenancy {
  user { id: guid  tenantId: string }
  subdomain Core {
    context Ledger {
      aggregate Account ids guid {
        tenantId: string
        balance: int
      }
      repository Accounts for Account { }
      criterion MyTenant of Account = tenantId == currentUser.tenantId
      retrieval MineRich(min: int) of Account { where: MyTenant sort: [balance desc] }
    }
  }
  api LedgerApi from Core
  storage primary { type: postgres }
  resource ledgerState { for: Ledger, kind: state, use: primary }
  deployable api {
    platform: dotnet
    contexts: [Ledger]
    dataSources: [ledgerState]
    serves: LedgerApi
    port: 8081
    auth: required
  }
}`;

describe(".NET generator — retrieval principal binding (DEBT-24)", () => {
  it("binds currentUser through the ambient accessor in the spec ctor", async () => {
    const files = await generateSystemFiles(PRINCIPAL_SYS);
    const spec = [...files.entries()].find(([k]) => k.endsWith("/MineRichSpec.cs"))?.[1];
    expect(spec).toBeDefined();
    expect(spec!).toMatch(
      /Query\.Where\(x => x\.TenantId == RequestContext\.Current!\.CurrentUser!\.TenantId\)\.OrderByDescending\(x => x\.Balance\);/,
    );
    // No unbound bare `currentUser` token, and the RequestContext namespace is imported.
    expect(spec!).not.toMatch(/== currentUser\./);
    expect(spec!).toMatch(/using \w+\.Domain\.Common;/);
  });

  it("leaves a non-principal retrieval spec unchanged (no ambient accessor)", async () => {
    const out = await generateDotnet(await parseValid(SRC));
    const spec = out.get("Domain/Customers/ByRegionSpec.cs")!;
    expect(spec).not.toMatch(/RequestContext\.Current/);
    expect(spec).not.toMatch(/using .*Domain\.Common;/);
  });
});

// PR4 — the retrieval `loadPlan` is a no-op on EF Core: owned containments
// (`OwnsOne`/`OwnsMany`) are always materialised with their owner, so
// `whole(T)` is satisfied for free and an explicit `loads:` can neither
// widen nor narrow the query (you can't project an owned navigation away).
// This guards against a future contributor "honouring" loads with a
// spurious `.Include` / projection that would diverge whole from explicit.
const LOADS_SRC = `
  context Sales {
    aggregate Order {
      status: string
      contains lines: Line[]
      contains notes: Note[]
      entity Line { sku: string }
      entity Note { text: string }
    }
    repository Orders for Order { }
    criterion Open(s: string) of Order = status == s
    retrieval Recent(s: string) of Order { where: Open(s) }
    retrieval Slim(s: string) of Order { where: Open(s) loads: [this.lines] }
  }
`;

describe(".NET generator — retrieval loadPlan (owned-type no-op)", () => {
  it("maps owned containments to OwnsMany (always loaded with the owner)", async () => {
    const out = await generateDotnet(await parseValid(LOADS_SRC));
    const cfg = out.get("Infrastructure/Persistence/Configurations/OrderConfiguration.cs")!;
    expect(cfg).toMatch(/\.OwnsMany<Line>\("_lines"/);
    expect(cfg).toMatch(/\.OwnsMany<Note>\("_notes"/);
  });

  it("whole and explicit-`loads` specs are identical (no Include, no narrowing)", async () => {
    const out = await generateDotnet(await parseValid(LOADS_SRC));
    // `Recent` (whole) and `Slim` (explicit `loads: [this.lines]`) both have
    // `where: Open(s)`; loads narrowing is gated, so the two reified specs are
    // identical modulo class name — and neither Includes anything.
    const recent = out.get("Domain/Orders/RecentSpec.cs")!.replaceAll("Recent", "X");
    const slim = out.get("Domain/Orders/SlimSpec.cs")!.replaceAll("Slim", "X");
    expect(recent).toBe(slim);
    expect(out.get("Infrastructure/Repositories/OrderRepository.cs")!).not.toMatch(/\.Include\(/);
    expect(recent).not.toMatch(/\.Include\(/);
  });
});
