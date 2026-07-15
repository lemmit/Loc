import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Capability `filter` on the vanilla (plain Ecto) foundation.
//
// The Ash foundation installs a `filter <expr>` capability once via the
// resource `base_filter`; plain Ecto has no global query filter, so the
// generated vanilla modules must AND the predicate into EVERY root read of the
// aggregate — `list/0`, `find_by_id/1`, each custom find, every retrieval, and
// every view.  (Before this, a vanilla capability filter was silently dropped,
// so reads returned soft-deleted / out-of-scope rows.)
//
// Predicates render under the `record` Ecto binding (`!this.archived` →
// `not record.archived`).  Principal-referencing (tenancy) filters stay gated
// on vanilla (no ambient actor in plain Ecto).
// ---------------------------------------------------------------------------

const SOURCE = `
system Catalog {
  subdomain Core {
    context Shop {
      aggregate Order {
        customerId: string
        total: int
        archived: bool
        filter !this.archived
      }
      repository Orders for Order {
        find byCustomer(customerId: string): Order[] where this.customerId == customerId
      }
      retrieval BigOrders(min: int) of Order { where: total >= min  sort: [total desc] }
      view ActiveOrders = Order where total > 0
    }
  }
  api CatalogApi from Core
  storage pg { type: postgres }
  resource orderState { for: Shop, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Shop]
    dataSources: [orderState]
    serves: CatalogApi
    port: 4000
  }
}
`;

async function gen(): Promise<Map<string, string>> {
  return generateSystemFiles(SOURCE);
}

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla capability filter — AND-ed into every read", () => {
  it("scopes list/0 and find_by_id/1 in the repository", async () => {
    const repo = file(await gen(), "/shop/order_repository.ex");
    // Paged-by-default: list's base query carries the capability `where`.
    expect(repo).toContain("query = from(record in Api.Shop.Order, where: not record.archived)");
    // find_by_id/1 can't carry a `where` on Repo.get, so it becomes Repo.one.
    expect(repo).toContain(
      "Repo.one(from(record in Api.Shop.Order, where: record.id == ^id and (not record.archived)))",
    );
    // The Ecto import is pulled in for the `from(...)` reads.
    expect(repo).toContain("import Ecto.Query");
  });

  it("conjoins the filter into a custom find's own where", async () => {
    const repo = file(await gen(), "/shop/order_repository.ex");
    expect(repo).toContain("where: (record.customer_id == ^customer_id) and (not record.archived)");
  });

  it("conjoins the filter into a retrieval and a view", async () => {
    const files = await gen();
    const ret = file(files, "/shop/retrievals/big_orders.ex");
    // A retrieval applies the capability filter as a SEPARATE `where` pipe
    // stage (so a call-site `ignoring` can gate it per-origin); the base
    // `where:` carries only the retrieval's own predicate.  A bare/hand-written
    // `filter` (origin undefined) is unconditional — no `ignore_*` gate.
    expect(ret).toContain("query = from(record in Api.Shop.Order, where: record.total >= ^min)");
    expect(ret).toContain("query = where(query, [record], not record.archived)");
    const view = file(files, "/shop/views/active_orders.ex");
    expect(view).toContain("where: (record.total > 0) and (not record.archived)");
  });

  it("leaves a filter-free aggregate's reads unscoped (byte-identical)", async () => {
    const noFilter = SOURCE.replace("        filter !this.archived\n", "");
    const repo = file(await generateSystemFiles(noFilter), "/shop/order_repository.ex");
    // Paged-by-default: the base query is unscoped (no `where`).
    expect(repo).toContain("query = from(record in Api.Shop.Order)");
    expect(repo).toContain("case Repo.get(Api.Shop.Order, id) do");
  });
});
