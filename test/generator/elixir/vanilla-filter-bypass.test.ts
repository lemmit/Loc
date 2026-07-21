import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// `ignoring <Cap>` / `ignoring *` filter-bypass on the vanilla (plain Ecto)
// foundation (named-filter-bypass.md §11, Slice 2).
//
// Plain Ecto has no global query filter, so a capability `filter` is AND-ed
// into every read.  An `ignoring` read OMITS the named capability's `where:`
// predicate from its conjunction — for that read only.  CRUD reads + a
// non-bypassing find keep the full conjunction; a bare/hand-written filter is
// never bypassable.  Inline `Repo.findAll(...) ignoring …` rides as
// `ignore_filters` / `ignore_all_filters` opts onto the gated retrieval stages.
// ---------------------------------------------------------------------------

const SOURCE = `
system Catalog {
  capability softDeletable { isDeleted: bool  filter this.isDeleted == false }
  subdomain Core {
    context Shop {
      criterion BigOrders() of Order = this.total > 0
      aggregate Order with softDeletable {
        customerId: string
        total: int
      }
      repository Orders for Order {
        find recent(): Order[] where this.total > 0 ignoring softDeletable
        find allRows(): Order[] ignoring *
        find normal(): Order[] where this.total > 0
      }
      workflow Sweep {
        create(min: int) {
          let xs = Orders.findAll(BigOrders()) ignoring softDeletable
          let ys = Orders.findAll(BigOrders()) ignoring *
          for o in xs { }
          for o in ys { }
        }
      }
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

let cache: Map<string, string> | undefined;
async function gen(): Promise<Map<string, string>> {
  cache ??= await generateSystemFiles(SOURCE);
  return cache;
}

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

function defBody(src: string, name: string): string {
  // `def list do` (no parens) and `def recent()` / `def find_by_id(id)` both occur.
  const re = new RegExp(`def ${name}(\\(| )`);
  const m = re.exec(src);
  expect(m, `def ${name} not found`).not.toBeNull();
  const start = m!.index;
  const next = src.indexOf("\n  def ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("vanilla ignoring filter-bypass — predicate omission", () => {
  it("`ignoring <Cap>` drops the bypassed `where:` conjunct from that find", async () => {
    const repo = file(await gen(), "/shop/order_repository.ex");
    const recent = defBody(repo, "recent");
    expect(recent).toContain("from(record in Api.Shop.Order, where: record.total > 0)");
    expect(recent).not.toContain("is_deleted");
  });

  it("`ignoring *` drops ALL capability conjuncts (bare `from`)", async () => {
    const repo = file(await gen(), "/shop/order_repository.ex");
    const allRows = defBody(repo, "all_rows");
    expect(allRows).toContain("from(record in Api.Shop.Order)");
    expect(allRows).not.toContain("is_deleted");
  });

  it("a non-bypassing find keeps the full capability conjunction", async () => {
    const repo = file(await gen(), "/shop/order_repository.ex");
    expect(defBody(repo, "normal")).toContain(
      "where: (record.total > 0) and (record.is_deleted == false)",
    );
  });

  it("CRUD list/find_by_id keep the capability filter", async () => {
    const repo = file(await gen(), "/shop/order_repository.ex");
    expect(defBody(repo, "list")).toContain("where: record.is_deleted == false");
    expect(defBody(repo, "find_by_id")).toContain(
      "where: record.id == ^id and (record.is_deleted == false)",
    );
  });

  it("the retrieval gates each capability filter as a skippable `where` stage", async () => {
    const ret = file(await gen(), "/shop/retrievals/find_all_by_big_orders.ex");
    expect(ret).toContain(
      'query = if opts[:ignore_all_filters] || "softDeletable" in (opts[:ignore_filters] || []), ' +
        "do: query, else: where(query, [record], record.is_deleted == false)",
    );
  });

  it("inline `Repo.findAll(...) ignoring <Cap>` / `*` passes the bypass opts", async () => {
    const wf = file(await gen(), "/shop/workflows/sweep.ex");
    expect(wf).toContain('run_find_all_by_big_orders_order(ignore_filters: ["softDeletable"])');
    expect(wf).toContain("run_find_all_by_big_orders_order(ignore_all_filters: true)");
  });
});
