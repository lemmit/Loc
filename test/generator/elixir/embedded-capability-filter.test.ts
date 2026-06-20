import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// DEBT-02 — capability `filter` on a `shape(embedded)` aggregate (elixir).
//
// An embedded aggregate's root is a real resource/table: its root scalars are
// columns (only the `contains` parts ride embedded jsonb attributes).  So a
// non-principal capability `filter` lands on every read exactly like the
// relational path — there is no in-app filtering and no JSON-path lowering.
// Both the Ash `renderBaseFilter` and the vanilla `vanillaCapabilityFilter` are
// shape-agnostic, so the only change vs. relational is removing the validator
// gate; this pins that the emitted predicate references the root *columns*.
// ---------------------------------------------------------------------------

const ASH_SOURCE = `
system EmbFilterAsh {
  subdomain D {
    context Shop {
      aggregate Order shape(embedded) {
        code: string
        isDeleted: bool
        filter !this.isDeleted
        contains items: Item[]
        entity Item { sku: string  qty: int }
        operation softDelete() { isDeleted := true }
      }
      repository Orders for Order {
        find byCode(code: string): Order[] where this.code == code
      }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable embApi {
    platform: elixir
    contexts: [Shop]
    dataSources: [st]
    serves: A
    port: 4000
  }
}
`;

const VANILLA_SOURCE = `
system VanillaEmbFilter {
  subdomain Core {
    context Shop {
      aggregate Order shape(embedded) {
        code: string
        archived: bool
        filter !this.archived
        operation archive() { archived := true }
      }
      repository Orders for Order {
        find byCode(code: string): Order[] where this.code == code
      }
      view ActiveOrders = Order where code != ""
    }
  }
  api CatalogApi from Core
  storage pg { type: postgres }
  resource orderState { for: Shop, kind: state, use: pg }
  deployable api {
    platform: elixir { foundation: vanilla }
    contexts: [Shop]
    dataSources: [orderState]
    serves: CatalogApi
    port: 4000
  }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("elixir embedded capability filter — Ash base_filter on the embedded resource", () => {
  it("emits base_filter over the root column, with the containment as an embedded attribute", async () => {
    const files = await generateSystemFiles(ASH_SOURCE);
    const order = file(files, "/shop/order.ex");
    // The soft-delete predicate scopes every read via base_filter — the root
    // scalar `is_deleted` is a real column (no JSON path).
    expect(order).toContain("base_filter expr(not is_deleted)");
    // Root scalars are real attributes; the containment is an embedded array.
    expect(order).toContain("attribute :code, :string");
    expect(order).toContain("attribute :is_deleted, :boolean");
    expect(order).toContain("attribute :items, {:array, EmbApi.Shop.Item}");
    // The part is an embedded resource (jsonb), not a separate table.
    expect(file(files, "/shop/item.ex")).toContain("data_layer: :embedded");
  });
});

describe("elixir embedded capability filter — vanilla where-clause on the embedded root", () => {
  it("AND-s the predicate into list/0, find_by_id/1, the custom find, and the view", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const repo = file(files, "/shop/order_repository.ex");
    // list/0 — the root scalar `archived` is a column, so the predicate AND-s in.
    expect(repo).toContain(
      "from(record in Api.Shop.Order, where: not record.archived) |> Repo.all()",
    );
    // find_by_id/1 — scoped via Repo.one with the conjoined where.
    expect(repo).toContain(
      "Repo.one(from(record in Api.Shop.Order, where: record.id == ^id and (not record.archived)))",
    );
    // Custom find — its own where is conjoined with the capability predicate.
    expect(repo).toContain("where: (record.code == ^code) and (not record.archived)");
    // The view is scoped too.
    expect(file(files, "/shop/views/active_orders.ex")).toContain(
      'where: (record.code != "") and (not record.archived)',
    );
  });
});
