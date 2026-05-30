// .NET principal-referencing capability filters (tenancy).
//
// A `filter <expr>` capability whose predicate references currentUser
// cannot ride EF Core's HasQueryFilter (no `currentUser` in
// OnModelCreating's scope; zero DbContext magic by design). Instead the
// repository injects ICurrentUserAccessor and AND-s the predicate into
// every root read, with `currentUser` rendered as the injected accessor
// read (`_currentUser.User`). Non-principal filters still ride
// HasQueryFilter (see capability.test.ts).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

async function generate(src: string): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(src))).files;
}

function fileEndingWith(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

const PRINCIPAL_SRC = `
system Shop {
  user { id: string  tenantId: string }
  subdomain Sales {
    context Sales {
      aggregate Doc {
        subject: string
        tenantId: string
        filter this.tenantId == currentUser.tenantId
      }
      repository Docs for Doc {
        find bySubject(s: string): Doc[] where subject == s
      }
    }
  }
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable api { platform: dotnet, contexts: [Sales], dataSources: [salesState], port: 5000 }
}
`;

describe(".NET principal capability filter — repository injection", () => {
  it("injects ICurrentUserAccessor and AND-s the predicate into every read", async () => {
    const files = await generate(PRINCIPAL_SRC);
    const r = fileEndingWith(files, "Infrastructure/Repositories/DocRepository.cs");

    // Accessor injected (field + ctor param + using).
    expect(r).toContain("private readonly ICurrentUserAccessor _currentUser;");
    expect(r).toMatch(/public DocRepository\([^)]*ICurrentUserAccessor currentUser\)/);
    expect(r).toContain("_currentUser = currentUser;");
    expect(r).toContain("using Api.Auth;");

    // currentUser renders as the injected accessor read in the predicate,
    // AND-ed into GetByIdAsync, FindManyByIdsAsync, and the named find.
    const w = ".Where(x => x.TenantId == _currentUser.User.TenantId)";
    expect(r).toContain(`_db.Docs${w}.FirstOrDefaultAsync(x => x.Id == id, ct)`);
    expect(r).toContain(`_db.Docs${w}.Where(x => ids.Contains(x.Id)).ToListAsync(ct)`);
    expect(r).toContain(`_db.Docs${w}.Where(x => x.Subject == s)`);

    // The principal predicate must NOT also appear as a HasQueryFilter.
    const cfg = fileEndingWith(
      files,
      "Infrastructure/Persistence/Configurations/DocConfiguration.cs",
    );
    expect(cfg).not.toContain("HasQueryFilter");
  });

  it("a non-principal filter still rides HasQueryFilter, no accessor injection", async () => {
    const files = await generate(`
      system Shop {
        subdomain Sales {
          context Sales {
            aggregate Doc {
              subject: string
              isDeleted: bool
              filter !this.isDeleted
            }
            repository Docs for Doc { }
          }
        }
        storage primary { type: postgres }
        resource salesState { for: Sales, kind: state, use: primary }
        deployable api { platform: dotnet, contexts: [Sales], dataSources: [salesState], port: 5000 }
      }
    `);
    const r = fileEndingWith(files, "Infrastructure/Repositories/DocRepository.cs");
    expect(r).not.toContain("ICurrentUserAccessor");
    const cfg = fileEndingWith(
      files,
      "Infrastructure/Persistence/Configurations/DocConfiguration.cs",
    );
    expect(cfg).toContain("HasQueryFilter(x => !x.IsDeleted)");
  });
});
