// dataSource.schema + dataSource.tablePrefix → EF Core ToTable args.
//
// Proves the storage-and-platform-config promise on the .NET backend:
// `resource X { for: <ctx>, kind: state, use: <pg>, schema: "sales" }`
// produces `builder.ToTable("orders", "sales")` in the per-aggregate
// Configuration.cs (with `tablePrefix` prepending the local table
// name).  Verifies byte-identical default behavior when no schema /
// prefix is set.
//
// `schema` is the Postgres-schema namespace (i.e. `SET search_path TO
// <name>`) — useful for sub-domain separation, mapping into a legacy
// database that already lives in a non-`public` schema, isolating a
// read-side replica, etc.  Compile-time per-aggregate routing only;
// runtime tenant resolution is a separate feature outside this slice.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const baseSystem = (dataSourceClause: string) => `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order {
        name: string
        contains lines: Line[]
        entity Line {
          sku: string
        }
      }
      repository Orders for Order {}
    }
  }
  storage primary { type: postgres }
  ${dataSourceClause}
  deployable api {
    platform: dotnet
    contexts: [Orders]
    dataSources: [ordersState]
    port: 5000
  }
}
`;

async function generate(src: string): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(src))).files;
}

function configFor(files: Map<string, string>): string {
  const path = [...files.keys()].find((k) =>
    k.endsWith("Infrastructure/Persistence/Configurations/OrderConfiguration.cs"),
  );
  expect(path, "OrderConfiguration.cs not emitted").toBeDefined();
  return files.get(path!)!;
}

describe("resource → EF Core ToTable (.NET)", () => {
  it("defaults schema to snake(context.name) when DSL omits `schema:`", async () => {
    const files = await generate(
      baseSystem(`resource ordersState { for: Orders, kind: state, use: primary }`),
    );
    const cfg = configFor(files);
    // Implicit default — context Orders → schema "orders".
    expect(cfg).toContain(`builder.ToTable("orders", "orders");`);
    expect(cfg).toContain(`o.ToTable("lines", "orders");`);
  });

  it("threads explicit `schema:` into the second arg of ToTable", async () => {
    const files = await generate(
      baseSystem(
        `resource ordersState { for: Orders, kind: state, use: primary, schema: "sales" }`,
      ),
    );
    const cfg = configFor(files);
    expect(cfg).toContain(`builder.ToTable("orders", "sales");`);
    // Containment parts live in the same schema as their owner.
    expect(cfg).toContain(`o.ToTable("lines", "sales");`);
  });

  it("prepends `tablePrefix` and keeps the default ctx schema", async () => {
    const files = await generate(
      baseSystem(
        `resource ordersState { for: Orders, kind: state, use: primary, tablePrefix: "sales_" }`,
      ),
    );
    const cfg = configFor(files);
    // tablePrefix prepends; schema stays defaulted to ctx name.
    expect(cfg).toContain(`builder.ToTable("sales_orders", "orders");`);
    expect(cfg).toContain(`o.ToTable("sales_lines", "orders");`);
  });

  it("combines explicit schema + tablePrefix when both are set", async () => {
    const files = await generate(
      baseSystem(
        `resource ordersState { for: Orders, kind: state, use: primary, schema: "legacy", tablePrefix: "sales_" }`,
      ),
    );
    const cfg = configFor(files);
    expect(cfg).toContain(`builder.ToTable("sales_orders", "legacy");`);
    expect(cfg).toContain(`o.ToTable("sales_lines", "legacy");`);
  });
});

// B2 — the TPH base owns the shared table's `ToTable`; it must carry the same
// context schema the migration + concrete configs use, else EF inserts into an
// unqualified `vehicles` while the migration created `fleet.vehicles`.
describe("TPH base config is schema-qualified (.NET, B2)", () => {
  const tphSystem = `
