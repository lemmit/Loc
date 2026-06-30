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
    expect(c).toContain('new Route("get", "/api/orders", "OrderListResponse", new int[] {})');
  });

  it("retargets a `T[]` find + a shorthand view to the list wrapper", async () => {
    const c = await customizer();
    expect(c).toContain(
      'new Route("get", "/api/orders/active", "OrderListResponse", new int[] {})',
    );
    expect(c).toContain(
      'new Route("get", "/api/views/confirmed_orders", "OrderListResponse", new int[] {})',
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
    expect(c).toContain('new Route("post", "/api/orders", null, new int[] {400, 422})');
  });

  it("getById → 404; destroy → 404, 409", async () => {
    const c = await customizer();
    expect(c).toContain('new Route("get", "/api/orders/{id}", null, new int[] {404})');
    expect(c).toContain('new Route("delete", "/api/orders/{id}", null, new int[] {404, 409})');
  });

  it("plain operation → 400, 404, 422; a guarded operation adds 403", async () => {
    const c = await customizer();
    expect(c).toContain(
      'new Route("post", "/api/orders/{id}/confirm", null, new int[] {400, 404, 422})',
    );
    expect(c).toContain(
      'new Route("post", "/api/orders/{id}/archive", null, new int[] {400, 403, 404, 422})',
    );
  });

  it("a guarded workflow → 400, 403, 422", async () => {
    const c = await customizer();
    expect(c).toContain(
      'new Route("post", "/api/workflows/place_order", null, new int[] {400, 403, 422})',
    );
  });

  it("an optional find → 404", async () => {
    const c = await customizer();
    expect(c).toContain('new Route("get", "/api/orders/by_code", null, new int[] {404})');
  });
});
