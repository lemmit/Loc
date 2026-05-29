// dataSource.schema + dataSource.tablePrefix → Drizzle pgSchema /
// table factory routing.
//
// Mirrors test/generator/dotnet/dotnet-datasource-schema.test.ts on
// the Hono backend: `resource X { for: <ctx>, kind: state, use:
// <pg>, schema: "sales" }` declares `const salesSchema =
// pgSchema("sales");` at the top of `db/schema.ts` and routes
// the aggregate's table through `salesSchema.table("orders", { … })`.
//
// `schema` is the Postgres-schema namespace (i.e. `SET search_path TO
// <name>`).  Default when DSL omits `schema:`: `snake(context.name)`
// — every bounded context lands in its own Postgres schema out of the
// box.  Explicit `schema: "..."` overrides for legacy-database
// mapping.  Compile-time per-aggregate routing only; runtime tenant
// resolution is a separate feature outside this slice.

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

describe("resource → Drizzle pgSchema (Hono)", () => {
  it("defaults schema to snake(context.name) when DSL omits `schema:`", async () => {
    const files = await generate(
      baseSystem(`resource ordersState { for: Orders, kind: state, use: primary }`, "ordersState"),
    );
    const s = schemaFile(files);
    // Implicit default — context Orders → schema "orders".
    expect(s).toContain(`export const ordersSchema = pgSchema("orders");`);
    expect(s).toContain(`export const orders = ordersSchema.table("orders", {`);
    expect(s).toContain(`export const lines = ordersSchema.table("lines", {`);
  });

  it("declares pgSchema and routes tables through <schema>.table when `schema:` is set", async () => {
    const files = await generate(
      baseSystem(
        `resource ordersState { for: Orders, kind: state, use: primary, schema: "sales" }`,
        "ordersState",
      ),
    );
    const s = schemaFile(files);
    expect(s).toContain(`export const salesSchema = pgSchema("sales");`);
    expect(s).toContain(`export const orders = salesSchema.table("orders", {`);
    // Containment part inherits the same schema.
    expect(s).toContain(`export const lines = salesSchema.table("lines", {`);
    // No plain pgTable for the aggregate (audit / provenance tables
    // don't fire in this fixture).
    expect(s).not.toContain(`export const orders = pgTable`);
  });

  it("prepends `tablePrefix` to the local table name (schema still defaults to ctx)", async () => {
    const files = await generate(
      baseSystem(
        `resource ordersState { for: Orders, kind: state, use: primary, tablePrefix: "sales_" }`,
        "ordersState",
      ),
    );
    const s = schemaFile(files);
    // tablePrefix prepends to the local table name; schema still
    // defaults to the context name.
    expect(s).toContain(`export const ordersSchema = pgSchema("orders");`);
    expect(s).toContain(`export const orders = ordersSchema.table("sales_orders", {`);
    expect(s).toContain(`export const lines = ordersSchema.table("sales_lines", {`);
  });

  it("combines explicit schema + tablePrefix when both are set", async () => {
    const files = await generate(
      baseSystem(
        `resource ordersState { for: Orders, kind: state, use: primary, schema: "legacy", tablePrefix: "sales_" }`,
        "ordersState",
      ),
    );
    const s = schemaFile(files);
    expect(s).toContain(`export const legacySchema = pgSchema("legacy");`);
    expect(s).toContain(`export const orders = legacySchema.table("sales_orders", {`);
    expect(s).toContain(`export const lines = legacySchema.table("sales_lines", {`);
  });
});
