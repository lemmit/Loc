// M-T4.8 slice 4 — the Python/FastAPI typed in-system api client.
//
// Sibling of `test/generator/typescript/api-client.test.ts`; same contract,
// Python idiom.  The properties pinned here are the ones that would silently
// break the "cannot drift from the callee" guarantee, plus the three defects
// the real toolchain (`uv sync` + ruff + `mypy --strict`) caught that no
// vitest-tier assertion would have:
//
//   1. httpx imported but never declared as a dependency,
//   2. a foreign aggregate id branded but never IMPORTED (Python names each
//      import explicitly; Hono namespace-imports `* as Ids` and so was blind),
//   3. multi-arg operation bodies serializing only the first argument.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";
import { resourceEnvUrlVar } from "../../../src/util/resource-env.js";

async function emit(src: string) {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

/** `create(orderId: <T>)` — the param type is the knob: `Order id` is the
 *  canonical cross-service shape, `string` the plain one. */
function system(paramType: string): string {
  return `
system Acme {
  subdomain Core {
    context Orders {
      aggregate Order with crudish { code: string  status: string }
      repository Orders for Order { }
    }
    context Shipping {
      aggregate Shipment with crudish { orderCode: string  status: string }
      repository Shipments for Shipment { }
      workflow fulfil {
        create(orderId: ${paramType}) {
          let o = orders.getOrderById(orderId)
          let s = Shipment.create({ orderCode: o.code, status: "Pending" })
        }
      }
    }
  }
  api OrdersApi from Core
  storage primary { type: postgres }
  resource ordersState   { for: Orders,   kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  resource orders        { for: Shipping, kind: api,   use: OrdersApi }
  deployable ordersSvc {
    platform: node   contexts: [Orders]   dataSources: [ordersState] serves: OrdersApi port: 3000
  }
  deployable shippingSvc {
    platform: python contexts: [Shipping] dataSources: [shippingState, orders] port: 3001
  }
}
`;
}

async function client(paramType = "string"): Promise<string> {
  const files = await emit(system(paramType));
  return files.get("shipping_svc/app/resources/api_clients.py") ?? "";
}

/** A callee whose find declares an ABSENCE UNION (`Order option`), plus a
 *  caller that matches on it. */
function unionSystem(): string {
  return `
system Acme {
  subdomain Core {
    context Orders {
      aggregate Order with crudish { code: string  status: string }
      repository Orders for Order {
        find byCode(code: string): Order option
      }
    }
    context Shipping {
      aggregate Shipment with crudish { orderCode: string  status: string }
      repository Shipments for Shipment { }
      workflow fulfil {
        create(code: string) {
          let o = orders.byCodeOrder(code)
          let note = match o { Order x => x.code, else => "missing" }
          let s = Shipment.create({ orderCode: note, status: "Pending" })
        }
      }
    }
  }
  api OrdersApi from Core
  storage primary { type: postgres }
  resource ordersState   { for: Orders,   kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  resource orders        { for: Shipping, kind: api,   use: OrdersApi }
  deployable ordersSvc {
    platform: node   contexts: [Orders]   dataSources: [ordersState] serves: OrdersApi port: 3000
  }
  deployable shippingSvc {
    platform: python contexts: [Shipping] dataSources: [shippingState, orders] port: 3001
  }
}
`;
}

describe("Python typed in-system api client", () => {
  it("reads its base URL from the same env seam compose injects", async () => {
    expect(await client()).toContain(`os.environ.get("${resourceEnvUrlVar("orders")}"`);
  });

  it("emits the callee's ABSOLUTE path, quoting path params", async () => {
    const src = await client();
    // `/api/...`, not the callee's router-relative fragment.
    expect(src).toContain('f"/api/orders/{quote(str(id), safe="")}"');
  });

  it("validates the response with a pydantic model of the callee's wire shape", async () => {
    const src = await client();
    expect(src).toContain("class OrderResponse(BaseModel):");
    expect(src).toMatch(/class OrderResponse\(BaseModel\):[\s\S]*code: str/);
    expect(src).toMatch(/class OrderResponse\(BaseModel\):[\s\S]*version: int/);
    // The pydantic twin of zod's `.parse` — a real runtime check, not a cast.
    expect(src).toContain("return OrderResponse.model_validate(res.json())");
  });

  it("sends EVERY body argument of a multi-arg operation", async () => {
    const src = await client();
    expect(src).toContain('json={"code": code, "status": status}');
    expect(src).toContain("async def orders_update_order(id: str, code: str, status: str)");
  });

  it("raises a status-carrying error rather than collapsing failures", async () => {
    const src = await client();
    expect(src).toContain("class RemoteCallError(Exception):");
    expect(src).toContain('raise RemoteCallError("orders", "getOrderById", res.status_code)');
  });

  it("declares httpx, which the sourceType adapter never reaches for an api binding", async () => {
    // An api-bound resource has no `storage`, so the restApi ResourceAdapter —
    // which is where `httpx` is normally declared — is skipped by design.
    // Without this the emitted client imports a package the project does not
    // depend on and `mypy --strict` fails on the missing stub.
    const files = await emit(system("string"));
    expect(files.get("shipping_svc/pyproject.toml") ?? "").toContain("httpx");
  });

  it("wires the call site and its import into the workflow routes", async () => {
    const files = await emit(system("string"));
    const routes = files.get("shipping_svc/app/http/workflows_routes.py") ?? "";
    expect(routes).toContain("from app.resources.api_clients import orders_get_order_by_id");
    expect(routes).toContain("(await orders_get_order_by_id(order_id))");
  });

  it("IMPORTS a foreign aggregate id, not just brands it", async () => {
    // Two halves, and emitting the brand is only the first.  Python names each
    // import explicitly, so a branded-but-unimported `OrderId` still fails
    // `mypy` / ruff F821 on the canonical `create(orderId: Order id)` shape.
    const files = await emit(system("Order id"));
    expect(files.get("shipping_svc/app/domain/ids.py") ?? "").toContain(
      'OrderId = NewType("OrderId"',
    );
    expect(files.get("shipping_svc/app/http/workflows_routes.py") ?? "").toContain(
      "from app.domain.ids import OrderId",
    );
  });

  it("exposes ONLY the operations the SERVING deployable mounts", async () => {
    // `api OrdersApi from Core` names a SUBDOMAIN, and Core holds both Orders
    // and Shipping — but `ordersSvc` hosts only Orders, so it mounts only the
    // Order routes.  Emitting client functions for the Shipping operations
    // would compile clean and 404 at runtime, which is the precise failure this
    // feature exists to prevent.  Scoping is `servedContextsFor`, shared by all
    // five backends because each previously had its own wrong copy.
    const src = await client();
    expect(src).not.toMatch(/Shipment/);
  });

  it("returns the callee's ABSENCE UNION as a value, not a throw", async () => {
    // `find byCode(...): Order option` answers the success body directly at 200
    // and rides absence on 404 — no `type` discriminator on the wire
    // (payloads.md §Union finds).  So absence is a VALUE the caller matches on;
    // every OTHER non-2xx is still a real error.
    const files = await emit(unionSystem());
    const src = files.get("shipping_svc/app/resources/api_clients.py") ?? "";
    expect(src).toContain("async def orders_by_code_order(code: str) -> OrderResponse | None:");
    expect(src).toContain("if res.status_code == 404:");
  });

  it("emits no client module for a deployable that binds no api", async () => {
    const files = await emit(system("string"));
    expect(files.has("orders_svc/app/resources/api_clients.py")).toBe(false);
  });
});
