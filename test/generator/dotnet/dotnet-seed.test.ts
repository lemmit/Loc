import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// Mirrors the Hono seed fixture (string / int / enum / value-object fields),
// targeting a `platform: dotnet` deployable.  Namespace derives from the
// deployable name `api` → `Api`.
const FIXTURE = `system AcmeSeed {
  subdomain Shop {
    context Catalog {
      enum Tier { Free, Pro }
      valueobject Money { amount: decimal currency: string }
      aggregate Product with crudish {
        sku: string
        price: Money
        tier: Tier
        stock: int
      }
      repository Products for Product { }

      seed default {
        Product { sku: "BASE-1", price: Money { amount: 1.0, currency: "USD" }, tier: Free, stock: 1 }
      }
      seed demo {
        Product { sku: "DEMO-1", price: Money { amount: 9.99, currency: "USD" }, tier: Pro, stock: 10 }
        Product { sku: "DEMO-2", price: Money { amount: 19.99, currency: "USD" }, tier: Pro, stock: 5 }
      }
    }
  }
  api ShopApi from Shop
  deployable api {
    platform: dotnet
    contexts: [Catalog]
    serves: ShopApi
    port: 8080
  }
}
`;

async function build(src = FIXTURE): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function find(files: Map<string, string>, re: RegExp): string {
  for (const [k, v] of files) if (re.test(k)) return v;
  throw new Error(`no file matched ${re}`);
}

describe("dotnet database seeding (Phase 3a, domain path)", () => {
  it("emits Seed.cs going through the positional Create + repository SaveAsync", async () => {
    const files = await build();
    const seed = find(files, /Infrastructure\/Persistence\/Seed\.cs$/);

    // Through the domain Create (D-SEED-PATH); positional args in field order.
    expect(seed).toContain('Product.Create("BASE-1", new Money(1.0m, "USD"), Tier.Free, 1)');
    expect(seed).toContain('Product.Create("DEMO-1", new Money(9.99m, "USD"), Tier.Pro, 10)');
    expect(seed).toContain("sp.GetRequiredService<IProductRepository>()");
    expect(seed).toContain("await productRepo.SaveAsync(");

    // Usings narrowed to what's referenced.
    expect(seed).toContain("using Api.Domain.Products;");
    expect(seed).toContain("using Api.Domain.ValueObjects;");
    expect(seed).toContain("using Api.Domain.Enums;");
    expect(seed).toContain("namespace Api.Infrastructure.Persistence;");
  });

  it("is ship-once per dataset via the __loom_seed marker (D-SEED-IDEMPOTENCY)", async () => {
    const seed = find(await build(), /Seed\.cs$/);
    expect(seed).toContain('CREATE TABLE IF NOT EXISTS \\"__loom_seed\\"');
    expect(seed).toContain("if (await AlreadySeeded(db,");
    expect(seed).toContain("await MarkSeeded(db,");
  });

  it("gates non-default datasets on LOOM_SEED; default always runs", async () => {
    const seed = find(await build(), /Seed\.cs$/);
    expect(seed).toContain('Environment.GetEnvironmentVariable("LOOM_SEED")');
    expect(seed).toContain('dataset == "default" || requested.Contains(dataset)');
    expect(seed).toContain("private static async Task SeedDefault(");
    expect(seed).toContain("private static async Task SeedDemo(");
  });

  it("wires Seed.RunSeeds into Program.cs after migrations", async () => {
    const program = find(await build(), /Program\.cs$/);
    expect(program).toContain("await Api.Infrastructure.Persistence.Seed.RunSeeds(");
    expect(program.indexOf("db.Database.Migrate()")).toBeLessThan(
      program.indexOf("Seed.RunSeeds("),
    );
  });

  it("also emits the seeder via the legacy per-context `generate dotnet` path", async () => {
    // The build gate runs `ddd generate dotnet <file>` (legacy, per-context),
    // not `generate system` — so the per-context path must emit Seed.cs too.
    const TOP_LEVEL = `context Catalog {
      enum Tier { Free, Pro }
      aggregate Widget with crudish { name: string size: int tier: Tier derived display: string = name }
      repository Widgets for Widget { }
      seed default { Widget { name: "Alpha", size: 1, tier: Free } }
    }`;
    const { model, errors } = await parseString(TOP_LEVEL);
    if (errors.length) throw new Error(errors.join("\n"));
    const files = generateDotnet(model);
    const seed = [...files].find(([k]) => /Seed\.cs$/.test(k))?.[1];
    expect(seed).toBeDefined();
    expect(seed!).toContain('Widget.Create("Alpha", 1, Tier.Free)');
  });

  it("omits the seeder entirely when no seed block is declared", async () => {
    const noSeed = FIXTURE.replace(/seed default \{[\s\S]*?\n {6}\}\n/, "").replace(
      /seed demo \{[\s\S]*?\n {6}\}\n/,
      "",
    );
    const files = await build(noSeed);
    for (const k of files.keys()) expect(k).not.toMatch(/Seed\.cs$/);
    const program = find(files, /Program\.cs$/);
    expect(program).not.toContain("Seed.RunSeeds(");
  });
});

describe("dotnet seeding — @handle cross-row references", () => {
  const HANDLE = `system S {
    subdomain Sales { context Sales {
      aggregate Customer with crudish { name: string }
      aggregate Order with crudish { customerId: Customer id status: string }
      repository Customers for Customer { }
      repository Orders for Order { }
      seed demo {
        Order { customerId: @acme, status: "new" }
        Customer @acme { name: "Acme" }
      }
    } }
    api A from Sales
    deployable api { platform: dotnet contexts: [Sales] serves: A port: 8080 }
  }`;

  it("binds a handled row to a var (topo-first) and references its Id", async () => {
    const seed = find(await build(HANDLE), /Seed\.cs$/);
    expect(seed).toContain('var acme = Customer.Create("Acme");');
    expect(seed).toContain("await customerRepo.SaveAsync(acme, ct);");
    expect(seed).toContain("Order.Create(acme.Id,");
    expect(seed.indexOf("var acme =")).toBeLessThan(seed.indexOf("acme.Id"));
  });
});
