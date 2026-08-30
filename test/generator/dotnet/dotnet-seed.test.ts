import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { generateSystemFiles, parseString } from "../../_helpers/index.js";

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
  storage primary { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: primary }
  deployable api {
    platform: dotnet
    contexts: [Catalog]
    dataSources: [catalogState]
    serves: ShopApi
    port: 8080
  }
}
`;

async function build(src = FIXTURE): Promise<Map<string, string>> {
  return await generateSystemFiles(src);
}

function find(files: Map<string, string>, re: RegExp): string {
  for (const [k, v] of files) if (re.test(k)) return v;
  throw new Error(`no file matched ${re}`);
}

describe("dotnet database seeding (Phase 3a, domain path)", () => {
  it("emits Seed.cs going through the named-arg Create + repository SaveAsync", async () => {
    const files = await build();
    const seed = find(files, /Infrastructure\/Persistence\/Seed\.cs$/);

    // Through the domain Create (D-SEED-PATH); named args over the full
    // create-input set, so a row that omits optional fields still supplies
    // every factory parameter.
    expect(seed).toContain(
      'Product.Create(sku: "BASE-1", price: new Money(1.0m, "USD"), tier: Tier.Free, stock: 1)',
    );
    expect(seed).toContain(
      'Product.Create(sku: "DEMO-1", price: new Money(9.99m, "USD"), tier: Tier.Pro, stock: 10)',
    );
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
    expect(seed!).toContain('Widget.Create(name: "Alpha", size: 1, tier: Tier.Free)');
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

describe("dotnet seeding — raw explicit-id path", () => {
  const RAW = `system S {
    subdomain Sales { context Sales {
      aggregate Customer with crudish { name: string }
      aggregate Order with crudish { customerId: Customer id status: string }
      repository Customers for Customer { }
      repository Orders for Order { }
      seed reference raw {
        Customer { id: "c1", name: "Acme" }
        Order { id: "o1", customerId: "c1", status: "new" }
      }
    } }
    api A from Sales
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable api { platform: dotnet contexts: [Sales] dataSources: [salesState] serves: A port: 8080 }
  }`;

  it("emits ExecuteSqlRawAsync INSERTs with explicit id + FK", async () => {
    const seed = find(await build(RAW), /Seed\.cs$/);
    // Schema-qualified, because every accepted model qualifies — see the
    // RAW_WITH_SCHEMA note below.
    expect(seed).toContain(
      'await db.Database.ExecuteSqlRawAsync(@"INSERT INTO ""sales"".""customers"" (""id"", ""name"") VALUES (\'c1\', \'Acme\')", cancellationToken);',
    );
    expect(seed).toContain(
      'INSERT INTO ""sales"".""orders"" (""id"", ""customer_id"", ""status"")',
    );
    expect(seed).not.toContain("Customer.Create(");
  });

  // With a dataSource binding, EF maps the entity to `ToTable("customers",
  // "sales")` and the migration creates `"sales"."customers"` — but the raw
  // INSERT was built unqualified, so a `default` dataset carrying raw rows
  // failed at first boot (`relation "customers" does not exist`).  python and
  // java qualified theirs from the start; the .NET and node halves are fixed
  // together in #2517.  The fixture above used to skip the binding and pin the
  // unqualified SQL — but a backend deployable hosting a context MUST bind a
  // dataSource (`loom.persistence-mode-unsupported`), so the unqualified shape
  // is unreachable in the product and both fixtures now bind one (M-T9.35).
  const RAW_WITH_SCHEMA = `system S {
    subdomain Sales { context Sales {
      aggregate Customer with crudish { name: string }
      repository Customers for Customer { }
      seed default raw {
        Customer { id: "11111111-1111-1111-1111-111111111111", name: "Acme" }
      }
    } }
    api A from Sales
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable api { platform: dotnet contexts: [Sales] dataSources: [salesState] serves: A port: 8080 }
  }`;

  it("qualifies the raw INSERT with the aggregate's dataSource schema", async () => {
    const files = await build(RAW_WITH_SCHEMA);
    expect(find(files, /Seed\.cs$/)).toContain('INSERT INTO ""sales"".""customers""');
    // The EF mapping for the same table, so the two agree.
    expect(find(files, /CustomerConfiguration\.cs$/)).toContain('ToTable("customers", "sales")');
  });

  // …and the SAME model on the Dapper adapter (F2-ADP-2).  `persistence: dapper`
  // is SELF-PROVISIONING: no migration chain, its DDL is `DbSchema.EnsureAsync`,
  // and every Dapper statement names tables UNQUALIFIED.  Qualifying the raw
  // seed off the per-context dataSource schema therefore inserted into a schema
  // nothing ever created — `RunSeeds` threw `3F000 schema "sales" does not
  // exist` on first boot, invisible to the .NET compile gate (it is a C# string
  // literal) and to schema-load (which loads the migration chain this adapter
  // does not use).
  const RAW_DAPPER = RAW_WITH_SCHEMA.replace(
    "platform: dotnet ",
    "platform: dotnet { persistence: dapper } ",
  );

  /** Every table an emitted C# file provisions (`CREATE TABLE [IF NOT EXISTS]
   *  <t>`) or writes (`INSERT INTO <t>`), normalised to `schema.table` with the
   *  C#-literal quoting (`""` / `\"`) stripped. */
  function sqlTables(src: string, verb: "CREATE TABLE" | "INSERT INTO"): string[] {
    const re = new RegExp(`${verb}(?: IF NOT EXISTS)? ((?:[^\\s(]|\\\\")+)`, "g");
    return [...src.matchAll(re)].map((m) => m[1]!.replace(/\\"|""|"/g, ""));
  }

  it("dapper: every raw seed INSERT targets a table the emitted DDL creates", async () => {
    const files = await build(RAW_DAPPER);
    const seed = find(files, /Seed\.cs$/);
    const provisioned = new Set([
      ...sqlTables(find(files, /DbSchema\.cs$/), "CREATE TABLE"),
      // the `__loom_seed` idempotency marker Seed.cs provisions itself
      ...sqlTables(seed, "CREATE TABLE"),
    ]);
    const written = sqlTables(seed, "INSERT INTO");
    expect(written.length).toBeGreaterThan(0);
    for (const t of written) expect([...provisioned]).toContain(t);
    // Concretely: unqualified on both sides, matching the adapter's layout.
    expect(seed).toContain('INSERT INTO ""customers""');
    expect(seed).not.toContain('""sales"".""customers""');
  });
});
