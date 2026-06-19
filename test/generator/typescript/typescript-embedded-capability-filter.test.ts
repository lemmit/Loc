import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// DEBT-02 (slice 2) — capability `filter` on a `shape(embedded)` aggregate
// (node / Hono+Drizzle).  An embedded aggregate keeps its root scalars as real
// columns (only containments fold into jsonb), so a capability filter on a root
// scalar AND-s into the SQL `where` of every root read — the same Drizzle
// machinery the relational repository uses, not the in-app path the document
// repository needs.
// ---------------------------------------------------------------------------

const SOURCE = `
system EmbFilter {
  subdomain Sales {
    context Shop {
      aggregate Wishlist ids guid shape(embedded) {
        label: string
        archived: bool
        filter !this.archived
        contains items: WishItem[]
        operation archive() { archived := true }
        entity WishItem { sku: string }
      }
      repository Wishlists for Wishlist { find byLabel(l: string): Wishlist[] where label == l }
    }
  }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: node, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
}
`;

async function repo(src = SOURCE): Promise<string> {
  const files = await generateSystemFiles(src);
  const key = [...files.keys()].find((k) => /repositories\/.*wishlist/i.test(k))!;
  expect(key, "Wishlist embedded repository not emitted").toBeDefined();
  return files.get(key!)!;
}

describe("node embedded capability filter (DEBT-02 slice 2)", () => {
  it("ANDs the capability predicate into findById's SQL where", async () => {
    expect(await repo()).toContain(
      "where(and(eq(schema.wishlists.id, id), not(eq(schema.wishlists.archived, true))))",
    );
  });

  it("ANDs the capability predicate into findManyByIds", async () => {
    expect(await repo()).toContain(
      "where(and(inArray(schema.wishlists.id, ids), not(eq(schema.wishlists.archived, true))))",
    );
  });

  it("emits the capability filter alone on the synthesized findAll", async () => {
    expect(await repo()).toContain("where(not(eq(schema.wishlists.archived, true)))");
  });

  it("ANDs the capability into a custom find's own predicate", async () => {
    expect(await repo()).toContain(
      "where(and(eq(schema.wishlists.label, l), not(eq(schema.wishlists.archived, true))))",
    );
  });

  it("leaves a filter-free embedded aggregate's reads byte-identical", async () => {
    const noFilter = SOURCE.replace("        filter !this.archived\n", "");
    const r = await repo(noFilter);
    expect(r).toContain("where(eq(schema.wishlists.id, id))");
    expect(r).not.toContain("archived, true");
  });
});
