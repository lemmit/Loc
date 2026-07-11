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
      aggregate Wishlist shape(embedded) {
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

// ---------------------------------------------------------------------------
// DEBT-02 Slice A — a PRINCIPAL-referencing capability filter
// (`filter this.tenantId == currentUser.tenantId`) on a `shape(embedded)`
// aggregate (node).  The embedded root scalars are real columns, so the
// principal predicate reuses the relational-principal path: every embedded
// root read AND-s `eq(schema.<agg>.tenantId, requireCurrentUser().tenantId)`,
// and the repository imports `requireCurrentUser` from `../../auth/middleware`.
// Previously gated by `loom.context-filter-unsupported`; the system needs a
// `user {}` block AND `auth: required`.
// ---------------------------------------------------------------------------

const PRINCIPAL_SOURCE = `
system EmbTenancy {
  user { id: string  tenantId: string }
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
  deployable api { platform: node, contexts: [Shop], dataSources: [st], serves: A, auth: required, port: 4100 }
}
`;

async function principalRepo(): Promise<string> {
  const files = await generateSystemFiles(PRINCIPAL_SOURCE);
  const key = [...files.keys()].find((k) => /repositories\/.*order/i.test(k));
  expect(key, "Order embedded repository not emitted").toBeDefined();
  return files.get(key!)!;
}

describe("node embedded principal (tenancy) capability filter (DEBT-02 Slice A)", () => {
  it("imports requireCurrentUser from the auth middleware", async () => {
    expect(await principalRepo()).toContain(
      'import { requireCurrentUser } from "../../auth/middleware"',
    );
  });

  it("weaves the principal predicate into the synthesized findAll", async () => {
    expect(await principalRepo()).toContain(
      "where(eq(schema.orders.tenantId, requireCurrentUser().tenantId))",
    );
  });

  it("ANDs the principal into findById so a guessed cross-tenant id can't leak", async () => {
    expect(await principalRepo()).toContain(
      "where(and(eq(schema.orders.id, id), eq(schema.orders.tenantId, requireCurrentUser().tenantId)))",
    );
  });

  it("ANDs the principal into a custom find's own predicate", async () => {
    expect(await principalRepo()).toContain(
      "where(and(eq(schema.orders.code, code), eq(schema.orders.tenantId, requireCurrentUser().tenantId)))",
    );
  });
});
