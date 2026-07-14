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
      aggregate Account {
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
    platform: elixir
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
    expect(repo).toContain(
      'def list(page \\\\ 1, page_size \\\\ 20, sort \\\\ "id", dir \\\\ "asc", current_user \\\\ nil) do',
    );
    expect(repo).toContain(`where: record.tenant_id == ${PIN}`);
    expect(repo).toContain("def find_by_id(id, current_user \\\\ nil) when is_binary(id) do");
    expect(repo).toContain(`where: record.id == ^id and (record.tenant_id == ${PIN})`);
    // Custom find carries the actor too.
    expect(repo).toContain("def by_min_balance(min, current_user \\\\ nil) do");
    expect(repo).toContain(`(record.balance >= ^min) and (record.tenant_id == ${PIN})`);
  });

  it("carries the actor through the context defdelegates", async () => {
    const ctx = file(await gen(), "/lib/api/ledger.ex");
    expect(ctx).toContain(
      'defdelegate list_accounts(page \\\\ 1, page_size \\\\ 20, sort \\\\ "id", dir \\\\ "asc", current_user \\\\ nil)',
    );
    expect(ctx).toContain("defdelegate get_account(id, current_user \\\\ nil)");
    expect(ctx).toContain("defdelegate by_min_balance_account(min, current_user \\\\ nil)");
  });

  it("extracts conn.assigns.current_user in the controller and passes it to reads", async () => {
    const ctrl = file(await gen(), "/controllers/account_controller.ex");
    expect(ctrl).toContain("current_user = Map.get(conn.assigns, :current_user)");
    expect(ctrl).toContain(
      'Ledger.list_accounts(page_param(params, "page", 1), page_param(params, "pageSize", 20), Map.get(params, "sort", "id"), Map.get(params, "dir", "asc"), current_user)',
    );
    expect(ctrl).toContain("Ledger.get_account(id, current_user)");
  });

  it("reads the actor from opts in the retrieval and pins it", async () => {
    const ret = file(await gen(), "/ledger/retrievals/rich_accounts.ex");
    expect(ret).toContain("current_user = opts[:current_user]");
    // The retrieval's own predicate is the base `where:`; the (bare, origin-less)
    // principal capability filter applies as a separate, unconditional `where`
    // pipe stage (Slice 2 — the per-origin gate lets a call-site `ignoring` skip
    // capability filters; a bare filter has no origin, so it always applies).
    expect(ret).toContain(
      "query = from(record in Api.Ledger.Account, where: record.balance >= ^min)",
    );
    expect(ret).toContain(`query = where(query, [record], record.tenant_id == ${PIN})`);
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

// ---------------------------------------------------------------------------
// DEBT-02 Slice A — a PRINCIPAL-referencing (tenancy) capability filter on a
// `shape(embedded)` aggregate (vanilla Ecto).  The embedded root scalars are
// real columns, so the principal predicate reuses the relational-principal
// path: `record.tenant_id == ^(current_user && current_user.tenant_id)` threaded
// through every read, with `current_user` from `conn.assigns` (the Auth plug).
// Previously gated by `loom.context-filter-unsupported`.
// ---------------------------------------------------------------------------

const EMBEDDED_SOURCE = `
system EmbTenancy {
  user { id: string  tenantId: string }
  auth {
    provider: keycloak
    oidc { issuer: env("OIDC_ISSUER")  clientId: env("OIDC_CLIENT_ID") }
    claims: { tenantId: "tenant_id" }
  }
  subdomain D {
    context Shop {
      aggregate Order shape(embedded) {
        tenantId: string
        code: string
        filter this.tenantId == currentUser.tenantId
        contains items: Item[]
        entity Item { sku: string }
        operation addItem(sku: string) { items += Item { sku: sku } }
      }
      repository Orders for Order { find byCode(code: string): Order[] where this.code == code }
    }
  }
  api A from D
  storage pg { type: postgres }
  resource st { for: Shop, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Shop]
    serves: A
    dataSources: [st]
    port: 4000
    auth: required
  }
}
`;

describe("vanilla embedded principal (tenancy) capability filter (DEBT-02 Slice A)", () => {
  it("threads current_user into the embedded repository reads and pins the predicate", async () => {
    const repo = file(await generateSystemFiles(EMBEDDED_SOURCE), "/shop/order_repository.ex");
    expect(repo).toContain(
      'def list(page \\\\ 1, page_size \\\\ 20, sort \\\\ "id", dir \\\\ "asc", current_user \\\\ nil) do',
    );
    expect(repo).toContain(`where: record.tenant_id == ${PIN}`);
    expect(repo).toContain(`where: record.id == ^id and (record.tenant_id == ${PIN})`);
    // The custom find carries the actor too.
    expect(repo).toContain(`(record.code == ^code) and (record.tenant_id == ${PIN})`);
  });
});
