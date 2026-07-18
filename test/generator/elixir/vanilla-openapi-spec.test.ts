import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// OpenAPI spec on the vanilla (plain Ecto/Phoenix) foundation — gap §11f.
//
// The other four backends auto-serve `/openapi.json` (framework-generated);
// the vanilla Phoenix backend has no auto-gen, so the spec is built explicitly
// from the IR via `OpenApiSpex` (a foundation-agnostic Phoenix library — NOT
// Ash).  Without it, `GET /openapi.json` 404s and Phoenix can't join the
// 5-backend conformance-parity diff.
//
// This pins the emitted surface:
//   - the per-Api spec module           (lib/<app>_web/api/<api>_spec.ex)
//   - a per-aggregate schema module      (lib/<app>_web/api/schemas/<name>.ex)
//   - the OpenapiController              (.../controllers/openapi_controller.ex)
//   - the `open_api_spex` hex dep        (mix.exs)
//   - the ROOT `/openapi.json` route     (router.ex — NOT under /api)
// ---------------------------------------------------------------------------

const SOURCE = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order {
        code: string
        region: string
      }
      repository Orders for Order {
        find recent(): Order[]
      }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla OpenAPI spec (§11f)", () => {
  it("emits the per-Api OpenApiSpex spec module", async () => {
    const files = await generateSystemFiles(SOURCE);
    const specKey = [...files.keys()].find((k) => k.endsWith("_spec.ex") && k.includes("/api/"));
    expect(specKey, "spec module not emitted").toBeDefined();
    const spec = files.get(specKey!)!;
    expect(spec).toContain("alias OpenApiSpex.{Info, OpenApi, Server}");
    expect(spec).toContain("@behaviour OpenApi");
    expect(spec).toContain("def spec do");
    expect(spec).toContain("%OpenApi{");
    expect(spec).toContain("OpenApiSpex.resolve_schema_modules()");
  });

  it("emits a per-aggregate schema module", async () => {
    const files = await generateSystemFiles(SOURCE);
    const schema = file(files, "/api/schemas/order_response.ex");
    expect(schema).toContain("OpenApiSpex.schema(%{");
  });

  it("emits the OpenapiController serving the spec as JSON", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "/controllers/openapi_controller.ex");
    expect(ctrl).toContain("defmodule");
    expect(ctrl).toContain(".OpenapiController do");
    expect(ctrl).toContain("def index(conn, _params) do");
    expect(ctrl).toContain('put_resp_content_type("application/json")');
    expect(ctrl).toContain(".spec()");
  });

  it("adds the open_api_spex hex dep to mix.exs", async () => {
    const mix = file(await generateSystemFiles(SOURCE), "mix.exs");
    expect(mix).toContain('{:open_api_spex, "~> 3.0"}');
  });

  it("routes GET /openapi.json at the router ROOT (not under /api)", async () => {
    const router = file(await generateSystemFiles(SOURCE), "/router.ex");
    // The spec endpoint must be a root route, served by the OpenapiController.
    expect(router).toMatch(/get "\/openapi\.json", \w+Web\.OpenapiController, :index/);
    // And it must NOT sit inside the `scope "/api"` block.
    const apiScopeIdx = router.indexOf('scope "/api"');
    const openapiIdx = router.indexOf("/openapi.json");
    expect(openapiIdx).toBeGreaterThanOrEqual(0);
    expect(openapiIdx).toBeLessThan(apiScopeIdx);
  });
});

