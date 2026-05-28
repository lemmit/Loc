// dataSource.schema + dataSource.tablePrefix → EF Core ToTable args.
//
// Proves the storage-and-platform-config promise on the .NET backend:
// `dataSource X { for: <ctx>, kind: state, use: <pg>, schema: "tenant_a" }`
// produces `b.ToTable("orders", "tenant_a")` in the per-aggregate
// Configuration.cs (with `tablePrefix` prepending the local table
// name).  Verifies byte-identical default behavior when no schema /
// prefix is set.

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

describe("dataSource → EF Core ToTable (.NET)", () => {
  it("emits a single-arg ToTable when the dataSource has no schema / tablePrefix", async () => {
    const files = await generate(
      baseSystem(`dataSource ordersState { for: Orders, kind: state, use: primary }`),
    );
    const cfg = configFor(files);
    // No schema / prefix → byte-identical with pre-dataSource output.
    expect(cfg).toContain(`b.ToTable("orders");`);
    // Containment part picks up the same shape.
    expect(cfg).toContain(`o.ToTable("lines");`);
  });

  it("threads `schema` into the second arg of ToTable", async () => {
    const files = await generate(
      baseSystem(
        `dataSource ordersState { for: Orders, kind: state, use: primary, schema: "tenant_a" }`,
      ),
    );
    const cfg = configFor(files);
    expect(cfg).toContain(`b.ToTable("orders", "tenant_a");`);
    // Containment parts live in the same schema as their owner.
    expect(cfg).toContain(`o.ToTable("lines", "tenant_a");`);
  });

  it("prepends `tablePrefix` to the local table name", async () => {
    const files = await generate(
      baseSystem(
        `dataSource ordersState { for: Orders, kind: state, use: primary, tablePrefix: "tenant_a_" }`,
      ),
    );
    const cfg = configFor(files);
    expect(cfg).toContain(`b.ToTable("tenant_a_orders");`);
    expect(cfg).toContain(`o.ToTable("tenant_a_lines");`);
  });

  it("combines schema and tablePrefix when both are set", async () => {
    const files = await generate(
      baseSystem(
        `dataSource ordersState { for: Orders, kind: state, use: primary, schema: "shared", tablePrefix: "tenant_a_" }`,
      ),
    );
    const cfg = configFor(files);
    expect(cfg).toContain(`b.ToTable("tenant_a_orders", "shared");`);
    expect(cfg).toContain(`o.ToTable("tenant_a_lines", "shared");`);
  });
});
