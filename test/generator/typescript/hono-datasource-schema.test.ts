// dataSource.schema + dataSource.tablePrefix → Drizzle pgSchema /
// table factory routing.
//
// Mirrors test/generator/dotnet/dotnet-datasource-schema.test.ts on
// the Hono backend: `dataSource X { for: <ctx>, kind: state, use:
// <pg>, schema: "sales" }` declares `const sales =
// pgSchema("sales");` at the top of `db/schema.ts` and routes
// the aggregate's table through `sales.table("orders", { … })`.
//
// `schema` is the Postgres-schema namespace (i.e. `SET search_path TO
// <name>`) — useful for sub-domain separation, mapping into a legacy
// database that already lives in a non-`public` schema, isolating a
// read-side replica, etc.  Compile-time per-aggregate routing only;
// runtime tenant resolution is a separate feature outside this slice.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const baseSystem = (dataSourceClauses: string, dataSourceNames: string) => `
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
  ${dataSourceClauses}
  deployable api {
    platform: hono
    contexts: [Orders]
    dataSources: [${dataSourceNames}]
    port: 3000
  }
}
`;

async function generate(src: string): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(src))).files;
}

function schemaFile(files: Map<string, string>): string {
  const path = [...files.keys()].find((k) => k.endsWith("/db/schema.ts"));
  expect(path, "db/schema.ts not emitted").toBeDefined();
  return files.get(path!)!;
}

describe("dataSource → Drizzle pgSchema (Hono)", () => {
  it("emits the legacy plain pgTable shape when no schema / tablePrefix is set", async () => {
    const files = await generate(
      baseSystem(
        `dataSource ordersState { for: Orders, kind: state, use: primary }`,
        "ordersState",
      ),
    );
    const s = schemaFile(files);
    expect(s).toContain(`export const orders = pgTable("orders", {`);
    expect(s).toContain(`export const lines = pgTable("lines", {`);
    // No pgSchema declaration.
    expect(s).not.toMatch(/pgSchema\("/);
  });

  it("declares pgSchema and routes tables through <schema>.table when `schema:` is set", async () => {
    const files = await generate(
      baseSystem(
        `dataSource ordersState { for: Orders, kind: state, use: primary, schema: "sales" }`,
        "ordersState",
      ),
    );
    const s = schemaFile(files);
    expect(s).toContain(`export const sales = pgSchema("sales");`);
    expect(s).toContain(`export const orders = sales.table("orders", {`);
    // Containment part inherits the same schema.
    expect(s).toContain(`export const lines = sales.table("lines", {`);
    // No plain pgTable for the aggregate (audit / provenance tables
    // don't fire in this fixture).
    expect(s).not.toContain(`export const orders = pgTable`);
  });

  it("prepends `tablePrefix` to the local table name (no schema)", async () => {
    const files = await generate(
      baseSystem(
        `dataSource ordersState { for: Orders, kind: state, use: primary, tablePrefix: "sales_" }`,
        "ordersState",
      ),
    );
    const s = schemaFile(files);
    expect(s).toContain(`export const orders = pgTable("sales_orders", {`);
    expect(s).toContain(`export const lines = pgTable("sales_lines", {`);
    expect(s).not.toMatch(/pgSchema\("/);
  });

  it("combines schema + tablePrefix when both are set", async () => {
    const files = await generate(
      baseSystem(
        `dataSource ordersState { for: Orders, kind: state, use: primary, schema: "legacy", tablePrefix: "sales_" }`,
        "ordersState",
      ),
    );
    const s = schemaFile(files);
    expect(s).toContain(`export const legacy = pgSchema("legacy");`);
    expect(s).toContain(`export const orders = legacy.table("sales_orders", {`);
    expect(s).toContain(`export const lines = legacy.table("sales_lines", {`);
  });
});
