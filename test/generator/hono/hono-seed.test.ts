import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// A context with an aggregate covering the field kinds a seed renders:
// string, int, enum (bare ref), and a value-object field (BuilderCall →
// `new Money(...)`).  Two datasets: `default` (always) + `demo` (LOOM_SEED).
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
    platform: node
    contexts: [Catalog]
    serves: ShopApi
    port: 3000
  }
}
`;

async function build(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function find(
  files: Map<string, string>,
  re: RegExp,
  also: (k: string) => boolean = () => true,
): string {
  for (const [k, v] of files) if (re.test(k) && also(k)) return v;
  throw new Error(`no file matched ${re}`);
}

describe("Hono database seeding (Phase 2, domain path)", () => {
  it("emits db/seed.ts going through the domain create + repository save", async () => {
    const files = await build();
    const seed = find(files, /\/db\/seed\.ts$/);

    // Through the domain create (D-SEED-PATH), not a raw insert.
    expect(seed).toContain("new ProductRepository(db, NoopDomainEventDispatcher)");
    expect(seed).toContain(
      'Product.create({ sku: "BASE-1", price: new Money(1.0, "USD"), tier: Tier.Free, stock: 1 })',
    );
    expect(seed).toContain(
      'Product.create({ sku: "DEMO-1", price: new Money(9.99, "USD"), tier: Tier.Pro, stock: 10 })',
    );
    expect(seed).toContain("await productRepo.save(");

    // Imports resolved to the real generated modules.
    expect(seed).toContain('import { Product } from "../domain/product"');
    expect(seed).toContain('import { ProductRepository } from "./repositories/product-repository"');
    expect(seed).toContain('import { NoopDomainEventDispatcher } from "../domain/events"');
    expect(seed).toContain('import { Money, Tier } from "../domain/value-objects"');
  });

  it("coerces a bare object literal in a value-object field into a VO ctor, gap-filling skipped optionals", async () => {
    // The seed grammar allows the unprefixed object form (`addr: { line1: … }`)
    // for a value-object-typed create field.  It must lower to a VO ctor, not
    // a plain object (which isn't assignable to the VO class), and an omitted
    // optional field (`line2`) fills with `null` so the positional ctor args
    // stay aligned.
    const src = `system AddrSeed {
      subdomain S { context C {
        valueobject Address {
          line1: string
          line2: string?
          city: string
        }
        aggregate Place with crudish {
          name: string
          addr: Address
        }
        repository Places for Place { }
        seed default {
          Place { name: "HQ", addr: { line1: "1 Main St", city: "Springfield" } }
        }
      }}
      api A from S
      deployable api { platform: node contexts: [C] serves: A port: 3000 }
    }`;
    const { model, errors } = await parseString(src);
    if (errors.length) throw new Error(errors.join("\n"));
    const seed = find(generateSystems(model).files, /\/db\/seed\.ts$/);
    // line2 (optional, omitted) fills with null, in declared field order.
    expect(seed).toContain('addr: new Address("1 Main St", null, "Springfield")');
    expect(seed).not.toMatch(/addr:\s*\(?\{ line1:/);
  });

  it("coerces a datetime-typed seed literal with new Date(...)", async () => {
    // `Product.create` takes `createdAt: Date`; a bare string literal fails
    // `tsc --strict`, so the seed wraps datetime-typed literals in a Date ctor.
    const src = `system S {
      subdomain Shop {
        context C {
          aggregate Event with crudish {
            title: string
            startsAt: datetime
            endsAt: datetime?
          }
          repository Events for Event { }
          seed default {
            Event { title: "Kickoff", startsAt: "2024-01-01T00:00:00Z", endsAt: "2024-01-02T00:00:00Z" }
          }
        }
      }
      api A from Shop
      deployable api { platform: node contexts: [C] serves: A port: 3000 }
    }`;
    const { model, errors } = await parseString(src);
    if (errors.length) throw new Error(errors.join("\n"));
    const seed = find(generateSystems(model).files, /\/db\/seed\.ts$/);
    expect(seed).toContain('startsAt: new Date("2024-01-01T00:00:00Z")');
    // Optional datetimes coerce too (the create param is `Date | null`).
    expect(seed).toContain('endsAt: new Date("2024-01-02T00:00:00Z")');
    // Non-datetime strings stay plain literals.
    expect(seed).toContain('title: "Kickoff"');
  });

  it("is ship-once per dataset via the __loom_seed marker (D-SEED-IDEMPOTENCY)", async () => {
    const files = await build();
    const seed = find(files, /\/db\/seed\.ts$/);
    expect(seed).toContain('CREATE TABLE IF NOT EXISTS "__loom_seed"');
    expect(seed).toContain("if (await alreadySeeded(db,");
    expect(seed).toContain("await markSeeded(db,");
  });

  it("gates non-default datasets on LOOM_SEED; default always runs", async () => {
    const files = await build();
    const seed = find(files, /\/db\/seed\.ts$/);
    expect(seed).toContain("process.env.LOOM_SEED");
    expect(seed).toContain('return dataset === "default" || requested.has(dataset);');
    expect(seed).toContain("async function seedDefault(");
    expect(seed).toContain("async function seedDemo(");
  });

  it("wires the seeder into package.json and index.ts boot", async () => {
    const files = await build();
    const pkg = JSON.parse(find(files, /\/package\.json$/));
    expect(pkg.scripts["db:seed"]).toBe("tsx db/seed-cli.ts");

    // The project-root index.ts (not http/index.ts).
    const index = find(files, /(^|\/)index\.ts$/, (k) => !/\/http\//.test(k));
    expect(index).toContain('import { runSeeds } from "./db/seed"');
    expect(index).toContain("await runSeeds(db);");
    // Seeding runs after migrations.
    expect(index.indexOf("await migrate(")).toBeLessThan(index.indexOf("await runSeeds("));
  });

  it("keeps db/seed.ts a pure module — the CLI entry lives in db/seed-cli.ts", async () => {
    // A run-directly guard INSIDE the importable module misfires once tsup
    // bundles seed.ts into dist/index.js (there `import.meta.url` IS the
    // entrypoint), seeding at module load BEFORE the top-level migrate —
    // first boot then dies on `relation ... does not exist` (caught live by
    // conformance-parity).  The self-executing entry must stay in its own,
    // never-imported file.
    const files = await build();
    const seed = find(files, /\/db\/seed\.ts$/);
    expect(seed).not.toContain("import.meta.url");
    expect(seed).not.toContain("void main()");
    const cli = find(files, /\/db\/seed-cli\.ts$/);
    expect(cli).toContain('import { runSeeds } from "./seed"');
    expect(cli).toContain("void main();");
  });

  it("omits seed wiring entirely when no seed block is declared", async () => {
    const noSeed = FIXTURE.replace(/seed default \{[\s\S]*?\n {6}\}\n/, "").replace(
      /seed demo \{[\s\S]*?\n {6}\}\n/,
      "",
    );
    const { model, errors } = await parseString(noSeed);
    if (errors.length) throw new Error(errors.join("\n"));
    const files = generateSystems(model).files;
    for (const k of files.keys()) expect(k).not.toMatch(/\/db\/seed\.ts$/);
    const pkg = JSON.parse(find(files, /\/package\.json$/));
    expect(pkg.scripts["db:seed"]).toBeUndefined();
  });
});

describe("Hono seeding — raw explicit-id path", () => {
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
    deployable api { platform: node contexts: [Sales] serves: A port: 3000 }
  }`;

  it("emits direct INSERTs via db.execute(sql.raw(...)) with explicit id + FK", async () => {
    const { model, errors } = await parseString(RAW);
    if (errors.length) throw new Error(errors.join("\n"));
    const seed = find(generateSystems(model).files, /\/db\/seed\.ts$/);
    expect(seed).toContain(
      'db.execute(sql.raw("INSERT INTO \\"customers\\" (\\"id\\", \\"name\\") VALUES (\'c1\', \'Acme\')"))',
    );
    expect(seed).toContain('INSERT INTO \\"orders\\" (\\"id\\", \\"customer_id\\", \\"status\\")');
    expect(seed).not.toContain("Customer.create(");
  });
});
