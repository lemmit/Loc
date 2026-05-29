// dataSource.schema + dataSource.tablePrefix → AshPostgres `postgres
// do … end` block.
//
// Mirrors the sibling dotnet + hono PRs on the third backend: a
// `dataSource X { for: <ctx>, kind: state, use: <pg>, schema:
// "sales" }` clause makes every aggregate's Ash.Resource module
// declare `schema "sales"` inside its `postgres do … end` block.
// `tablePrefix` prepends the local table name.
//
// `schema` is the Postgres-schema namespace (i.e. `SET search_path
// TO <name>`).  Useful for sub-domain separation, mapping into a
// legacy database that already lives in a non-`public` schema, etc.
// Compile-time per-aggregate routing only; runtime tenant resolution
// is a separate feature outside this slice.

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
  ui WebApp {}
  deployable api {
    platform: phoenixLiveView
    contexts: [Orders]
    dataSources: [ordersState]
    ui: WebApp
    port: 4000
  }
}
`;

async function generate(src: string): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(src))).files;
}

function resourceFor(files: Map<string, string>, basename: string): string {
  const path = [...files.keys()].find((k) => k.endsWith(`/orders/${basename}`));
  expect(path, `${basename} not emitted`).toBeDefined();
  return files.get(path!)!;
}

describe("dataSource → AshPostgres postgres do block (Phoenix)", () => {
  it("defaults schema to snake(context.name) when DSL omits `schema:`", async () => {
    const files = await generate(
      baseSystem(`dataSource ordersState { for: Orders, kind: state, use: primary }`),
    );
    const r = resourceFor(files, "order.ex");
    expect(r).toContain(`table "orders"`);
    expect(r).toContain(`repo`);
    // Implicit default — context Orders → schema "orders".
    expect(r).toContain(`schema "orders"`);
    // Containment part inherits the same default.
    const line = resourceFor(files, "line.ex");
    expect(line).toContain(`table "lines"`);
    expect(line).toContain(`schema "orders"`);
  });

  it("threads explicit `schema:` into the postgres block", async () => {
    const files = await generate(
      baseSystem(
        `dataSource ordersState { for: Orders, kind: state, use: primary, schema: "sales" }`,
      ),
    );
    const r = resourceFor(files, "order.ex");
    expect(r).toContain(`table "orders"`);
    expect(r).toContain(`schema "sales"`);
    // Containment part inherits the same schema.
    const line = resourceFor(files, "line.ex");
    expect(line).toContain(`table "lines"`);
    expect(line).toContain(`schema "sales"`);
  });

  it("prepends `tablePrefix` and keeps the default ctx schema", async () => {
    const files = await generate(
      baseSystem(
        `dataSource ordersState { for: Orders, kind: state, use: primary, tablePrefix: "sales_" }`,
      ),
    );
    const r = resourceFor(files, "order.ex");
    expect(r).toContain(`table "sales_orders"`);
    expect(r).toContain(`schema "orders"`);
    const line = resourceFor(files, "line.ex");
    expect(line).toContain(`table "sales_lines"`);
    expect(line).toContain(`schema "orders"`);
  });

  it("combines schema + tablePrefix when both are set", async () => {
    const files = await generate(
      baseSystem(
        `dataSource ordersState { for: Orders, kind: state, use: primary, schema: "legacy", tablePrefix: "sales_" }`,
      ),
    );
    const r = resourceFor(files, "order.ex");
    expect(r).toContain(`table "sales_orders"`);
    expect(r).toContain(`schema "legacy"`);
    const line = resourceFor(files, "line.ex");
    expect(line).toContain(`table "sales_lines"`);
    expect(line).toContain(`schema "legacy"`);
  });
});
