// `policy { allow write <level> on <Agg> }` — the WRITE ladder (authorization
// Phase 3 P3.1, docs/plans/authorization-phase3.md).  Pins that every one of the
// five domain-logic backends emits a WRITE-scope-narrowed command-load seam
// (distinct from the read-scoped by-id load) when the write scope is narrower
// than the read scope — and that a plain flat-tenancy aggregate's command load
// stays byte-identical (no guard).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const system = (platform: string, policy: string) => `
  system Shop {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        aggregate Account with tenantOwned {
          balance: int
          operation adjust(delta: int) { balance := balance + delta }
          destroy remove() { }
        }
        aggregate Org {
          name: string
          implements tenantRegistry
        }
        repository Accounts for Account { }
        repository Orgs for Org { }
        policy {
          ${policy}
        }
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

async function allText(platform: string, policy: string): Promise<string> {
  const files = await generateSystemFiles(system(platform, policy));
  return [...files.values()].join("\n\n");
}

// Read `deep`, write `local` (the fail-closed floor default, spelled here) — the
// command load must narrow to the flat `tenantId ==` floor while reads stay
// `deep` (orgPath prefix).
const DEEP_WRITE_LOCAL = "allow deep on Account\nallow write local on Account";
// Read `global`, write `deep` — reads span the whole root subtree; writes are
// scoped to the caller's own `orgPath` subtree.
const GLOBAL_WRITE_DEEP = "allow global on Account\nallow write deep on Account";

describe("policy write scope — node (Hono/Drizzle)", () => {
  it("getById gains a floor write-guard under a deep read (findById stays deep)", async () => {
    const text = await allText("node", DEEP_WRITE_LOCAL);
    // The command-load pre-guard: a scoped existence SELECT keyed on the floor.
    expect(text).toContain("const inScope = await this.db");
    expect(text).toContain("eq(schema.accounts.tenantId, requireCurrentUser().tenantId)");
    // Reads still widen to the deep orgPath prefix.
    expect(text).toContain('.orgPath + ".%"');
  });

  it("write deep under a global read: guard on orgPath, reads on rootOrg", async () => {
    const text = await allText("node", GLOBAL_WRITE_DEEP);
    expect(text).toContain("const inScope = await this.db");
    expect(text).toContain('requireCurrentUser().orgPath + ".%"'); // write guard
    expect(text).toContain('.rootOrg + ".%"'); // read filter
  });

  it("plain flat tenancy (no policy) leaves getById byte-identical (no guard)", async () => {
    const text = await allText("node", "");
    expect(text).not.toContain("const inScope = await this.db");
  });
});

describe("policy write scope — .NET (EF Core)", () => {
  it("emits GetByIdForWriteAsync with the floor predicate; commands load through it", async () => {
    const text = await allText("dotnet", DEEP_WRITE_LOCAL);
    expect(text).toContain("GetByIdForWriteAsync");
    expect(text).toContain(".AnyAsync(");
    // Command handler loads through the write-scoped method.
    expect(text).toContain("_repo.GetByIdForWriteAsync(command.Id");
  });

  it("no GetByIdForWriteAsync without a narrowing", async () => {
    const text = await allText("dotnet", "");
    expect(text).not.toContain("GetByIdForWriteAsync");
  });
});

describe("policy write scope — Python (FastAPI/SQLAlchemy)", () => {
  it("emits get_by_id_for_write with the floor guard; mutation routes call it", async () => {
    const text = await allText("python", DEEP_WRITE_LOCAL);
    expect(text).toContain("async def get_by_id_for_write");
    expect(text).toContain("require_current_user().tenant_id");
    expect(text).toContain("await repo.get_by_id_for_write(");
  });

  it("no get_by_id_for_write without a narrowing", async () => {
    const text = await allText("python", "");
    expect(text).not.toContain("get_by_id_for_write");
  });
});

describe("policy write scope — Java (Spring/JPA)", () => {
  it("emits a findByIdForWrite @Query; getById loads through it", async () => {
    const text = await allText("java", DEEP_WRITE_LOCAL);
    expect(text).toContain("findByIdForWrite");
    // Floor JPQL predicate on tenantId via the SpEL principal.
    expect(text).toContain("e.tenantId = :#{@currentUserAccessor.user()?.tenantId()}");
    expect(text).toContain("jpa.findByIdForWrite(id)");
  });

  it("no findByIdForWrite without a narrowing", async () => {
    const text = await allText("java", "");
    expect(text).not.toContain("findByIdForWrite");
  });
});

describe("policy write scope — Elixir (plain Ecto/Phoenix)", () => {
  it("emits find_by_id_for_write + a for-write facade; mutations load through it", async () => {
    const text = await allText("elixir", DEEP_WRITE_LOCAL);
    expect(text).toContain("def find_by_id_for_write");
    expect(text).toContain("as: :find_by_id_for_write");
    // Mutations route through the for-write facade; `show` (read) does not.
    expect(text).toContain("get_account_for_write(id");
  });

  it("no find_by_id_for_write without a narrowing", async () => {
    const text = await allText("elixir", "");
    expect(text).not.toContain("find_by_id_for_write");
  });

  // Regression pin (CI vanilla-inheritance cell): a TPH concrete carries a
  // non-null `kind` discriminator filter even with NO write policy — the guard
  // must gate on the aggregate's own write-scope narrowing, not the combined
  // predicate, or it emits a kind-only `find_by_id_for_write` whose
  // `current_user` param is unused (a hard failure under
  // `mix compile --warnings-as-errors`).
  it("a TPH concrete without a write policy emits NO find_by_id_for_write", async () => {
    const files = await generateSystemFiles(`
      system Inh {
        subdomain S {
          context Parties {
            abstract aggregate Party inheritanceUsing(sharedTable) {
              name: string
            }
            aggregate Customer extends Party { email: string }
            aggregate Vendor extends Party { rating: int }
            repository Customers for Customer { }
            repository Vendors for Vendor { }
          }
        }
        api InhApi from S
        storage primarySql { type: postgres }
        resource inhState { for: Parties, kind: state, use: primarySql }
        deployable api {
          platform: elixir
          contexts: [Parties]
          dataSources: [inhState]
          serves: InhApi
          port: 3001
        }
      }
    `);
    const text = [...files.values()].join("\n\n");
    expect(text).not.toContain("find_by_id_for_write");
  });
});
