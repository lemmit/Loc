// Slice A2 — Table primitive in walker stdlib.
//
// Surface:
//
//   Table(
//     rows: Sales.Order.all,
//     Column("ID", o => o.id),
//     Column("Status", o => Badge(o.status)),
//     onRowClick: o => /* … */,
//     testid: "orders-table"
//   )
//
// Lowers to a packed-table TSX block: a header row driven by the
// Column headers, a body produced by `<rowsExpr>.map((row) => …)`
// where each cell is the column's accessor lambda body walked
// with the lambda param bound to the JS identifier `row`.
//
// What this pins:
//   1. Header strings come from `Column(…)`'s first positional.
//   2. Accessor lambdas with primitive-call bodies (`o => Badge(…)`)
//      emit JSX in the cell.
//   3. Accessor lambdas with member-access bodies (`o => o.id`)
//      emit `{row.id}` in the cell.
//   4. `rows:` named arg drives the data source — any expression,
//      including a hook-eligible api ref (`Sales.Order.all`).
//   5. `testid:` lands on the root <Table>.
//   6. `onRowClick: o => …` lambdas wire to the row's onClick.

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { generateSystems } from "../src/system/index.js";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";

async function buildAndGenerate(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { parseHelper } = await import("langium/test");
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

describe("Slice A2 — Table primitive", () => {
  it("emits a Mantine table with headers, body map and member-access cells", async () => {
    const files = await buildAndGenerate(`
      system S {
        api SalesApi from Sales
        module Sales {
          context C {
            aggregate Order { customerId: string }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          api Sales: SalesApi
          page Orders {
            route: "/orders"
            body:  Table(
              rows:  Sales.Order.all,
              Column("ID",     o => o.id),
              Column("Status", o => o.customerId)
            )
          }
        }
        deployable api { platform: hono, modules: Sales, serves: SalesApi, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp { Sales: api }
          port: 3001
        }
      }
    `);
    const tsx = files.get("web/src/pages/orders.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/import \{[^}]*\bTable\b[^}]*\} from "@mantine\/core"/);
    expect(tsx).toMatch(/<Table\.Thead>/);
    expect(tsx).toMatch(/<Table\.Th>ID<\/Table\.Th>/);
    expect(tsx).toMatch(/<Table\.Th>Status<\/Table\.Th>/);
    expect(tsx).toMatch(/<Table\.Tbody>/);
    // The auto-injected hook for `Sales.Order.all` becomes a local
    // `orderAll` (or similar); we just check that some hook variable
    // is being .map'd over.
    expect(tsx).toMatch(/\.map\(\(row, idx\) => \(/);
    expect(tsx).toMatch(/<Table\.Tr key=\{ row\.id \}>/);
    expect(tsx).toMatch(/<Table\.Td>\{row\.id\}<\/Table\.Td>/);
    expect(tsx).toMatch(/<Table\.Td>\{row\.customerId\}<\/Table\.Td>/);
  });

  it("primitive-call accessor body (Badge) emits JSX in the cell", async () => {
    const files = await buildAndGenerate(`
      system S {
        api SalesApi from Sales
        module Sales {
          context C {
            aggregate Order { status: string }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          api Sales: SalesApi
          page Orders {
            route: "/orders"
            body:  Table(
              rows:  Sales.Order.all,
              Column("Status", o => Badge(o.status))
            )
          }
        }
        deployable api { platform: hono, modules: Sales, serves: SalesApi, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp { Sales: api }
          port: 3001
        }
      }
    `);
    const tsx = files.get("web/src/pages/orders.tsx")!;
    expect(tsx).toBeDefined();
    // Cell contains a <Badge> with the row's status field.
    expect(tsx).toMatch(/<Table\.Td><Badge[^>]*>\{row\.status\}<\/Badge><\/Table\.Td>/);
  });

  it("testid: lands on the root <Table>", async () => {
    const files = await buildAndGenerate(`
      system S {
        api SalesApi from Sales
        module Sales {
          context C {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          api Sales: SalesApi
          page Orders {
            route: "/orders"
            body:  Table(
              rows:  Sales.Order.all,
              Column("ID", o => o.id),
              testid: "orders-table"
            )
          }
        }
        deployable api { platform: hono, modules: Sales, serves: SalesApi, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp { Sales: api }
          port: 3001
        }
      }
    `);
    const tsx = files.get("web/src/pages/orders.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/<Table[^>]*\bdata-testid="orders-table"/);
  });

  it("Table with no Column children renders self-closing (no header / no body)", async () => {
    const files = await buildAndGenerate(`
      system S {
        api SalesApi from Sales
        module Sales {
          context C {
            aggregate Order { x: int }
            repository Orders for Order { }
          }
        }
        ui WebApp {
          api Sales: SalesApi
          page Orders {
            route: "/orders"
            body:  Table(rows: Sales.Order.all)
          }
        }
        deployable api { platform: hono, modules: Sales, serves: SalesApi, port: 3000 }
        deployable web {
          platform: static
          targets: api
          ui: WebApp { Sales: api }
          port: 3001
        }
      }
    `);
    const tsx = files.get("web/src/pages/orders.tsx")!;
    expect(tsx).toBeDefined();
    expect(tsx).toMatch(/<Table[^>]*\/>/);
    expect(tsx).not.toMatch(/<Table\.Thead>/);
  });
});
