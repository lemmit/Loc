// A `shape: document` aggregate on the .NET backend gets NO EF
// `HasQueryFilter` — its persistence record is `(Id, Data jsonb, Version)`, so
// the filtered fields (`tenantId`, `dataKey`, `isDeleted`) live INSIDE the blob
// and there is no mapped column for EF to attach a predicate to.  Before the
// fix this meant a `tenantOwned` document aggregate read UNFILTERED across
// tenants while `validateContextFilterSupport` claimed .NET filters every shape
// — a SILENT cross-tenant read, not a crash (#2527's follow-up 1; the bug was
// found by the F1 pairwise sweep and documented there without being fixed).
//
// The fix mirrors node/java/python: apply the capability predicate IN-APP over
// the rehydrated aggregate, at every read seam.  These pins therefore assert
// three separable things, because each failed independently during development:
//
//   1. the document path FILTERS at all three read seams (findById /
//      findManyByIds / every find, incl. the auto `findAll`),
//   2. the RELATIONAL twin still filters through EF `HasQueryFilter` — the
//      fix must not have migrated the relational path to in-app filtering,
//   3. a document aggregate with NO capability filter emits NO predicate
//      (the unchanged-emission floor).
//
// Plus the two traps a real `dotnet build /warnaserror` caught and a
// string-level pin would not have:
//
//   - `policy { allow … }` × document was CS0535 (the interface declares
//     `GetByIdForWriteAsync`, the document repository never implemented it) —
//     #2527's follow-up 2, fixed here because it is the same seam.
//   - the `deep` scope ladder's `.StartsWith` is EXECUTED on the in-app path
//     (it is only an un-run expression tree on the EF path), so it needs
//     `StringComparison.Ordinal` or CA1310 fails the build.  The overload is
//     therefore position-dependent: bare inside an EF query filter (the
//     `StringComparison` overload has no SQL translation), ordinal when
//     executed.
//
// The `dotnet build /warnaserror` gate over the same crossings lives in
// test/e2e/generated-dotnet-build.test.ts (fixture:
// test/e2e/fixtures/dotnet-build/document-tenancy.ddd).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** `Note` is the DOCUMENT twin, `Ledger` the RELATIONAL control — identical
 *  capability, so whatever filters one must filter the other. */
const tenantSystem = `
  system TenantDoc {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        aggregate Note shape: document, with tenantOwned {
          title: string
        }
        aggregate Ledger with tenantOwned {
          label: string
        }
        aggregate Org {
          name: string
          implements tenantRegistry
        }
        repository Notes for Note {
          find byTitle(t: string): Note[] where this.title == t
        }
        repository Ledgers for Ledger { }
        repository Orgs for Org { }
      }
    }
    api DocApi from S
    storage primarySql { type: postgres }
    resource docState { for: C, kind: state, use: primarySql }
    deployable api {
      platform: dotnet
      contexts: [C]
      dataSources: [docState]
      serves: DocApi
      port: 3001
      auth: required
    }
  }
`;

/** No capability at all — the unchanged-emission floor. */
const plainSystem = `
  system PlainDoc {
    subdomain S {
      context C {
        aggregate Note shape: document {
          title: string
        }
        repository Notes for Note { }
      }
    }
    api DocApi from S
    storage primarySql { type: postgres }
    resource docState { for: C, kind: state, use: primarySql }
    deployable api {
      platform: dotnet
      contexts: [C]
      dataSources: [docState]
      serves: DocApi
      port: 3001
    }
  }
`;

/** A read ladder WIDER than the write ladder, so the aggregate carries both a
 *  `deep` read scope (the `.StartsWith` path predicate) and a narrower
 *  `writeScopeFilter` (which is what makes `GetByIdForWriteAsync` exist). */
const policySystem = `
  system PolicyDoc {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        policy {
          allow deep on Note
          allow write local on Note
          allow deep on Ledger
          allow write local on Ledger
        }
        aggregate Note shape: document, with tenantOwned, crudish {
          title: string
        }
        aggregate Ledger with tenantOwned, crudish {
          label: string
        }
        aggregate Org with crudish {
          name: string
          implements tenantRegistry
        }
        repository Notes for Note { }
        repository Ledgers for Ledger { }
        repository Orgs for Org { }
      }
    }
    api DocApi from S
    storage primarySql { type: postgres }
    resource docState { for: C, kind: state, use: primarySql }
    deployable api {
      platform: dotnet
      contexts: [C]
      dataSources: [docState]
      serves: DocApi
      port: 3001
      auth: required
    }
  }
`;

/** The one emitted file whose basename matches — asserting against the WHOLE
 *  joined output would let a pin pass on a hit in a sibling aggregate's file,
 *  which is exactly the confusion this bug lived in. */
async function fileNamed(source: string, basename: string): Promise<string> {
  const files = await generateSystemFiles(source);
  const hit = [...files.entries()].find(([p]) => p.endsWith(`/${basename}`));
  if (!hit) {
    throw new Error(
      `no emitted file named ${basename}; got:\n${[...files.keys()].slice(0, 40).join("\n")}`,
    );
  }
  return hit[1];
}

