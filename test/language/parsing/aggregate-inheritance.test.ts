import { wireFieldsFor } from "../../../src/ir/enrich/wire-projection.js";
// Aggregate-inheritance surface (aggregate-inheritance.md, phase I1).
// Covers the grammar (`abstract` prefix, `extends <Base>`,
// `inheritanceUsing(sharedTable | ownTable)` header modifier), the IR
// threading (`isAbstract` / `extendsAggregate` / `inheritanceUsing`), and
// the I1 validator rules (extends-non-abstract, modifier placement,
// abstract has no behaviour / no repository, and the D-ES-TPH forced
// `ownTable`).  No emission semantics yet — that is I2/I3.

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Aggregate, Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

async function parse(src: string) {
  const { parseHelper } = await import("langium/test");
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  return { model: doc.parseResult.value as Model, errors };
}

function aggs(model: Model): Aggregate[] {
  const ctx = model.members[0] as
    | import("../../../src/language/generated/ast.js").BoundedContext
    | undefined;
  return (ctx?.members.filter((m) => m.$type === "Aggregate") ?? []) as Aggregate[];
}

describe("aggregate inheritance — grammar (I1)", () => {
  it("parses an abstract base and a concrete subtype that extends it", async () => {
    const { model, errors } = await parse(`
      context Parties {
        abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
        aggregate Customer extends Party { creditLimit: decimal }
      }
    `);
    expect(errors.map((e) => e.message)).toEqual([]);
    const [party, customer] = aggs(model);
    expect(party.isAbstract).toBe(true);
    expect(party.inheritanceUsing).toBe("sharedTable");
    expect(customer.isAbstract).toBe(false);
    expect(customer.superType?.ref?.name).toBe("Party");
  });

  it("parses inheritanceUsing(ownTable) and coexists with persistedAs / shape", async () => {
    const { model, errors } = await parse(`
      context Parties {
        abstract aggregate Party inheritanceUsing(ownTable) { name: string }
        aggregate Ledger extends Party persistedAs(eventLog) inheritanceUsing(ownTable) { n: int }
      }
    `);
    expect(errors.map((e) => e.message)).toEqual([]);
    const [party, ledger] = aggs(model);
    expect(party.inheritanceUsing).toBe("ownTable");
    expect(ledger.persistedAs).toBe("eventLog");
    expect(ledger.inheritanceUsing).toBe("ownTable");
  });

  it("omits inheritance fields on a plain aggregate", async () => {
    const { model, errors } = await parse(`context T { aggregate Cart { name: string } }`);
    expect(errors.map((e) => e.message)).toEqual([]);
    const [cart] = aggs(model);
    expect(cart.isAbstract).toBe(false);
    expect(cart.superType).toBeUndefined();
    expect(cart.inheritanceUsing).toBeUndefined();
  });

  it("rejects an unknown inheritanceUsing value", async () => {
    const { errors } = await parse(`
      context T { abstract aggregate Party inheritanceUsing(tpt) { name: string } }
    `);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("aggregate inheritance — IR threading (I1)", () => {
  const SRC = `
system Sys {
  subdomain Sales {
    context Parties {
      abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
      aggregate Customer extends Party { creditLimit: decimal }
    }
  }
}
`;

  it("threads isAbstract / extendsAggregate / inheritanceUsing onto AggregateIR", async () => {
    const loom = lowerModel(await parseValid(SRC));
    const ctx = loom.systems[0]!.subdomains[0]!.contexts.find((c) => c.name === "Parties")!;
    const party = ctx.aggregates.find((a) => a.name === "Party")!;
    const customer = ctx.aggregates.find((a) => a.name === "Customer")!;
    expect(party.isAbstract).toBe(true);
    expect(party.inheritanceUsing).toBe("sharedTable");
    expect(party.extendsAggregate).toBeUndefined();
    expect(customer.isAbstract).toBeUndefined();
    expect(customer.extendsAggregate).toBe("Party");
  });
});

describe("aggregate inheritance — validator (I1)", () => {
  const codes = (es: { code?: string | number }[]) =>
    es.map((e) => e.code).filter((c): c is string => typeof c === "string");

  it("rejects extending a non-abstract aggregate (loom.extends-non-abstract)", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Party { name: string }
        aggregate Customer extends Party { creditLimit: decimal }
      }
    `);
    expect(codes(errors)).toContain("loom.extends-non-abstract");
  });

  it("rejects inheritanceUsing(…) on a plain aggregate (loom.inheritance-modifier-misplaced)", async () => {
    const { errors } = await parse(`
      context T { aggregate Cart inheritanceUsing(sharedTable) { name: string } }
    `);
    expect(codes(errors)).toContain("loom.inheritance-modifier-misplaced");
  });

  it("rejects a create/operation on an abstract base (loom.abstract-aggregate-behavior)", async () => {
    const { errors } = await parse(`
      context T {
        abstract aggregate Party {
          name: string
          operation rename(to: string) { this.name = to }
        }
      }
    `);
    expect(codes(errors)).toContain("loom.abstract-aggregate-behavior");
  });

  it("rejects a repository for an abstract base (loom.abstract-repository)", async () => {
    const { errors } = await parse(`
      context T {
        abstract aggregate Party { name: string }
        aggregate Customer extends Party { creditLimit: decimal }
        repository Parties for Party { }
      }
    `);
    expect(codes(errors)).toContain("loom.abstract-repository");
  });

  it("forces ownTable for an eventLog concrete of a sharedTable base (loom.es-tph-forced-own-table)", async () => {
    const { errors } = await parse(`
      context T {
        abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
        aggregate Ledger extends Party persistedAs(eventLog) { n: int }
      }
    `);
    expect(codes(errors)).toContain("loom.es-tph-forced-own-table");
  });

  it("accepts the eventLog concrete once it declares inheritanceUsing(ownTable)", async () => {
    const { errors } = await parse(`
      context T {
        abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
        aggregate Ledger extends Party persistedAs(eventLog) inheritanceUsing(ownTable) { n: int }
      }
    `);
    expect(codes(errors)).not.toContain("loom.es-tph-forced-own-table");
  });

  it("rejects a voluntary ownTable override under a sharedTable base (loom.tph-own-override-unsupported)", async () => {
    // Mixed strategy (Pattern 3): LegacyVendor opts out of the shared table.
    // Rejected at the declaration regardless of any polymorphic reference,
    // naming the offending concrete.
    const { errors } = await parse(`
      context T {
        abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
        aggregate Customer extends Party { creditLimit: decimal }
        aggregate LegacyVendor extends Party inheritanceUsing(ownTable) { obscure: string }
      }
    `);
    expect(codes(errors)).toContain("loom.tph-own-override-unsupported");
    expect(errors.some((e) => /LegacyVendor/.test(e.message ?? ""))).toBe(true);
  });

  it("keeps the D-ES-TPH ownTable opt-out allowed (eventLog concrete is not a mixed-strategy override)", async () => {
    // An eventLog concrete is FORCED to ownTable by D-ES-TPH — that sanctioned
    // opt-out must not trip the voluntary-override gate.
    const { errors } = await parse(`
      context T {
        abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
        aggregate Ledger extends Party persistedAs(eventLog) inheritanceUsing(ownTable) { n: int }
      }
    `);
    expect(codes(errors)).not.toContain("loom.tph-own-override-unsupported");
  });

  it("allows a 'contains' part on a TPH (sharedTable) concrete (Pattern 4)", async () => {
    // A TPH concrete's contained part gets its own table FK'd to the SHARED
    // base table — the concrete's id IS the shared-table row id, so the
    // repository's parentId-keyed load/save works unchanged.
    const { errors } = await parse(`
      context T {
        abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
        aggregate Customer extends Party {
          creditLimit: decimal
          contains addresses: Address[]
          entity Address { street: string }
        }
      }
    `);
    expect(codes(errors)).not.toContain("loom.tph-contains-unsupported");
  });

  it("allows a 'contains' part on an ownTable (TPC) concrete (it has its own table)", async () => {
    const { errors } = await parse(`
      context T {
        abstract aggregate Party inheritanceUsing(ownTable) { name: string }
        aggregate Customer extends Party inheritanceUsing(ownTable) {
          creditLimit: decimal
          contains addresses: Address[]
          entity Address { street: string }
        }
      }
    `);
    expect(codes(errors)).not.toContain("loom.tph-contains-unsupported");
  });
});

describe("aggregate inheritance — field inheritance into wireShape (I2 foundation)", () => {
  const SRC = `
system Sys {
  subdomain Sales {
    context Parties {
      abstract aggregate Party inheritanceUsing(ownTable) { name: string email: string }
      aggregate Customer extends Party inheritanceUsing(ownTable) { creditLimit: decimal }
    }
  }
}
`;

  it("merges base fields ahead of own fields in the concrete's wireShape", async () => {
    const enriched = enrichLoomModel(lowerModel(await parseValid(SRC)));
    const ctx = enriched.systems[0]!.subdomains[0]!.contexts.find((c) => c.name === "Parties")!;
    const customer = ctx.aggregates.find((a) => a.name === "Customer")!;
    const names = wireFieldsFor(customer).map((f) => f.name);
    // id first, then inherited base fields, then own.
    expect(names).toEqual(["id", "name", "email", "creditLimit"]);
  });

  it("does not duplicate a base field the concrete redeclares (own shadows)", async () => {
    const SRC2 = `
system Sys {
  subdomain Sales {
    context Parties {
      abstract aggregate Party inheritanceUsing(ownTable) { name: string }
      aggregate Customer extends Party inheritanceUsing(ownTable) { name: string tier: int }
    }
  }
}
`;
    const enriched = enrichLoomModel(lowerModel(await parseValid(SRC2)));
    const ctx = enriched.systems[0]!.subdomains[0]!.contexts.find((c) => c.name === "Parties")!;
    const customer = ctx.aggregates.find((a) => a.name === "Customer")!;
    const names = wireFieldsFor(customer).map((f) => f.name);
    expect(names.filter((n) => n === "name")).toHaveLength(1);
    expect(names).toEqual(["id", "name", "tier"]);
  });

  it("emits no inheritance diagnostic for an ownTable (TPC) hierarchy (IR-validate)", async () => {
    // SRC declares inheritanceUsing(ownTable) on both base and concrete —
    // TPC emission is wired (each concrete is a standalone table; the base
    // is dropped from the generation view), so validation stays quiet.
    const diags = validateLoomModel(enrichLoomModel(lowerModel(await parseValid(SRC))));
    const inheritance = diags.filter((d) => /TPH|TPC|inheritance/i.test(d.message));
    expect(inheritance).toEqual([]);
  });
});

describe("aggregate inheritance — storage gate + ownTable emission (I2/I3)", () => {
  const codes = (es: { code?: string | number }[]) =>
    es.map((e) => e.code).filter((c): c is string => typeof c === "string");

  const OWN_TABLE = `
system Sys {
  subdomain Parties {
    context Parties {
      abstract aggregate Party inheritanceUsing(ownTable) { name: string email: string }
      aggregate Customer extends Party inheritanceUsing(ownTable) { creditLimit: decimal }
    }
  }
  storage primary { type: postgres }
  resource partiesState { for: Parties, kind: state, use: primary }
  deployable api {
    platform: node
    contexts: [Parties]
    dataSources: [partiesState]
    port: 3000
  }
}
`;

  it("gates a sharedTable (TPH) hierarchy as a not-implemented error (IR-validate)", async () => {
    const SHARED = `
system Sys {
  subdomain Sales {
    context Parties {
      abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
      aggregate Customer extends Party inheritanceUsing(sharedTable) { creditLimit: decimal }
    }
  }
}
`;
    const diags = validateLoomModel(enrichLoomModel(lowerModel(await parseValid(SHARED))));
    const errors = diags.filter((d) => d.severity === "error" && /TPH/.test(d.message));
    // both the abstract base and the concrete subtype resolve to sharedTable.
    expect(errors.map((e) => e.source).sort()).toEqual(["Parties/Customer", "Parties/Party"]);
  });

  it("gates an inheritance hierarchy with no inheritanceUsing(…) (sharedTable default) as an error", async () => {
    const DEFAULTED = `
system Sys {
  subdomain Sales {
    context Parties {
      abstract aggregate Party { name: string }
      aggregate Customer extends Party { creditLimit: decimal }
    }
  }
}
`;
    const diags = validateLoomModel(enrichLoomModel(lowerModel(await parseValid(DEFAULTED))));
    const errors = diags.filter((d) => d.severity === "error" && /sharedTable/.test(d.message));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("drops the abstract base's TABLE from the generation view (concretes are standalone)", async () => {
    const model = await parseValid(OWN_TABLE);
    const { files } = generateSystems(model);
    const all = [...files.values()].join("\n");
    // The concrete subtype emits its standalone table (carrying the merged
    // base fields); the abstract base emits no table of its own. (The
    // `pgSchema("parties")` namespace is the context schema, not a base table.)
    expect(all).toMatch(/\.table\("customers"/);
    expect(all).not.toMatch(/\.table\("parties"/);
    // Inherited base fields ride along on the concrete's table.
    expect(all).toMatch(/text\("email"\)/);
    expect(all).toMatch(/numeric\("credit_limit"\)/);
    // The abstract base contributes no TABLE and no HTTP routes/mount…
    const paths = [...files.keys()];
    expect(paths.some((p) => /customer/i.test(p))).toBe(true);
    expect(paths.some((p) => /party\.routes/i.test(p))).toBe(false);
    const idx = files.get("api/http/index.ts") ?? "";
    expect(idx).not.toMatch(/app\.route\("\/api\/parties"/);
    // …but on Hono it DOES emit the polymorphic read home: the `Party` union
    // + a read-only `PartyRepository` that delegates to the concrete repos
    // (the `find all Party` reader — covered in detail below).
    expect(paths).toContain("api/domain/party.ts");
    expect(paths).toContain("api/db/repositories/party-repository.ts");
  });

  it("emits a TPC base reader: `find all Party` delegates to each concrete repo", async () => {
    const { files } = generateSystems(await parseValid(OWN_TABLE));
    const union = files.get("api/domain/party.ts") ?? "";
    expect(union).toMatch(/export type Party = Customer/);
    // Not a `kind`-discriminated shared table — resolved per-table.
    expect(union).toMatch(/each concrete is its own table/);
    const reader = files.get("api/db/repositories/party-repository.ts") ?? "";
    expect(reader).toMatch(/export class PartyRepository/);
    // Constructs the concrete repos and delegates.
    expect(reader).toMatch(/new CustomerRepository\(db, events\)/);
    expect(reader).toMatch(/async findAll\(\): Promise<Party\[\]>/);
    expect(reader).toMatch(/this\.customerRepo\.all\(\)/);
    // findById tries each concrete in turn.
    expect(reader).toMatch(/async findById\(id: Ids\.PartyId\): Promise<Party \| null>/);
    expect(reader).toMatch(/this\.customerRepo\.findById\(/);
    // Read-only: no save/delete.
    expect(reader).not.toMatch(/async save\(/);
  });

  it("rejects a polymorphic 'Base id' reference to an abstract base (loom.polymorphic-id-ref-unsupported)", async () => {
    const { errors } = await parse(`
      context T {
        abstract aggregate Party inheritanceUsing(ownTable) { name: string }
        aggregate Customer extends Party inheritanceUsing(ownTable) { creditLimit: decimal }
        aggregate Order { buyer: Party id }
      }
    `);
    expect(codes(errors)).toContain("loom.polymorphic-id-ref-unsupported");
  });

  // The abstract-base handling lives in the shared system orchestrator
  // (collectContextsFor), upstream of every platform's emitProject — so
  // ownTable/TPC (including the polymorphic `find all <Base>` read home) is
  // complete cross-backend, not just for Hono. A concrete `extends` subtype is
  // a normal aggregate carrying the merged base fields; the abstract base owns
  // no table/repo/routes but anchors the per-backend polymorphic reader.
  const TPC_TWO_CONCRETE = (platform: string, port: number) => `
system Sys {
  subdomain Parties {
    context Parties {
      abstract aggregate Party inheritanceUsing(ownTable) { name: string email: string }
      aggregate Customer extends Party inheritanceUsing(ownTable) { creditLimit: decimal }
      aggregate Supplier extends Party inheritanceUsing(ownTable) { rating: int }
    }
  }
  storage primary { type: postgres }
  resource partiesState { for: Parties, kind: state, use: primary }
  deployable api { platform: ${platform} contexts: [Parties] dataSources: [partiesState] port: ${port} }
}`;

  it("emits a .NET polymorphic reader: abstract Party base + delegating PartyRepository", async () => {
    const { files } = generateSystems(await parseValid(TPC_TWO_CONCRETE("dotnet", 5000)));
    const get = (suffix: string) =>
      [...files.entries()].find(([p]) => p.endsWith(suffix))?.[1] ?? "";
    // Concrete subtypes emit as standalone entities/tables.
    expect([...files.keys()].some((p) => p.endsWith("Domain/Customers/Customer.cs"))).toBe(true);
    expect([...files.keys()].some((p) => p.endsWith("Domain/Suppliers/Supplier.cs"))).toBe(true);
    // The abstract base emits an abstract C# class carrying the shared fields,
    // and the concretes inherit it instead of re-declaring them.
    const party = get("Domain/Parties/Party.cs");
    expect(party).toMatch(/public abstract class Party/);
    expect(party).toMatch(/public string Name \{ get; internal set; \}/);
    const customer = get("Domain/Customers/Customer.cs");
    expect(customer).toMatch(/public sealed class Customer : Party/);
    // The inherited base field is NOT re-declared as a mutable entity property
    // on the concrete (would shadow → CS0108).  (The nested `State` hydration
    // carrier still lists it as `{ get; init; }`, which is expected.)
    expect(customer).not.toMatch(/public string Name \{ get; (private|internal) set;/);
    // The own field IS declared on the concrete.
    expect(customer).toMatch(/public decimal CreditLimit \{ get; private set;/);
    // The base keeps no Id of its own (identity stays per-concrete).
    expect([...files.keys()].some((p) => p.endsWith("Domain/Ids/PartyId.cs"))).toBe(false);
    // Read-only polymorphic reader: interface + delegating impl.
    expect(get("Domain/Parties/IPartyRepository.cs")).toMatch(
      /Task<IReadOnlyList<Party>> FindAllAsync/,
    );
    const reader = get("Infrastructure/Repositories/PartyRepository.cs");
    expect(reader).toMatch(/public sealed class PartyRepository : IPartyRepository/);
    expect(reader).toMatch(/ICustomerRepository/);
    expect(reader).toMatch(/ISupplierRepository/);
    expect(reader).toMatch(/result\.AddRange\(await _customerRepo\.All\(cancellationToken\)\)/);
    expect(reader).not.toMatch(/SaveAsync/);
    // EF excludes the base from the model so each concrete maps standalone.
    expect(get("Infrastructure/Persistence/AppDbContext.cs")).toMatch(
      /modelBuilder\.Ignore<Party>\(\);/,
    );
    // No Party table/DbSet leaks.
    expect(get("Infrastructure/Persistence/AppDbContext.cs")).not.toMatch(/DbSet<Party>/);
  });

  it("emits Ecto schemas for the TPC concretes on the vanilla foundation", async () => {
    const { files } = generateSystems(await parseValid(TPC_TWO_CONCRETE("elixir", 4000)));
    const paths = [...files.keys()];
    // Concrete subtypes emit Ecto schemas, each carrying the merged base fields.
    expect(paths.some((p) => p.endsWith("parties/customer.ex"))).toBe(true);
    expect(paths.some((p) => p.endsWith("parties/supplier.ex"))).toBe(true);
    // The context façade delegates the per-aggregate reads to each Repository.
    // The auto `list` is paged-by-default (M-T2.6), so the delegate carries the
    // page/page_size/sort/dir controls (with defaults).
    const domain = [...files.entries()].find(([p]) => p.endsWith("/parties.ex"))?.[1] ?? "";
    expect(domain).toMatch(
      /defdelegate list_customers\(page \\\\ 1, page_size \\\\ 20, sort \\\\ "id", dir \\\\ "asc"\), to: Api\.Parties\.CustomerRepository/,
    );
    expect(domain).toMatch(
      /defdelegate list_suppliers\(page \\\\ 1, page_size \\\\ 20, sort \\\\ "id", dir \\\\ "asc"\), to: Api\.Parties\.SupplierRepository/,
    );
  });
});

describe("aggregate inheritance — sharedTable/TPH emission on Hono (I2)", () => {
  const codes = (es: { code?: string | number }[]) =>
    es.map((e) => e.code).filter((c): c is string => typeof c === "string");

  const TPH = `
system Sys {
  subdomain Parties {
    context Parties {
      abstract aggregate Party inheritanceUsing(sharedTable) { name: string email: string }
      aggregate Customer extends Party { creditLimit: decimal }
      aggregate Supplier extends Party { taxId: string }
    }
  }
  storage primary { type: postgres }
  resource partiesState { for: Parties, kind: state, use: primary }
  deployable api { platform: node contexts: [Parties] dataSources: [partiesState] port: 3000 }
}`;

  it("does not gate a TPH hierarchy hosted by a Hono backend", async () => {
    const diags = validateLoomModel(enrichLoomModel(lowerModel(await parseValid(TPH))));
    expect(diags.filter((d) => d.severity === "error" && /TPH/.test(d.message))).toEqual([]);
  });

  it("does not gate a TPH hierarchy hosted by a .NET backend", async () => {
    // .NET ships TPH via EF Core `HasDiscriminator` (aggregate-inheritance.md I2).
    const ON_DOTNET = TPH.replace("platform: node", "platform: dotnet").replace(
      "port: 3000",
      "port: 5000",
    );
    const diags = validateLoomModel(enrichLoomModel(lowerModel(await parseValid(ON_DOTNET))));
    expect(diags.filter((d) => d.severity === "error" && /TPH/.test(d.message))).toEqual([]);
  });

  it("does not gate a TPH hierarchy hosted by a Phoenix backend", async () => {
    // Phoenix ships TPH via Ash shared-table multi-resource + base_filter on
    // `kind` (aggregate-inheritance.md I2).  All three DB backends now support
    // TPH, so the gate has no triggering host left.
    const ON_PHOENIX = TPH.replace("platform: node", "platform: elixir").replace(
      "port: 3000",
      "port: 5000",
    );
    const diags = validateLoomModel(enrichLoomModel(lowerModel(await parseValid(ON_PHOENIX))));
    expect(diags.filter((d) => d.severity === "error" && /TPH/.test(d.message))).toEqual([]);
  });

  it("emits ONE shared table with a `kind` discriminator + nullable concrete columns", async () => {
    const { files } = generateSystems(await parseValid(TPH));
    const schema = files.get("api/db/schema.ts") ?? "";
    // One shared `parties` table; no per-concrete tables.
    expect(schema).toMatch(/\.table\("parties"/);
    expect(schema).not.toMatch(/\.table\("customers"/);
    expect(schema).not.toMatch(/\.table\("suppliers"/);
    // Discriminator + base columns not-null, concrete columns nullable.
    expect(schema).toMatch(/kind: text\("kind"\)\.notNull\(\)/);
    expect(schema).toMatch(/name: text\("name"\)\.notNull\(\)/);
    expect(schema).toMatch(/creditLimit: numeric\("credit_limit"\),/); // no .notNull()
    expect(schema).toMatch(/taxId: text\("tax_id"\),/); // no .notNull()
  });

  it("targets the shared table, filtering and stamping `kind`, in each concrete repo", async () => {
    const { files } = generateSystems(await parseValid(TPH));
    const repo = files.get("api/db/repositories/customer-repository.ts") ?? "";
    // Reads/writes go to the shared `parties` table…
    expect(repo).toMatch(/from\(schema\.parties\)/);
    expect(repo).toMatch(/insert\(schema\.parties\)/);
    // …filtered by this concrete's `kind` on reads…
    expect(repo).toMatch(/eq\(schema\.parties\.kind, "Customer"\)/);
    // …and stamped with `kind` on writes.
    expect(repo).toMatch(/kind: "Customer"/);
    // Nullable shared columns are asserted non-null on hydrate (kind filter
    // guarantees presence) so the domain `_create` stays strictly typed.
    expect(repo).toMatch(/Number\(root\.creditLimit!\)/);
  });

  it("mounts only concrete routers; the abstract base has no HTTP routes/mount", async () => {
    const { files } = generateSystems(await parseValid(TPH));
    const paths = [...files.keys()];
    expect(paths).toContain("api/http/customer.routes.ts");
    expect(paths).toContain("api/http/supplier.routes.ts");
    // The abstract base is never instantiated → no routes file, no mount. (It
    // DOES get a read-only base reader + union — covered by the base-reader
    // test below — but those are read-side data plumbing, not HTTP surface.)
    expect(paths.some((p) => /party\.routes/i.test(p))).toBe(false);
    const idx = files.get("api/http/index.ts") ?? "";
    expect(idx).toMatch(/app\.route\("\/api\/customers"/);
    expect(idx).not.toMatch(/app\.route\("\/api\/parties"/);
  });

  it("emits a matching shared-table migration (no per-concrete tables)", async () => {
    const { files } = generateSystems(await parseValid(TPH));
    const sql = [...files.entries()].find(([p]) => /db\/migrations\/.*\.sql$/.test(p))?.[1] ?? "";
    // The Parties context lands in its own `parties` Postgres schema.
    expect(sql).toMatch(/CREATE TABLE "parties"\."parties" \(/);
    expect(sql).toMatch(/"kind" TEXT NOT NULL/);
    expect(sql).toMatch(/"credit_limit" DECIMAL NULL/);
    expect(sql).toMatch(/"tax_id" TEXT NULL/);
    expect(sql).not.toMatch(/CREATE TABLE customers/);
    expect(sql).not.toMatch(/CREATE TABLE suppliers/);
  });

  it("allows a polymorphic 'Party id' ref under TPH (single shared table)", async () => {
    const { errors } = await parse(`
      context T {
        abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
        aggregate Customer extends Party { creditLimit: decimal }
        aggregate Order { buyer: Party id }
      }
    `);
    expect(codes(errors)).not.toContain("loom.polymorphic-id-ref-unsupported");
  });

  it("emits a polymorphic base reader: <Base> union + read-only <Base>Repository", async () => {
    const { files } = generateSystems(await parseValid(TPH));
    // The abstract base's discriminated-union type.
    const union = files.get("api/domain/party.ts") ?? "";
    expect(union).toMatch(/export type Party = Customer \| Supplier;/);
    // A read-only repository that scans the shared table and dispatches on kind.
    const reader = files.get("api/db/repositories/party-repository.ts") ?? "";
    expect(reader).toMatch(/export class PartyRepository/);
    expect(reader).toMatch(/async findById\(id: Ids\.PartyId\): Promise<Party \| null>/);
    expect(reader).toMatch(/async findAll\(\): Promise<Party\[\]>/);
    expect(reader).toMatch(/from\(schema\.parties\)/);
    expect(reader).toMatch(/switch \(row\.kind\)/);
    expect(reader).toMatch(/case "Customer":/);
    expect(reader).toMatch(/case "Supplier":/);
  });

  it("rejects a polymorphic 'Party id' ref to an ownTable (TPC) base (ambiguous FK)", async () => {
    const { errors } = await parse(`
      context T {
        abstract aggregate Party inheritanceUsing(ownTable) { name: string }
        aggregate Customer extends Party inheritanceUsing(ownTable) { creditLimit: decimal }
        aggregate Order { buyer: Party id }
      }
    `);
    expect(codes(errors)).toContain("loom.polymorphic-id-ref-unsupported");
  });

  it("rejects a polymorphic 'Party id' ref to a MIXED hierarchy (sharedTable base + ownTable override)", async () => {
    // LegacyVendor overrides to ownTable, so it lives in its own table outside
    // the shared one the base reader scans — a `Party id` would silently miss
    // it.  The diagnostic names the offending sibling.
    const { errors } = await parse(`
      context T {
        abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
        aggregate Customer extends Party { creditLimit: decimal }
        aggregate LegacyVendor extends Party inheritanceUsing(ownTable) { obscure: string }
        aggregate Order { buyer: Party id }
      }
    `);
    expect(codes(errors)).toContain("loom.polymorphic-id-ref-mixed-strategy");
    expect(errors.some((e) => /LegacyVendor/.test(e.message ?? ""))).toBe(true);
    // It's the mixed case specifically, not the all-ownTable case.
    expect(codes(errors)).not.toContain("loom.polymorphic-id-ref-unsupported");
  });

  it("allows a polymorphic 'Party id' ref when every concrete is sharedTable", async () => {
    const { errors } = await parse(`
      context T {
        abstract aggregate Party inheritanceUsing(sharedTable) { name: string }
        aggregate Customer extends Party { creditLimit: decimal }
        aggregate Supplier extends Party inheritanceUsing(sharedTable) { taxId: string }
        aggregate Order { buyer: Party id }
      }
    `);
    expect(codes(errors)).not.toContain("loom.polymorphic-id-ref-mixed-strategy");
    expect(codes(errors)).not.toContain("loom.polymorphic-id-ref-unsupported");
  });

  it("emits a contained part on a TPH concrete as a table FK'd to the SHARED base (Pattern 4)", async () => {
    const SRC = `
system Sys {
  subdomain Parties {
    context Parties {
      abstract aggregate Party inheritanceUsing(sharedTable) { name: string email: string }
      aggregate Customer extends Party {
        creditLimit: decimal
        contains addresses: Address[]
        entity Address { street: string city: string }
      }
      aggregate Supplier extends Party { taxId: string }
    }
  }
  storage primary { type: postgres }
  resource partiesState { for: Parties, kind: state, use: primary }
  deployable api { platform: node contexts: [Parties] dataSources: [partiesState] port: 3000 }
}`;
    const { files } = generateSystems(await parseValid(SRC));
    const schema = files.get("api/db/schema.ts") ?? "";
    // The part gets its own table…
    expect(schema).toMatch(/\.table\("addresses"/);
    // …whose parent FK targets the SHARED base table (`party_id`), NOT a
    // non-existent `customer_id`.  The base has a guid id, so the FK is uuid
    // (lockstep with the migration's idColumnType).
    expect(schema).toMatch(/parentId: uuid\("party_id"\)/);
    expect(schema).not.toMatch(/text\("customer_id"\)/);
    // The repo loads/saves the part keyed on parentId (= the shared row id).
    const repo = files.get("api/db/repositories/customer-repository.ts") ?? "";
    expect(repo).toMatch(/from\(schema\.addresses\).+parentId/s);
    // The migration FKs `addresses` to the shared `parties` table.
    const sql = [...files.entries()].find(([p]) => /db\/migrations\/.*\.sql$/.test(p))?.[1] ?? "";
    expect(sql).toMatch(/CREATE TABLE "parties"\."addresses"/);
    expect(sql).toMatch(/FOREIGN KEY \("party_id"\) REFERENCES "parties"\."parties"/);
  });
});
