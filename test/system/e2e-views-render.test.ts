import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/parse.js";

// A context-level `view X = Agg where …` is served as a parameterless GET under
// `${apiBasePath}/views/<view_snake>`.  `api.views.<name>()` in a `test e2e`
// body must render to a `__get` of that route — the renderer mirror of the
// validator's `views` pseudo-aggregate branch (test-checks.ts).  Without this,
// generation aborted with "unknown aggregate 'api.views'".

const SRC = `
  system Viewing {
    subdomain Sales {
      context Orders {
        aggregate Order with crudish {
          code: string
          total: int
        }
        repository Orders for Order { }
        view BigOrders = Order where total >= 1000
      }
    }
    api OrdersApi from Sales
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable d {
      platform: node
      contexts: [Orders]
      dataSources: [ordersState]
      serves: OrdersApi
      port: 4000
    }

    test e2e "view reads project the subset" against d {
      api.orders.create({ code: "BIG", total: 1500 })
      let bigs = api.views.bigOrders()
      expect(bigs.length).toBe(1)
    }
  }
`;

describe("e2e render — api.views.<name>() reads a view route", () => {
  it("renders api.views.bigOrders() to a GET on the view route", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const { files } = generateSystems(model);
    const e2e = [...files.entries()].find(([k]) => k.endsWith(".e2e.test.ts"));
    expect(e2e).toBeDefined();
    const [, body] = e2e!;
    // The view read hits the mounted `${apiBasePath}/views/<snake>` route, not
    // the aggregate's `/orders/...` prefix.
    expect(body).toContain("/api/views/big_orders");
    // It is a bare GET (views are parameterless), not a query-string find.
    expect(body).toMatch(/__get\(`\$\{base\}\/api\/views\/big_orders`\)/);
  });
});