describe("vanilla OpenAPI spec — operation-return unions", () => {
  it("answers 200 with the tagged union DTO (not 204) and registers the schema", async () => {
    // `operation reserve(): Order or NotFound` — the exception-less union
    // 200 (exception-less.md), matching Hono's discriminatedUnion / .NET's
    // Application union DTO (surfaced by showcase's reserve op as
    // `schemas only on node: ['ProjectOrProjectNotFound']` in parity).
    const src = `
system Shop {
  subdomain Sales {
    context Orders {
      error NotFound { resource: string }
      aggregate Order {
        code: string
        operation reserve(): Order or NotFound {
          return NotFound { resource: code }
        }
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}`;
    const files = await generateSystemFiles(src);
    const specKey = [...files.keys()].find((k) => k.endsWith("_spec.ex") && k.includes("/api/"));
    const spec = files.get(specKey!)!;
    const start = spec.indexOf('"/orders/{id}/reserve"');
    expect(start, "reserve path present").toBeGreaterThanOrEqual(0);
    const reserve = spec.slice(start, start + 1200);
    expect(reserve).toContain("200 => %OpenApiSpex.Response{");
    expect(reserve).toContain("Schemas.OrderOrNotFound");
    expect(reserve).not.toContain("204 =>");
    const union = file(files, "order_or_not_found.ex");
    expect(union).toContain('title: "OrderOrNotFound"');
    expect(union).toContain("oneOf: [");
    expect(union).toContain('type: %OpenApiSpex.Schema{type: :string, enum: ["Order"]}');
    expect(union).toContain('type: %OpenApiSpex.Schema{type: :string, enum: ["NotFound"]}');
  });

  it("uppercases the module alias when the success arm is a PRIMITIVE (B11)", async () => {
    // `operation reject(): string or NotFound` — the union's first variant is the
    // PRIMITIVE `string`, so `unionInstanceName` is the lower-camel `stringOrNotFound`.
    // That is a valid class name on the other backends but NOT a valid Elixir module
    // alias — `defmodule …Schemas.stringOrNotFound` fails to compile.  The emitter
    // must uppercase the alias (`StringOrNotFound`) while keeping the wire `type`
    // discriminator tag `string` (lowercase — from `variantTag`) unchanged.
    const src = `
system Shop {
  subdomain Sales {
    context Orders {
      error NotFound { resource: string }
      aggregate Order {
        code: string
        operation reject(): string or NotFound {
          return NotFound { resource: code }
        }
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}`;
    const files = await generateSystemFiles(src);
    // The schema module + the response reference are the uppercase-first alias …
    const union = file(files, "string_or_not_found.ex");
    expect(union).toContain("defmodule");
    expect(union).toContain(".Api.Schemas.StringOrNotFound do");
    expect(union).toContain('title: "StringOrNotFound"');
    // … and NEVER the lower-camel form (which would be an invalid Elixir alias).
    expect(union).not.toContain("Schemas.stringOrNotFound");
    const specKey = [...files.keys()].find((k) => k.endsWith("_spec.ex") && k.includes("/api/"));
    const spec = files.get(specKey!)!;
    expect(spec).toContain("Schemas.StringOrNotFound");
    expect(spec).not.toContain("Schemas.stringOrNotFound");
    // The success variant's wire discriminator stays the lowercase primitive tag …
    expect(union).toContain('type: %OpenApiSpex.Schema{type: :string, enum: ["string"]}');
    // … and the scalar arm carries its `value` (no record fields for a primitive).
    expect(union).toContain("value:");
    expect(union).toContain('type: %OpenApiSpex.Schema{type: :string, enum: ["NotFound"]}');
  });
});

describe("vanilla OpenAPI spec — union finds", () => {
  it("declares the absent variant's ProblemDetails status on a union find", async () => {
    // `find locate(...): Order or OrderNotFound` — absence translates to the
    // error variant's mapped status (the api block's `httpStatus` override,
    // as showcase.ddd maps ProjectNotFound), same as Hono's union-find route
    // and Java's customizer; 200 stays <Agg>Response.
    const src = `
system Shop {
  subdomain Sales {
    context Orders {
      error OrderNotFound { }
      aggregate Order { code: string }
      repository Orders for Order {
        find locate(code: string): Order or OrderNotFound where this.code == code
      }
    }
  }
  api OrdersApi from Sales {
    httpStatus OrderNotFound -> 404
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}`;
    const files = await generateSystemFiles(src);
    const specKey = [...files.keys()].find((k) => k.endsWith("_spec.ex") && k.includes("/api/"));
    const spec = files.get(specKey!)!;
    const start = spec.indexOf('"/orders/locate"');
    expect(start, "locate path present").toBeGreaterThanOrEqual(0);
    const locate = spec.slice(start, start + 1200);
    expect(locate).toContain("Schemas.OrderResponse");
    expect(locate).toContain("404 => %OpenApiSpex.Response{");
    expect(locate).toContain("Schemas.ProblemDetails");
  });
});