system Fleet {
  subdomain D {
    context Fleet {
      abstract aggregate Vehicle { name: string }
      aggregate Car extends Vehicle with crudish { doors: int }
      repository Cars for Car {}
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Fleet, kind: state, use: primary }
  deployable d { platform: dotnet  contexts: [Fleet]  dataSources: [st]  serves: A  port: 4000 }
}
`;

  it("qualifies the shared-table ToTable with the context schema", async () => {
    const files = await generate(tphSystem);
    const path = [...files.keys()].find((k) =>
      k.endsWith("Configurations/VehicleConfiguration.cs"),
    )!;
    expect(path, "VehicleConfiguration.cs not emitted").toBeDefined();
    // Context Fleet → schema "fleet"; the base owns the shared `vehicles` table.
    expect(files.get(path)!).toContain(`builder.ToTable("vehicles", "fleet");`);
  });
});

// B4 — an inline value-object array (`Money[]`) maps to a child table.  The
// owned-collection `ToTable` must be schema-qualified, and the positional
// `ordinal` key is assigned by the shared value generator (EF has no positional
// key for a table-mapped owned collection).
describe("value-object array child table (.NET, B4)", () => {
  const voSystem = `
system Billing {
  subdomain Sales {
    context Invoicing {
      valueobject Money { amount: decimal  currency: string }
      aggregate Invoice with crudish {
        reference: string
        lineItems: Money[]
      }
      repository Invoices for Invoice {}
    }
  }
  api A from Sales
  storage primary { type: postgres }
  resource st { for: Invoicing, kind: state, use: primary }
  deployable d { platform: dotnet  contexts: [Invoicing]  dataSources: [st]  serves: A  port: 4000 }
}
`;

  it("qualifies the child-table ToTable and wires the ordinal value generator", async () => {
    const files = await generate(voSystem);
    const cfg = files.get(
      [...files.keys()].find((k) => k.endsWith("Configurations/InvoiceConfiguration.cs"))!,
    )!;
    expect(cfg).toContain(`o.ToTable("invoice_line_items", "invoicing");`);
    expect(cfg).toContain(
      `o.Property<int>("ordinal").HasValueGenerator<OwnedCollectionOrdinalGenerator>().ValueGeneratedOnAdd();`,
    );
  });

  it("emits the OwnedCollectionOrdinalGenerator once for the project", async () => {
    const files = await generate(voSystem);
    const path = [...files.keys()].find((k) =>
      k.endsWith("Infrastructure/Persistence/OwnedCollectionOrdinalGenerator.cs"),
    );
    expect(path, "OwnedCollectionOrdinalGenerator.cs not emitted").toBeDefined();
    const gen = files.get(path!)!;
    expect(gen).toContain("class OwnedCollectionOrdinalGenerator : ValueGenerator<int>");
    // 1-based so no value equals the int default (which ValueGeneratedOnAdd omits).
    expect(gen).toContain("return idx + 1;");
  });

  it("does NOT emit the generator when no aggregate maps a VO array", async () => {
    const files = await generate(
      baseSystem(`resource ordersState { for: Orders, kind: state, use: primary }`),
    );
    const path = [...files.keys()].find((k) => k.endsWith("OwnedCollectionOrdinalGenerator.cs"));
    expect(path).toBeUndefined();
  });
});

// B3 — an embedded-shaped aggregate folds its contained parts into a JSONB
// column via `ToJson`.  EF still needs the part's strongly-typed key mapped
// (else model validation fails at boot) and its parent back-reference ignored.
describe("embedded contained part in ToJson (.NET, B3)", () => {
  const embeddedSystem = `
system Shop {
  subdomain Shopping {
    context Shopping {
      aggregate Wishlist shape: embedded {
        label: string
        contains items: WishItem[]
        create(label: string) { label := label }
        entity WishItem { sku: string }
      }
      repository Wishlists for Wishlist {}
    }
  }
  api A from Shopping
  storage primary { type: postgres }
  resource st { for: Shopping, kind: state, use: primary }
  deployable d { platform: dotnet  contexts: [Shopping]  dataSources: [st]  serves: A  port: 4000 }
}
`;

  it("maps the part key inside ToJson and ignores its parent back-reference", async () => {
    const files = await generate(embeddedSystem);
    const cfg = files.get(
      [...files.keys()].find((k) => k.endsWith("Configurations/WishlistConfiguration.cs"))!,
    )!;
    expect(cfg).toContain(`o.ToJson("items");`);
    expect(cfg).toContain(
      `o.Property(x => x.Id).HasConversion(v => v.Value, v => new WishItemId(v));`,
    );
    expect(cfg).toContain(`o.Ignore(x => x.ParentId);`);
  });
});
