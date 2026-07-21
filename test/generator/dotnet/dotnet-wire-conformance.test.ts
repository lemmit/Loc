import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { generateSystems } from "../../../src/system/index.js";
import { buildWireSpec } from "../../../src/system/wire-spec.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Wire-spec conformance for the .NET backend.
//
// `buildWireSpec(sys)` is Loom's canonical IR-derived wire contract — every
// backend must surface every aggregate / part / value-object name from it.
// The Phoenix side is asserted in
// `test/generator/elixir/elixir-pipeline.test.ts:1198`; this
// block asserts the same for the .NET CQRS DTO records.
//
// Fast (no docker, no boot) — complements the OpenAPI-parity e2e test in
// `test/e2e/e2e.test.ts` which compares live `/openapi.json` from running
// backends.
// ---------------------------------------------------------------------------

const DOTNET_FIXTURE = `system AcmeDotnet {
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
  deployable dotnetApi {
    platform: dotnet
    contexts: [Sales]
    serves: SalesApi
    port: 8080
  }
}
`;

async function buildDotnetModel() {
  const { model, errors } = await parseString(DOTNET_FIXTURE);
  if (errors.length) {
    throw new Error(`.NET wire-conformance fixture has validation errors:\n${errors.join("\n")}`);
  }
  return model;
}

describe("cross-platform wire-spec conformance (dotnet vs wire-spec.json)", () => {
  it(".NET DTO files exist for every aggregate served by the api", async () => {
    const model = await buildDotnetModel();
    const { files } = generateSystems(model);
    expect(files.has("dotnet_api/Application/Customers/Responses/CustomerResponses.cs")).toBe(true);
    expect(files.has("dotnet_api/Application/Customers/Requests/CustomerRequests.cs")).toBe(true);
    expect(files.has("dotnet_api/Application/Orders/Responses/OrderResponses.cs")).toBe(true);
    expect(files.has("dotnet_api/Application/Orders/Requests/OrderRequests.cs")).toBe(true);
  });

  it("Every aggregate from wire-spec.json appears as <Name>Response in the .NET source", async () => {
    const model = await buildDotnetModel();
    const sys = enrichLoomModel(lowerModel(model)).systems[0]!;
    const wireSpec = buildWireSpec(sys);
    const { files } = generateSystems(model);
    const dtoSource = [...files.entries()]
      .filter(([k]) => /^dotnet_api\/Application\/.*\/(Requests|Responses)\//.test(k))
      .map(([, v]) => v)
      .join("\n");
    for (const aggName of Object.keys(wireSpec.aggregates)) {
      expect(dtoSource).toContain(`${aggName}Response`);
    }
  });

  it("Every value object from wire-spec.json appears as a record in the .NET source", async () => {
    const model = await buildDotnetModel();
    const sys = enrichLoomModel(lowerModel(model)).systems[0]!;
    const wireSpec = buildWireSpec(sys);
    const { files } = generateSystems(model);
    const dtoSource = [...files.entries()]
      .filter(([k]) => /^dotnet_api\/Application\/.*\/(Requests|Responses)\//.test(k))
      .map(([, v]) => v)
      .join("\n");
    for (const voName of Object.keys(wireSpec.valueObjects)) {
      // .NET emits <VO>Request + <VO>Response variants; bare name
      // appears as a prefix in both.
      expect(dtoSource).toContain(voName);
    }
  });

  it("Every entity-part from wire-spec.json appears as <Name>Response in the .NET source", async () => {
    const model = await buildDotnetModel();
    const sys = enrichLoomModel(lowerModel(model)).systems[0]!;
    const wireSpec = buildWireSpec(sys);
    const { files } = generateSystems(model);
    const dtoSource = [...files.entries()]
      .filter(([k]) => /^dotnet_api\/Application\/.*\/Responses\//.test(k))
      .map(([, v]) => v)
      .join("\n");
    for (const partName of Object.keys(wireSpec.parts)) {
      expect(dtoSource).toContain(`${partName}Response`);
    }
  });

  it("CustomerResponse record includes every declared field from wire-spec", async () => {
    const model = await buildDotnetModel();
    const sys = enrichLoomModel(lowerModel(model)).systems[0]!;
    const wireSpec = buildWireSpec(sys);
    const { files } = generateSystems(model);
    const customerResponses = files.get(
      "dotnet_api/Application/Customers/Responses/CustomerResponses.cs",
    );
    expect(customerResponses, "CustomerResponses.cs must be emitted").toBeDefined();
    // .NET emits records as one-liners: `public sealed record CustomerResponse(...);`.
    const responseBlock =
      customerResponses!.match(/public sealed record CustomerResponse\([^)]*\);/)?.[0] ?? "";
    expect(responseBlock, "CustomerResponse record must be located").not.toEqual("");
    // .NET upper-cases parameter names via upperFirst; wire-spec uses
    // camelCase. Check for the Pascal form at a word boundary so a
    // renamed param (e.g. `RenamedName`) doesn't satisfy the check by
    // happening to end with the original name.
    for (const fieldName of Object.keys(wireSpec.aggregates.Customer!.properties)) {
      const pascal = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
      const paramPattern = new RegExp(`(?<![a-zA-Z0-9_])${pascal}(?![a-zA-Z0-9_])`);
      expect(responseBlock, `field ${pascal} present in CustomerResponse`).toMatch(paramPattern);
    }
  });
});