// ---------------------------------------------------------------------------
// Observable-workflow instance surface in the spec — the router already
// serves GET /workflows/<slug>/instances[/{id}] (workflow-instances-emit.ts);
// the spec must declare them + the <Wf>Instance[List]Response schemas, or
// the parity diff reports the paths/schemas as only-on-node.
// ---------------------------------------------------------------------------

const SAGA_SOURCE = `
system S {
  subdomain O {
    context O {
      aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id } } }
      repository Orders for Order { }
      aggregate Shipment { orderRef: Order id  status: string  operation mark() { status := "T" } }
      repository Shipments for Shipment { }
      event OrderPlaced { order: Order id }
      event ShipmentRequested { shipment: Shipment id, order: Order id }
      channel L { carries: OrderPlaced, ShipmentRequested  delivery: broadcast  retention: ephemeral }
      workflow OrderFulfillment { orderId: Order id  attempts: int
        create(p: OrderPlaced) by p.order { let s = Shipment.create({ orderRef: p.order, status: "P" }) emit ShipmentRequested { shipment: s.id, order: p.order } }
        on(s: ShipmentRequested) by s.order { let sh = Shipments.getById(s.shipment) sh.mark() } }
    }
  }
  api A from O
  storage pg { type: postgres }
  resource oState { for: O, kind: state, use: pg }
  deployable api { platform: elixir contexts: [O] dataSources: [oState] serves: A port: 4000 }
}
`;

describe("vanilla OpenAPI spec — workflow instance routes", () => {
  it("declares the instance list + byId paths with the shared operationIds", async () => {
    const files = await generateSystemFiles(SAGA_SOURCE);
    const specKey = [...files.keys()].find((k) => k.endsWith("_spec.ex") && k.includes("/api/"));
    const spec = files.get(specKey!)!;
    expect(spec).toContain('"/workflows/order_fulfillment/instances" => %OpenApiSpex.PathItem{');
    expect(spec).toContain('operationId: "allOrderFulfillmentInstances"');
    expect(spec).toContain(
      '"/workflows/order_fulfillment/instances/{id}" => %OpenApiSpex.PathItem{',
    );
    expect(spec).toContain('operationId: "getOrderFulfillmentInstanceById"');
    // Correlation-id param carries the uuid format every backend declares.
    expect(spec).toContain(
      "%OpenApiSpex.Parameter{name: :id, in: :path, required: true, schema: %OpenApiSpex.Schema{type: :string, format: :uuid}}",
    );
    // byId declares the shared 404 ProblemDetails.
    expect(spec).toMatch(/instances\/\{id\}[\s\S]*?404 => %OpenApiSpex\.Response\{/);
  });

  it("emits the <Wf>InstanceResponse + named list-carrier schema modules", async () => {
    const files = await generateSystemFiles(SAGA_SOURCE);
    const resp = file(files, "order_fulfillment_instance_response.ex");
    expect(resp).toContain('title: "OrderFulfillmentInstanceResponse"');
    // Required = every non-optional wire field (matches Hono/Python/.NET/Java).
    expect(resp).toContain("required: [:orderId, :attempts]");
    const listResp = file(files, "order_fulfillment_instance_list_response.ex");
    expect(listResp).toContain('title: "OrderFulfillmentInstanceListResponse"');
    expect(listResp).toContain("type: :array");
    expect(listResp).toContain("items: ");
    expect(listResp).toContain("OrderFulfillmentInstanceResponse");
  });
});