describe("dotnet: shape: document × tenantOwned — the in-app tenant read filter", () => {
  it("gates findById on the capability predicate (a foreign-tenant row reads as missing)", async () => {
    const repo = await fileNamed(tenantSystem, "NoteRepository.cs");
    // Rehydrate, then gate — an out-of-scope document must return null, which
    // is what EF's query filter does to the relational twin's FirstOrDefault.
    expect(repo).toContain("return _CapabilityVisible(__rec) ? __rec : null;");
  });

  it("filters findManyByIds and EVERY find, including the auto findAll", async () => {
    const repo = await fileNamed(tenantSystem, "NoteRepository.cs");
    // findManyByIds.
    expect(repo).toContain(".Where(_CapabilityVisible).ToList();");
    // THREE multi-row seams narrow the rehydrated set: findManyByIds, the auto
    // `findAll`, and the declared `byTitle` — each BEFORE its own predicate
    // runs, so a find never returns a capability-hidden document.  Counted
    // rather than merely `toContain`-ed: the original bug was one seam filtered
    // and another silently not, which a substring pin cannot tell apart.
    const narrowed = repo.match(
      /\.Select\(__d => Note\.FromSnapshot\([^\n]*?\)\.Where\(_CapabilityVisible\)/g,
    );
    expect(
      narrowed?.length,
      "findManyByIds + both find bodies each narrow to the visible set",
    ).toBe(3);
    // …and `byTitle`'s own predicate still runs, AFTER the narrowing.
    expect(repo).toContain("__all.Where(x => x.Title == t)");
  });

  it("resolves the principal through the ambient accessor, re-read per call", async () => {
    const repo = await fileNamed(tenantSystem, "NoteRepository.cs");
    expect(repo).toContain(
      "private static bool _CapabilityVisible(Note x) => (x.TenantId == RequestContext.Current!.CurrentUser!.TenantId);",
    );
  });

  it("leaves the RELATIONAL twin on EF HasQueryFilter (the fix did not migrate it)", async () => {
    const ctx = await fileNamed(tenantSystem, "AppDbContext.cs");
    expect(ctx).toContain(
      'modelBuilder.Entity<Ledger>().HasQueryFilter("TenantIdFilter", x => x.TenantId == _currentUser.User.TenantId);',
    );
    // The document aggregate is NOT given a query filter — it cannot have one
    // (its columns are inside the blob); the in-app predicate above is its
    // whole enforcement, and this pins that the two paths stay distinct.
    expect(ctx).not.toContain("Entity<Note>().HasQueryFilter");
    const repo = await fileNamed(tenantSystem, "LedgerRepository.cs");
    expect(repo).not.toContain("_CapabilityVisible");
  });

  it("emits NO predicate when the document aggregate carries no capability filter", async () => {
    const repo = await fileNamed(plainSystem, "NoteRepository.cs");
    expect(repo).not.toContain("_CapabilityVisible");
    // The unchanged emission returns the rehydrated document directly.
    expect(repo).toContain("return Note.FromSnapshot(");
  });
});

describe("dotnet: shape: document × policy — the write-scope seam and the executed StartsWith", () => {
  it("implements GetByIdForWriteAsync on the document repository (was CS0535)", async () => {
    const iface = await fileNamed(policySystem, "INoteRepository.cs");
    const repo = await fileNamed(policySystem, "NoteRepository.cs");
    // The interface declares it whenever the write scope is narrower than the
    // read scope; before the fix the document impl provided nothing → CS0535.
    expect(iface).toContain("Task<Note?> GetByIdForWriteAsync(");
    expect(repo).toContain("public async Task<Note?> GetByIdForWriteAsync(");
    // Loads through GetByIdAsync (which already applies the READ filter, the
    // way EF applies the query filter to the relational `Any`), then narrows
    // to the write scope — write scope ∩ read scope, same as relational.
    expect(repo).toContain("var __found = await GetByIdAsync(id, cancellationToken);");
    expect(repo).toContain("return _WriteScopeAllows(__found) ? __found : null;");
  });

  it("uses StringComparison.Ordinal for the EXECUTED scope ladder (CA1310 under /warnaserror)", async () => {
    const repo = await fileNamed(policySystem, "NoteRepository.cs");
    expect(repo).toContain("x.DataKey.StartsWith(");
    expect(repo).toContain('+ ".", StringComparison.Ordinal)');
  });

  it("keeps the EF query filter's StartsWith BARE (the overload has no SQL translation)", async () => {
    const ctx = await fileNamed(policySystem, "AppDbContext.cs");
    // The relational twin's ladder rides an Expression<Func<>> EF rewrites into
    // SQL LIKE — it is never executed, so CA1310 does not fire, and adding the
    // StringComparison overload would break the translation instead.
    expect(ctx).toContain("x.DataKey.StartsWith(");
    expect(ctx).not.toContain("StringComparison.Ordinal");
  });
});
