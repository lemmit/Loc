import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { generateSystems } from "../../../src/system/index.js";
import { buildWireSpec } from "../../../src/system/wire-spec.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Wire-spec conformance for the Hono backend.
//
// `buildWireSpec(sys)` is Loom's canonical IR-derived wire contract — every
// backend must surface every aggregate / part / value-object name from it.
// The Phoenix side is asserted in
// `test/generator/elixir/elixir-pipeline.test.ts:1198`; this
// block asserts the same for Hono's emitted route + DTO schemas.
//
// Fast (no docker, no boot) — complements the OpenAPI-parity e2e test in
// `test/e2e/e2e.test.ts` which compares live `/openapi.json` from running
// backends.
// ---------------------------------------------------------------------------

const HONO_FIXTURE = `system AcmeHono {
  subdomain Sales {
    context Sales {
      enum OrderStatus { Draft, Confirmed }
      valueobject Money {
        amount: decimal
        currency: string
        invariant amount >= 0
      }
      event OrderConfirmed { order: Order id, at: datetime }
      aggregate Customer {
        name: string
        derived display: string = name
        email: string
        invariant email.length > 0
      }
      aggregate Order {
        customerId: Customer id
        status: OrderStatus
        contains lines: OrderLine[]
        entity OrderLine {
          productId: Customer id
          quantity: int
          unitPrice: Money
          invariant quantity > 0
        }
        operation confirm() {
          precondition status == Draft
          status := Confirmed
          emit OrderConfirmed { order: id, at: now() }
        }
      }
      repository Customers for Customer { }
      repository Orders for Order { }
      workflow placeOrder {
      create(customerId: Customer id) {
        let order = Order.create({ customerId: customerId, status: Draft })
      }
    }
    }
  }
  api SalesApi from Sales
  deployable honoApi {
    platform: node
    contexts: [Sales]
    serves: SalesApi
    port: 3000
  }
}
`;

async function buildHonoModel() {
  const { model, errors } = await parseString(HONO_FIXTURE);
  if (errors.length) {
    throw new Error(`Hono wire-conformance fixture has validation errors:\n${errors.join("\n")}`);
  }
  return model;
}

describe("cross-platform wire-spec conformance (hono vs wire-spec.json)", () => {
  it("Hono routes files exist for every aggregate served by the api", async () => {
    const model = await buildHonoModel();
    const { files } = generateSystems(model);
    expect(files.has("hono_api/http/customer.routes.ts")).toBe(true);
    expect(files.has("hono_api/http/order.routes.ts")).toBe(true);
  });

  it("Every aggregate from wire-spec.json appears as <Name>Response in the Hono source", async () => {
    const model = await buildHonoModel();
    const sys = enrichLoomModel(lowerModel(model)).systems[0]!;
    const wireSpec = buildWireSpec(sys);
    const { files } = generateSystems(model);
    const httpSource = [...files.entries()]
      .filter(([k]) => /^hono_api\/http\//.test(k))
      .map(([, v]) => v)
      .join("\n");
    for (const aggName of Object.keys(wireSpec.aggregates)) {
      expect(httpSource).toContain(`${aggName}Response`);
    }
  });

  it("Every value object from wire-spec.json appears as a Zod schema in the Hono source", async () => {
    const model = await buildHonoModel();
    const sys = enrichLoomModel(lowerModel(model)).systems[0]!;
    const wireSpec = buildWireSpec(sys);
    const { files } = generateSystems(model);
    const httpSource = [...files.entries()]
      .filter(([k]) => /^hono_api\/http\//.test(k))
      .map(([, v]) => v)
      .join("\n");
    for (const voName of Object.keys(wireSpec.valueObjects)) {
      expect(httpSource).toContain(voName);
    }
  });

  it("Every entity-part from wire-spec.json appears as <Name>Response in the Hono source", async () => {
    const model = await buildHonoModel();
    const sys = enrichLoomModel(lowerModel(model)).systems[0]!;
    const wireSpec = buildWireSpec(sys);
    const { files } = generateSystems(model);
    const httpSource = [...files.entries()]
      .filter(([k]) => /^hono_api\/http\//.test(k))
      .map(([, v]) => v)
      .join("\n");
    for (const partName of Object.keys(wireSpec.parts)) {
      expect(httpSource).toContain(`${partName}Response`);
    }
  });

  it("CustomerResponse Zod schema includes every declared field from wire-spec", async () => {
    const model = await buildHonoModel();
    const sys = enrichLoomModel(lowerModel(model)).systems[0]!;
    const wireSpec = buildWireSpec(sys);
    const { files } = generateSystems(model);
    const customerRoutes = files.get("hono_api/http/customer.routes.ts");
    expect(customerRoutes, "customer.routes.ts must be emitted").toBeDefined();
    // Locate the CustomerResponse block specifically — ends at the
    // matching .openapi("CustomerResponse") attachment, distinct from
    // CustomerListResponse / CreateCustomerResponse.
    const responseBlock =
      customerRoutes!.match(
        /const CustomerResponse =[\s\S]*?\.openapi\("CustomerResponse"\)/,
      )?.[0] ?? "";
    expect(responseBlock, "CustomerResponse block must be located").not.toEqual("");
    // Match the Zod property declaration `<name>:` at a word boundary so a
    // renamed field (e.g. `renamed_name:`) doesn't satisfy the check by
    // happening to contain the original name as a substring.
    for (const fieldName of Object.keys(wireSpec.aggregates.Customer!.properties)) {
      const propPattern = new RegExp(`(?<![a-zA-Z0-9_])${fieldName}:`);
      expect(responseBlock, `field ${fieldName} present as Zod prop in CustomerResponse`).toMatch(
        propPattern,
      );
    }
  });
});
