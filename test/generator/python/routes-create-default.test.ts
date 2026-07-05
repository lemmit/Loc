import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// Regression (RS-6): a create field with an explicit declared default must
// carry that default in the Pydantic create request model — not the type's
// zero value. The bool case hardcoded `= False`, so `active: bool = true`
// omitted on create arrived `False` (a cross-backend parity break vs node's
// `z.coerce.boolean().default(true)`; surfaced by the python behavioral tier).

const SRC = `
system S {
  subdomain Sales {
    context Sales {
      aggregate Customer with crudish {
        name: string
        active: bool = true
        invariant name.length > 0
      }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource s { for: Sales, kind: state, use: pg }
  deployable api { platform: python  contexts: [Sales]  dataSources: [s]  serves: SalesApi  port: 8000 }
}`;

describe("python create request model — declared field default", () => {
  it("uses the declared bool default, not the zero value", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateSystems(model).files;
    const routes = files.get("api/app/http/customer_routes.py") ?? "";
    expect(routes, "customer_routes.py should be emitted").not.toBe("");
    // Scope to the Create request class body (up to its Response sibling) so
    // the assertion can't drift into the Update model (which defaults False on
    // every backend, node included).
    const start = routes.indexOf("class CreateCustomerRequest");
    const block = routes.slice(start, routes.indexOf("class CreateCustomerResponse", start));
    // The declared default (True) must be the create default — omitting
    // `active` yields True.
    expect(block).toMatch(/active: bool = True/);
    expect(block, "create model must not fall back to the bool zero value").not.toMatch(
      /active: bool = False/,
    );
  });
});
