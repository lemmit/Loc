import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Vanilla (plain Ecto) named-operation persistence regression.
//
// A scalar operation body rebinds `record = %{record | field: newval}` BEFORE
// the persist changeset is built, so the changeset's DATA already carries the
// new value.  `Ecto.Changeset.put_change/3` DROPS a change whose value equals
// the data (`Ecto.Type.equal?`), leaving an EMPTY changeset — `Repo.update`
// then runs NO SQL and the operation's write is silently lost (compile-green,
// boot-red: the op returns `{:ok, record}` but the row never changes).  The
// persist tail therefore uses `force_change/3`, which stores the change
// regardless, so the assigned column actually persists.  Boot-verified:
// `inc()` twice on `total: 5` → GET `total: 7` (an UPDATE runs); with the old
// `put_change` it stayed `5` (no UPDATE at all).
// ---------------------------------------------------------------------------

const SRC = `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Cart shape: relational with crudish {
        total: int
        operation inc() { total := total + 1 }
      }
      repository Carts for Cart { }
    }
  }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla named-op persistence (force_change)", () => {
  it("persists an assigned scalar column via force_change, not the change-dropping put_change", async () => {
    const facade = file(await generateSystemFiles(SRC), "/shop.ex");
    const inc = facade.slice(facade.indexOf("def inc_cart("));
    // The body rebinds record to the new value…
    expect(inc).toContain("record = %{record | total: record.total + 1}");
    // …so the persist MUST force the change (put_change would drop it as a no-op
    // vs the already-mutated changeset data → empty changeset → no UPDATE).
    expect(inc).toContain("|> Ecto.Changeset.force_change(:total, record.total)");
    expect(inc).not.toContain("|> Ecto.Changeset.put_change(:total, record.total)");
    expect(inc).toContain("|> Api.Shop.CartRepository.persist_change()");
  });
});

// ---------------------------------------------------------------------------
// The embed analogue of the `force_change` bug above (B5).  An op that mutates
// an EMBEDDED containment (`items += Item{…}` on an `embeds_many` jsonb field)
// rebinds `record.<field>` in the body, then persists via `put_embed`.
// `put_embed`, like `put_change`, DROPS the change when the new embed equals the
// changeset DATA — and the data is the ALREADY-mutated `record`, so the write is
// silently lost.  Embeds have no `force_change`, so the persist changeset is
// built off the ORIGINAL (pre-mutation) struct `record_before` to give
// `put_embed` a real diff.  Boot-verified (behavioral `shapes`): an embedded
// Wishlist `addItem` now round-trips (`items.length` 1, was 0).
// ---------------------------------------------------------------------------
const EMBED_SRC = `
system Shop {
  subdomain Sales {
    context Shop {
      aggregate Wishlist shape: embedded {
        label: string
        contains items: WishItem[]
        create(label: string) { label := label }
        operation addItem(sku: string) { items += WishItem { sku: sku } }
        entity WishItem { sku: string }
      }
      repository Wishlists for Wishlist { }
    }
  }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
}
`;

describe("vanilla named-op persistence (embedded containment put_embed)", () => {
  it("builds the persist changeset off the pre-mutation struct so put_embed sees a diff", async () => {
    const facade = file(await generateSystemFiles(EMBED_SRC), "/shop.ex");
    const add = facade.slice(facade.indexOf("def add_item_wishlist("));
    // The original struct is captured BEFORE the body rebinds record.items…
    expect(add).toContain("record_before = record");
    expect(add).toContain(
      "record = %{record | items: (record.items || []) ++ [%Api.Shop.WishItem{sku: sku}]}",
    );
    // …and the changeset is built off that original, so put_embed(:items, <new>)
    // is a real diff against the OLD embed (a `record`-based base would drop it).
    expect(add).toContain("record_before\n    |> Ecto.Changeset.change(%{})");
    expect(add).toContain("|> Ecto.Changeset.put_embed(:items, record.items)");
  });
});
