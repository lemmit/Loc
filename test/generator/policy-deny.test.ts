// `policy { deny [write] on <Agg> }` — the DENY-WINS carve-out (authorization
// Phase 4).  Pins that every one of the five domain-logic backends renders the
// deny sentinel to its native ALWAYS-FALSE query fragment — through the existing
// read `contextFilters` seam (deny read) and the `writeScopeFilter` command-load
// seam (deny write) — and that the Elixir write-scope command load underscores
// its now-principal-free param (the unused-variable trap under
// `--warnings-as-errors`).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

// `Secret` is READ-denied (invisible); `Account` is WRITE-denied (read-only).
// Both `with crudish` so update/destroy command-loads (the writeScopeFilter seam)
// are emitted.
const system = (platform: string) => `
  system Shop {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        aggregate Account with tenantOwned, crudish { balance: int }
        aggregate Secret with tenantOwned, crudish { code: string }
        aggregate Org {
          name: string
          implements tenantRegistry
        }
        repository Accounts for Account { }
        repository Secrets for Secret { }
        repository Orgs for Org { }
        policy {
          deny on Secret
          deny write on Account
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

/** File contents keyed for per-backend robustness. */
async function files(platform: string): Promise<Map<string, string>> {
  return generateSystemFiles(system(platform));
}
async function allText(platform: string): Promise<string> {
  return [...(await files(platform)).values()].join("\n\n");
}
async function fileContaining(platform: string, needle: string): Promise<string> {
  for (const [path, body] of await files(platform)) if (path.includes(needle)) return body;
  return "";
}

describe("policy deny — node (Hono/Drizzle)", () => {
  it("renders the always-false Drizzle contradiction for both deny read and deny write", async () => {
    const secret = await fileContaining("node", "secret-repository");
    const account = await fileContaining("node", "account-repository");
    // Deny read: the contradiction is ANDed into Secret's read predicates.
    expect(secret).toContain("isNull(schema.secrets.id)");
    expect(secret).toContain("isNotNull(schema.secrets.id)");
    // Deny write: the contradiction is in Account's write-scope in-scope check.
    expect(account).toContain("isNull(schema.accounts.id)");
    expect(account).toContain("isNotNull(schema.accounts.id)");
  });
});

describe("policy deny — .NET (EF Core)", () => {
  it("renders `false` into the query filter (deny read) and write in-scope (deny write)", async () => {
    const text = await allText("dotnet");
    // Deny read → HasQueryFilter(..., x => false) on the Secret configuration.
    expect(text).toMatch(/HasQueryFilter\([^)]*x => false\)/);
    // Deny write → the Account command-load AnyAsync scope is `... && (false)`.
    expect(text).toContain("&& (false)");
  });
});

describe("policy deny — .NET (Dapper)", () => {
  // M-T6.29.  The .NET backend's SECOND persistence adapter used to CRASH
  // codegen here (`whereToSql` had no `authz-filter` arm, so the deny sentinel
  // fell to its `default:` and threw), and never read `writeScopeFilter` at all
  // — while the shared command layer already dispatched mutations to
  // `GetByIdForWriteAsync` and the shared interface already declared it.
  it("ANDs `1 = 0` into every read SELECT (deny read) and emits the write guard (deny write)", async () => {
    const secret = await fileContaining(
      "dotnet { persistence: dapper }",
      "Repositories/SecretRepository",
    );
    const account = await fileContaining(
      "dotnet { persistence: dapper }",
      "Repositories/AccountRepository",
    );
    // Deny READ — the always-false term is spliced into EVERY read site, not
    // just the auto findAll: GetById, FindManyByIds, the findAll page + its
    // COUNT.  A `1 = 0` that reached only one of them would still leak.
    const readSites = [...secret.matchAll(/1 = 0/g)].length;
    expect(readSites).toBeGreaterThanOrEqual(4);
    expect(secret).toContain(
      "FROM secrets WHERE id = @id AND (tenant_id = @__cu_tenantId) AND 1 = 0",
    );
    expect(secret).toContain(
      "SELECT COUNT(*) FROM secrets WHERE (tenant_id = @__cu_tenantId) AND 1 = 0",
    );
    // Deny WRITE — reads stay OPEN on Account (tenant floor only, no `1 = 0`),
    // and the command load is the write-scope existence guard.  The read filter
    // is spliced into the guard too: EF gets that from HasQueryFilter for free,
    // Dapper has to say it, or the write scope would be wider than the read one.
    expect(account).toContain("public async Task<Account?> GetByIdForWriteAsync(");
    expect(account).toContain(
      "SELECT EXISTS (SELECT 1 FROM accounts WHERE id = @id AND (1 = 0) AND (tenant_id = @__cu_tenantId))",
    );
    expect(account).not.toContain(
      "FROM accounts WHERE id = @id AND (tenant_id = @__cu_tenantId) AND 1 = 0",
    );
  });

  it("leaves an undenied aggregate's repository untouched", async () => {
    const org = await fileContaining(
      "dotnet { persistence: dapper }",
      "Repositories/OrgRepository",
    );
    expect(org).not.toContain("1 = 0");
    expect(org).not.toContain("GetByIdForWriteAsync");
  });
});

describe("policy deny — Python (FastAPI/SQLAlchemy)", () => {
  it("renders the and_(is_(None), isnot(None)) contradiction", async () => {
    const secret = await fileContaining("python", "secret_repository");
    const account = await fileContaining("python", "account_repository");
    expect(secret).toContain("and_(SecretRow.id.is_(None), SecretRow.id.isnot(None))");
    expect(account).toContain("and_(AccountRow.id.is_(None), AccountRow.id.isnot(None))");
  });
});

describe("policy deny — Java (Spring/JPA)", () => {
  it('renders @SQLRestriction("1 = 0") (deny read) and `and 1 = 0` in the write @Query', async () => {
    const text = await allText("java");
    expect(text).toContain('@SQLRestriction("1 = 0")');
    expect(text).toContain("findByIdForWrite");
    expect(text).toContain("and 1 = 0");
  });
});

describe("policy deny — Elixir (plain Ecto/Phoenix)", () => {
  it('renders fragment("false") and underscores the principal-free for-write param', async () => {
    const text = await allText("elixir");
    expect(text).toContain('fragment("false")');
    // Deny write leaves the write-scope command load principal-free → the param
    // is underscored so `mix compile --warnings-as-errors` does not trip.
    expect(text).toContain("def find_by_id_for_write(id, _current_user");
    expect(text).not.toContain("def find_by_id_for_write(id, current_user");
  });
});
