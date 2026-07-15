import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { generateDotnetForContexts } from "../../../src/generator/dotnet/index.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

// .NET TPH (sharedTable) emission — aggregate-inheritance.md I2.  The whole
// hierarchy maps to one EF table named for the abstract base, with a `kind`
// discriminator (value = the concrete's name, matching the Hono/Drizzle wire).
// The base owns the shared Id (EF Core native HasDiscriminator); concretes are
// derived entities that share the table and declare no Id of their own.

async function emitTph(): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(
    `
      system Acme {
        subdomain Registry {
          context Parties {
            abstract aggregate Party inheritanceUsing: sharedTable {
              name: string
            }
            aggregate Customer extends Party {
              creditLimit: int
            }
            aggregate Vendor extends Party {
              rating: int
            }
            repository Customers for Customer { }
            repository Vendors for Vendor { }
          }
        }
        deployable api {
          platform: dotnet
          contexts: [Parties]
          port: 8080
        }
      }
    `,
    { validation: true },
  );
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
  const sys = loom.systems[0]!;
  const dep = sys.deployables.find((d) => d.platform === "dotnet")!;
  const contexts = sys.subdomains.flatMap((m) => m.contexts);
  const ns = dep.name[0]!.toUpperCase() + dep.name.slice(1);
  return generateDotnetForContexts(contexts, ns, { deployable: dep, sys });
}

describe(".NET TPH emission", () => {
  it("the base is a mapped abstract entity that owns the shared Id", async () => {
    const out = await emitTph();
    const base = [...out].find(([p]) => p.endsWith("Party.cs"))?.[1] ?? "";
    expect(base).toContain("public abstract class Party");
    expect(base).toContain("public PartyId Id { get; internal set; }");
  });

  it("the base config maps one table + HasDiscriminator over the concretes", async () => {
    const out = await emitTph();
    const cfg = [...out].find(([p]) => p.endsWith("PartyConfiguration.cs"))?.[1] ?? "";
    expect(cfg).toContain('builder.ToTable("parties")');
    expect(cfg).toContain("builder.HasKey(x => x.Id)");
    expect(cfg).toContain('builder.HasDiscriminator<string>("kind")');
    expect(cfg).toContain('.HasValue<Customer>("Customer")');
    expect(cfg).toContain('.HasValue<Vendor>("Vendor")');
    // imports the concrete namespaces it names
    expect(cfg).toContain("using Api.Domain.Customers;");
    expect(cfg).toContain("using Api.Domain.Vendors;");
  });

  it("a concrete is a derived entity that shares the base Id (declares none)", async () => {
    const out = await emitTph();
    const cust = [...out].find(([p]) => p.endsWith("Customer.cs"))?.[1] ?? "";
    expect(cust).toContain("public sealed class Customer : Party");
    // Inherits Id from the base — must NOT re-declare it (CS0108 under /warnaserror).
    expect(cust).not.toContain("public CustomerId Id");
    // Its create factory mints the inherited PartyId, not a CustomerId.
    expect(cust).toContain("e.Id = new PartyId(");
  });

  it("a concrete config carries only its own columns (no ToTable/HasKey)", async () => {
    const out = await emitTph();
    const cfg = [...out].find(([p]) => p.endsWith("CustomerConfiguration.cs"))?.[1] ?? "";
    expect(cfg).toContain("IEntityTypeConfiguration<Customer>");
    expect(cfg).not.toContain("ToTable");
    expect(cfg).not.toContain("HasKey");
  });

  it("the DbContext exposes DbSet<Party> and does NOT Ignore the TPH base", async () => {
    const out = await emitTph();
    const db = [...out].find(([p]) => p.endsWith("AppDbContext.cs"))?.[1] ?? "";
    expect(db).toContain("DbSet<Party> Parties");
    expect(db).not.toContain("modelBuilder.Ignore<Party>()");
    expect(db).toContain("new Configurations.PartyConfiguration()");
  });
});
