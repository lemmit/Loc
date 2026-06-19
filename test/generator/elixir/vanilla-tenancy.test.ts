import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Principal (tenancy) capability filter on the vanilla (plain Ecto) foundation
// — DEBT-01 elixir-vanilla slice.
//
// `filter this.tenantId == currentUser.tenantId` AND-s a PRINCIPAL predicate
// into every read.  Plain Ecto has no ambient actor, so `current_user` is
// threaded from `conn.assigns` (the Auth plug) through the read seam and pinned
// in the Ecto `where:` as `^(current_user && current_user.tenant_id)` — a nil
// actor pins to `nil` (Ecto binds `= NULL` → no rows: fail-closed, never a
// cross-tenant leak), mirroring Ash's `actor: nil`.
//
// Only PRINCIPAL aggregates gain the threaded `current_user` parameter; a
// non-principal aggregate stays byte-identical (covered by the sibling
// vanilla-capability-filter test).
// ---------------------------------------------------------------------------

const SOURCE = `
system TenancyShop {
  user { id: string  tenantId: string }
  auth {
    provider: keycloak
    oidc { issuer: env("OIDC_ISSUER")  clientId: env("OIDC_CLIENT_ID") }
    claims: { tenantId: "tenant_id" }
  }
  subdomain Core {
    context Ledger {
      aggregate Account ids guid {
        tenantId: string
        balance: int
        filter this.tenantId == currentUser.tenantId
      }
      repository Accounts for Account {
        find byMinBalance(min: int): Account[] where this.balance >= min
      }
      retrieval RichAccounts(min: int) of Account { where: balance >= min  sort: [balance desc] }
      view BigAccounts = Account where balance >= 1000
    }
  }
  storage pg { type: postgres }
  resource ledgerState { for: Ledger, kind: state, use: pg }
  api LedgerApi from Core
  deployable api {
    platform: elixir { foundation: vanilla }
    contexts: [Ledger]
    serves: LedgerApi
    dataSources: [ledgerState]
    port: 4000
    auth: required
  }
}
`;

const PIN = "^(current_user && current_user.tenant_id)";

async function gen(): Promise<Map<string, string>> {
  return generateSystemFiles(SOURCE);
}

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla tenancy — principal filter threaded + pinned", () => {
  it("threads current_user into repository list/find_by_id/find and pins the predicate", async () => {
    const repo = file(await gen(), "/ledger/account_repository.ex");
    expect(repo).toContain("def list(current_user \\\\ nil) do");
    expect(repo).toContain(`where: record.tenant_id == ${PIN}`);
    expect(repo).toContain("def find_by_id(id, current_user \\\\ nil) when is_binary(id) do");
    expect(repo).toContain(`where: record.id == ^id and (record.tenant_id == ${PIN})`);
    // Custom find carries the actor too.
    expect(repo).toContain("def by_min_balance(min, current_user \\\\ nil) do");
    expect(repo).toContain(`(record.balance >= ^min) and (record.tenant_id == ${PIN})`);
  });

  it("carries the actor through the context defdelegates", async () => {
    const ctx = file(await gen(), "/lib/api/ledger.ex");
    expect(ctx).toContain("defdelegate list_accounts(current_user \\\\ nil)");
    expect(ctx).toContain("defdelegate get_account(id, current_user \\\\ nil)");
    expect(ctx).toContain("defdelegate by_min_balance_account(min, current_user \\\\ nil)");
  });

  it("extracts conn.assigns.current_user in the controller and passes it to reads", async () => {
    const ctrl = file(await gen(), "/controllers/account_controller.ex");
    expect(ctrl).toContain("current_user = Map.get(conn.assigns, :current_user)");
    expect(ctrl).toContain("Ledger.list_accounts(current_user)");
    expect(ctrl).toContain("Ledger.get_account(id, current_user)");
  });

  it("reads the actor from opts in the retrieval and pins it", async () => {
    const ret = file(await gen(), "/ledger/retrievals/rich_accounts.ex");
    expect(ret).toContain("current_user = opts[:current_user]");
    expect(ret).toContain(`(record.balance >= ^min) and (record.tenant_id == ${PIN})`);
  });

  it("uses the run/1 current_user in the view (no `_ = current_user` discard)", async () => {
    const view = file(await gen(), "/ledger/views/big_accounts.ex");
    expect(view).toContain("def run(current_user \\\\ nil) do");
    expect(view).not.toContain("_ = current_user");
    expect(view).toContain(`(record.balance >= 1000) and (record.tenant_id == ${PIN})`);
  });

  it("emits the Auth plug and splices it into the :api router pipeline", async () => {
    const files = await gen();
    // The plug that populates conn.assigns.current_user from the JWT.
    const plug = file(files, "/api_web/auth.ex");
    expect(plug).toContain("assign(conn, :current_user, user)");
    expect(plug).toContain('tenant_id: get_claim(claims, "tenant_id")');
    const router = file(files, "/api_web/router.ex");
    expect(router).toContain("plug ApiWeb.Auth");
    expect(router).toContain('get "/me", AuthController, :me');
  });
});
