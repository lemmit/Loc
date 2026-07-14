// ---------------------------------------------------------------------------
// Java backend — springdoc OpenApiCustomizer (OpenApiContractCustomizer).
//
// springdoc infers routes correctly but emits a spec that diverges from the
// other four backends in two ways the route return types can't express:
//   1. success bodies under `*/*` (so the parity normalizer, reading
//      application/json, classifies a list GET as `object` not `array`), and
//   2. zero RFC 7807 error responses.
// The customizer is the .NET document-filter analog: a data-driven @Bean that
// promotes list GETs to named <Agg>ListResponse array wrappers under
// application/json and declares the per-op ProblemDetails error responses —
// statuses sourced from the SHARED src/ir/util/openapi-errors.ts matrix so the
// sets match every other backend.  These tests pin the emitted route table.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Shop {
  subdomain Sales {
    context Orders {
      enum Status { pending, confirmed }
      aggregate Order {
        code: string
        status: Status
        total: money
        create(code: string, status: Status, total: money) {
          code := code
          status := status
          total := total
        }
        operation confirm() {
          precondition status == pending
          status := confirmed
        }
        operation archive() {
          requires currentUser.permissions.length > 0
          status := confirmed
        }
        destroy()
      }
      repository Orders for Order {
        find byCode(code: string): Order? where this.code == code
        find active(): Order[] where this.status == confirmed
      }
      view confirmed_orders = Order where status == confirmed
      workflow placeOrder {
        create(code: string) {
          requires currentUser.permissions.length > 0
          precondition code.length > 0
        }
      }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  user { provider: oidc }
  deployable shopApi {
    platform: java
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 8081
  }
}
`;

const ROOT = "shop_api/src/main/java/com/loom/shopapi";
const PATH = `${ROOT}/config/OpenApiContractCustomizer.java`;

async function customizer(): Promise<string> {
  const f = await generateSystemFiles(SRC);
  const c = f.get(PATH);
  if (!c)
    throw new Error(`OpenApiContractCustomizer not emitted; got ${[...f.keys()].length} files`);
  return c;
}

describe("java OpenApiCustomizer — list/view array wrappers", () => {
  it("registers the named <Agg>ListResponse array wrapper", async () => {
    const c = await customizer();
    expect(c).toContain('new Wrapper("OrderListResponse", "OrderResponse")');
  });

  it("retargets the auto-findAll GET to its named list wrapper", async () => {
    const c = await customizer();
    // GET /<plural> → array wrapper, no error responses.
    expect(c).toContain('new Route("get", "/api/orders", "OrderListResponse", new int[] {}, null)');
  });

  it("retargets a `T[]` find + a shorthand view to the list wrapper", async () => {
    const c = await customizer();
    expect(c).toContain(
      'new Route("get", "/api/orders/active", "OrderListResponse", new int[] {}, null)',
    );
    // The view route also carries a `View`-suffixed operationId.
    expect(c).toContain(
      'new Route("get", "/api/views/confirmed_orders", "OrderListResponse", new int[] {}, "confirmed_ordersView")',
    );
  });

  it("promotes every 2xx success body onto application/json", async () => {
    const c = await customizer();
    expect(c).toContain('private static final String JSON = "application/json";');
    expect(c).toContain("normalized.addMediaType(JSON, media);");
  });
});

describe("java OpenApiCustomizer — RFC 7807 error responses", () => {
  it("emits the shared ProblemDetails component under application/problem+json", async () => {
    const c = await customizer();
    expect(c).toContain('private static final String PROBLEM_JSON = "application/problem+json";');
    expect(c).toContain('private static final String PROBLEM_SCHEMA = "ProblemDetails";');
    expect(c).toContain("components.addSchemas(PROBLEM_SCHEMA, problem);");
    // §3.2 validation-error extension array.
    expect(c).toContain('errorItem.setRequired(List.of("pointer", "message"));');
  });

  it("create → 400, 422", async () => {
    const c = await customizer();
    expect(c).toContain('new Route("post", "/api/orders", null, new int[] {400, 422}, null)');
  });

  it("getById → 404; destroy → 404, 409", async () => {
    const c = await customizer();
    expect(c).toContain('new Route("get", "/api/orders/{id}", null, new int[] {404}, null)');
    expect(c).toContain(
      'new Route("delete", "/api/orders/{id}", null, new int[] {404, 409}, null)',
    );
  });

  it("plain operation → 400, 404, 422; a guarded operation adds 403", async () => {
    const c = await customizer();
    expect(c).toContain(
      'new Route("post", "/api/orders/{id}/confirm", null, new int[] {400, 404, 422}, null)',
    );
    expect(c).toContain(
      'new Route("post", "/api/orders/{id}/archive", null, new int[] {400, 403, 404, 422}, null)',
    );
  });

  it("a guarded workflow → 400, 403, 422", async () => {
    const c = await customizer();
    expect(c).toContain(
      'new Route("post", "/api/workflows/place_order", null, new int[] {400, 403, 422}, "placeOrderWorkflow")',
    );
  });

  it("an optional find → 404", async () => {
    const c = await customizer();
    expect(c).toContain('new Route("get", "/api/orders/by_code", null, new int[] {404}, null)');
  });
});

describe("java OpenApiCustomizer — named string-enum components", () => {
  it("registers a referenced enum as a named StringSchema component", async () => {
    const c = await customizer();
    // Status is referenced by Order.status → emitted as a named component.
    expect(c).toContain('new EnumComponent("Status", List.of("pending", "confirmed"))');
    expect(c).toContain("private static void registerEnums(OpenAPI openApi) {");
    expect(c).toContain("for (String v : e.values()) schema.addEnumItem(v);");
  });

  it("retargets the enum-typed property onto the named enum $ref", async () => {
    const c = await customizer();
    // status (the unambiguous enum field) is retargeted across every schema.
    expect(c).toContain('new EnumProp("status", "Status")');
    expect(c).toContain("private static void retargetEnumProps(OpenAPI openApi) {");
    expect(c).toContain('pe.setValue(new Schema<>().$ref("#/components/schemas/" + enumName));');
  });
});

describe("java OpenApiCustomizer — empty request bodies for param-less ops", () => {
  it("names + attaches an empty-object request body per param-less public op", async () => {
    const c = await customizer();
    // confirm() and archive() take no params → named {} request body.
    expect(c).toContain('new EmptyRequest("/api/orders/{id}/confirm", "ConfirmOrderRequest")');
    expect(c).toContain('new EmptyRequest("/api/orders/{id}/archive", "ArchiveOrderRequest")');
    expect(c).toContain("private static void attachEmptyRequests(OpenAPI openApi) {");
    expect(c).toContain("op.setRequestBody(new RequestBody().content(content));");
  });
});

describe("java OpenApiCustomizer — required-field sets", () => {
  it("marks a response's non-optional fields required (id always present)", async () => {
    const c = await customizer();
    expect(c).toContain(
      'new RequiredSet("OrderResponse", List.of("code", "id", "status", "total"))',
    );
    expect(c).toContain("private static void applyRequired(OpenAPI openApi) {");
    expect(c).toContain("schema.setRequired(List.copyOf(r.fields()));");
  });

  it("marks a create request's required-input fields, and `{ id }` on the response", async () => {
    const c = await customizer();
    expect(c).toContain(
      'new RequiredSet("CreateOrderRequest", List.of("code", "status", "total"))',
    );
    expect(c).toContain('new RequiredSet("CreateOrderResponse", List.of("id"))');
  });

  it("marks a workflow command request's required params", async () => {
    const c = await customizer();
    expect(c).toContain('new RequiredSet("PlaceOrderRequest", List.of("code"))');
  });
});

describe("java OpenApiCustomizer — ProblemDetails.status integer type", () => {
  it("emits status as a typed IntegerSchema so the spec serializes type: integer", async () => {
    const c = await customizer();
    // The bare Schema<>().type("integer") doesn't serialize a `type` in this
    // swagger-models version; the IntegerSchema subclass does.
    expect(c).toContain("import io.swagger.v3.oas.models.media.IntegerSchema;");
    expect(c).toContain('problem.addProperty("status", new IntegerSchema().format("int32"));');
  });
});

describe("java OpenApiCustomizer — operationId overrides", () => {
  it("suffixes a workflow command operationId with `Workflow`", async () => {
    const c = await customizer();
    // placeOrder workflow → registerProject-style suffix.
    expect(c).toContain('"placeOrderWorkflow"');
    expect(c).toContain("if (route.operationId() != null) op.setOperationId(route.operationId());");
  });

  it("suffixes a view operationId with `View`", async () => {
    const c = await customizer();
    expect(c).toContain('"confirmed_ordersView"');
  });

  it("leaves aggregate-op routes with a null operationId (springdoc default matches node)", async () => {
    const c = await customizer();
    // The rename/confirm aggregate ops carry no operationId override.
    expect(c).toContain(
      'new Route("post", "/api/orders/{id}/confirm", null, new int[] {400, 404, 422}, null)',
    );
  });
});
