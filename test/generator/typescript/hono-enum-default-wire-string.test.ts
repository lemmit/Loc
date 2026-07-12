// Regression: an enum-typed create field with a default must render its
// zod `.default(...)` as the wire STRING, not the runtime enum const.
//
// A create-request field with `= <enumValue>` lowers to an enum-value
// default expression.  `renderTsExpr` renders that as `<Enum>.<Value>` —
// correct for domain code, which imports the enum const, but WRONG inside
// the route file's zod schema: the route imports the value-object runtime
// classes but not the enum consts (enums travel as strings on the wire),
// so `<Enum>.<Value>` is undefined at bundle time ("SalesOrderStatus is
// not defined").  The wire form is the value name as a string literal,
// which is both in scope and what `z.enum([...]).default(...)` expects.
// Mirrors the Acme ERP `SalesOrder.status: SalesOrderStatus = Draft`.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  system Sys {
    subdomain Sales {
      context Sales {
        enum OrderStatus { Draft, Confirmed, Cancelled }
        aggregate Order {
          reference: string
          status: OrderStatus = Draft
        }
        repository Orders for Order {}
      }
    }
    storage primary { type: postgres }
    deployable api {
      platform: node
      contexts: [Sales]
      port: 3000
    }
  }
`;

async function routesFile(): Promise<string> {
  const files = (await generateSystems(await parseValid(SRC))).files;
  const path = [...files.keys()].find((k) => k.endsWith("/http/order.routes.ts"));
  expect(path, "order.routes.ts not emitted").toBeDefined();
  return files.get(path!)!;
}

describe("Hono routes — enum field default renders as a wire string", () => {
  it("uses the wire string in .default(), not the runtime enum const", async () => {
    const routes = await routesFile();
    expect(routes).toContain(`OrderStatusSchema.default("Draft")`);
    // The bare enum const must NOT be referenced — it isn't imported here.
    expect(routes).not.toContain("OrderStatus.Draft");
  });
});
