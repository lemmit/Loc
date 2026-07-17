import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { beforeAll, describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// .NET document-persistence emission (`normalised(false)`).
//
// The document axis (D-DOCUMENT-AXIS): a `normalised(false)` aggregate
// persists as ONE JSONB document (`<Agg>Document` record: id / data /
// version) round-tripped via System.Text.Json through `<Agg>Snapshot`
// DTOs and the entity's `ToSnapshot()` / `FromSnapshot(...)` methods —
// instead of the normalised table-per-entity tree + join tables.
//
// `examples/document.ddd` pairs a document `Cart` (root + CartItem
// parts + Money VO + enum + Customer reference) with a normalised
// `Customer`, so this asserts BOTH the document path is emitted AND
// the normalised path for a sibling aggregate is untouched.  The
// `dotnet build /warnaserror` gate lives in
// test/e2e/generated-dotnet-build.test.ts.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

async function buildModel(file: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc.parseResult.value as Model;
}

describe(".NET document-persistence emission (normalised(false))", () => {
  let files: Map<string, string>;
  beforeAll(async () => {
    files = generateDotnet(await buildModel("examples/document.ddd"));
  });

  it("emits the document record (POCO) instead of a normalised entity config", () => {
    const keys = [...files.keys()];
    // Document path artefacts present…
    expect(keys).toContain("Infrastructure/Persistence/Documents/CartDocument.cs");
    expect(keys).toContain(
      "Infrastructure/Persistence/Configurations/CartDocumentConfiguration.cs",
    );
    expect(keys).toContain("Domain/Carts/CartSnapshots.cs");
    // …and the normalised entity configuration is NOT emitted for it.
    expect(keys).not.toContain("Infrastructure/Persistence/Configurations/CartConfiguration.cs");

    const poco = files.get("Infrastructure/Persistence/Documents/CartDocument.cs")!;
    expect(poco).toContain("public sealed class CartDocument");
    expect(poco).toContain("public Guid Id { get; set; }");
    expect(poco).toContain('public string Data { get; set; } = "{}";');
    expect(poco).toContain("public int Version { get; set; }");
  });

  it("configures the Data column as jsonb with a concurrency-token Version", () => {
    const cfg = files.get(
      "Infrastructure/Persistence/Configurations/CartDocumentConfiguration.cs",
    )!;
    expect(cfg).toContain("IEntityTypeConfiguration<CartDocument>");
    expect(cfg).toContain('builder.ToTable("carts");');
    // Every property is mapped to the migration's snake_case column — EF's
    // default PascalCase (`Id`/`Data`/`Version`) does not match the DDL, so an
    // unqualified mapping yields `column c.Id does not exist` at runtime.
    expect(cfg).toContain('builder.Property(x => x.Id).HasColumnName("id").ValueGeneratedNever();');
    expect(cfg).toContain(
      'builder.Property(x => x.Data).HasColumnName("data").HasColumnType("jsonb");',
    );
    expect(cfg).toContain(
      'builder.Property(x => x.Version).HasColumnName("version").IsConcurrencyToken();',
    );
  });

  it("emits snapshot records mirroring the entity tree (root + parts)", () => {
    const snaps = files.get("Domain/Carts/CartSnapshots.cs")!;
    expect(snaps).toContain("public sealed record CartSnapshot");
    expect(snaps).toContain("public CartId Id { get; init; }");
    expect(snaps).toContain("public CustomerId CustomerId { get; init; }");
    expect(snaps).toContain("public CartStatus Status { get; init; }");
    expect(snaps).toContain("public List<CartItemSnapshot> Items { get; init; } = new();");
    // Contained part snapshot carries ParentId + the part's own fields.
    expect(snaps).toContain("public sealed record CartItemSnapshot");
    expect(snaps).toContain("public CartId ParentId { get; init; }");
    expect(snaps).toContain("public Money UnitPrice { get; init; } = default!;");
  });

  it("emits ToSnapshot/FromSnapshot on the root and the contained part", () => {
    const cart = files.get("Domain/Carts/Cart.cs")!;
    expect(cart).toContain("internal CartSnapshot ToSnapshot()");
    expect(cart).toContain("Items = _items.Select(__x => __x.ToSnapshot()).ToList(),");
    expect(cart).toContain("internal static Cart FromSnapshot(CartSnapshot s)");
    // Parts rehydrate into the private backing list, then invariants run
    // once over the full tree.
    expect(cart).toContain(
      "foreach (var __it in s.Items) e._items.Add(CartItem.FromSnapshot(__it));",
    );
    expect(cart).toContain("e.AssertInvariants();");

    const item = files.get("Domain/Carts/CartItem.cs")!;
    expect(item).toContain("internal CartItemSnapshot ToSnapshot()");
    expect(item).toContain("internal static CartItem FromSnapshot(CartItemSnapshot s)");
    expect(item).toContain("e.ParentId = s.ParentId;");
  });

  it("repository (de)serialises Data via the snapshot + bumps Version", () => {
    const repo = files.get("Infrastructure/Repositories/CartRepository.cs")!;
    // Save: serialise ToSnapshot, insert with Version 1 or bump existing.
    expect(repo).toContain(
      "var __data = System.Text.Json.JsonSerializer.Serialize(aggregate.ToSnapshot(), __json);",
    );
    expect(repo).toContain(
      "_db.Carts.Add(new CartDocument { Id = aggregate.Id.Value, Data = __data, Version = 1 });",
    );
    expect(repo).toContain("__existing.Version += 1;");
    // Load: deserialise + FromSnapshot.
    expect(repo).toContain(
      "return Cart.FromSnapshot(System.Text.Json.JsonSerializer.Deserialize<CartSnapshot>(__doc.Data, __json)!);",
    );
    // Find evaluates client-side over rehydrated documents (de-asynced
    // terminal): `.ToList()`, not `.ToListAsync(cancellationToken)`.
    expect(repo).toContain("var result = __all.Where(x => x.CustomerId == customerId).ToList();");
    expect(repo).not.toContain("_db.Carts.Where(x => x.CustomerId");
  });

  it("routes the DbSet to the document record and skips the join layer", () => {
    const dbctx = files.get("Infrastructure/Persistence/AppDbContext.cs")!;
    expect(dbctx).toContain("public DbSet<CartDocument> Carts => Set<CartDocument>();");
    expect(dbctx).toContain("new Configurations.CartDocumentConfiguration()");
    // Sibling normalised aggregate is untouched — still a plain DbSet<T>.
    expect(dbctx).toContain("public DbSet<Customer> Customers => Set<Customer>();");
  });

  it("leaves the sibling normalised aggregate on the relational path", () => {
    const keys = [...files.keys()];
    expect(keys).toContain("Infrastructure/Persistence/Configurations/CustomerConfiguration.cs");
    expect(keys).not.toContain("Infrastructure/Persistence/Documents/CustomerDocument.cs");
    // No snapshot/ToSnapshot leaks into the normalised entity.
    const customer = files.get("Domain/Customers/Customer.cs")!;
    expect(customer).not.toContain("ToSnapshot");
  });

  // shape: embedded: queryable root row + contained parts folded into a
  // JSONB column via EF owned-types `.ToJson()`.  Unlike `document`, the
  // entity/repository/DbSet are the NORMAL relational ones — only the EF
  // configuration changes, so finds stay real SQL.
  it("embedded: folds the containment into a JSONB column via OwnsMany().ToJson()", () => {
    const cfg = files.get("Infrastructure/Persistence/Configurations/WishlistConfiguration.cs")!;
    expect(cfg).toContain("IEntityTypeConfiguration<Wishlist>");
    // Root scalar / `X id` columns stay (queryable + indexed).
    expect(cfg).toContain("builder.Property(x => x.CustomerId).HasConversion");
    expect(cfg).toContain("builder.HasIndex(x => x.CustomerId);");
    // Containment folds to one JSONB column — no child table.
    expect(cfg).toContain('builder.OwnsMany<WishItem>("_items", o => {');
    expect(cfg).toContain('o.ToJson("items");');
    expect(cfg).not.toContain("o.ToTable(");
    expect(cfg).not.toContain('o.WithOwner().HasForeignKey("ParentId")');
  });

  it("embedded: uses the normal entity + DbSet<T> + relational repository (real SQL finds)", () => {
    const keys = [...files.keys()];
    // No document POCO / snapshot for an embedded aggregate.
    expect(keys).not.toContain("Infrastructure/Persistence/Documents/WishlistDocument.cs");
    expect(keys).not.toContain("Domain/Wishlists/WishlistSnapshots.cs");
    const dbctx = files.get("Infrastructure/Persistence/AppDbContext.cs")!;
    expect(dbctx).toContain("public DbSet<Wishlist> Wishlists => Set<Wishlist>();");
    const repo = files.get("Infrastructure/Repositories/WishlistRepository.cs")!;
    // Find is a real indexed SQL WHERE on the root column, not in-memory.
    expect(repo).toContain(
      "_db.Wishlists.Where(x => x.CustomerId == customerId).ToListAsync(cancellationToken)",
    );
    expect(repo).not.toContain("FromSnapshot");
    // Entity carries no snapshot machinery.
    const wishlist = files.get("Domain/Wishlists/Wishlist.cs")!;
    expect(wishlist).not.toContain("ToSnapshot");
  });
});
