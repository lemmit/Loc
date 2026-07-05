import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// Regression: an operation whose param is a cross-aggregate `X id` emits
// `XId(...)` in the FastAPI route, so the route must import `XId`. The import
// collector used to draw only from the aggregate's own name + fields, so an id
// reached via an operation param (or a contained-entity field) was referenced
// but never imported → `NameError` at runtime (surfaced by the python
// behavioral tier; the route collector now draws from every context aggregate).

const SRC = `
system S {
  subdomain Sales {
    context Sales {
      aggregate Product with crudish { sku: string  invariant sku.length > 0 }
      aggregate Order with crudish {
        note: string
        operation attach(productId: Product id) {
          note := "attached"
        }
      }
      repository Products for Product { }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource s { for: Sales, kind: state, use: pg }
  deployable api { platform: python  contexts: [Sales]  dataSources: [s]  serves: SalesApi  port: 8000 }
}`;

describe("python routes — cross-aggregate operation-param id import", () => {
  it("imports the foreign id type referenced only through an operation param", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateSystems(model).files;
    const routes = files.get("api/app/http/order_routes.py");
    expect(routes, "order_routes.py should be emitted").toBeDefined();
    // The op body wraps the param as ProductId(...) — that reference must be imported.
    expect(routes).toMatch(/ProductId\(/);
    expect(routes, "ProductId referenced but not imported (NameError at runtime)").toMatch(
      /from app\.domain\.ids import[^\n]*\bProductId\b/,
    );
  });
});
