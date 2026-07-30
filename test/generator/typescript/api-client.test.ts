// M-T4.8 slice 3 — the Hono typed in-system api client.
//
// The client's whole value is that neither half can drift from the callee:
// paths come from `deriveContextOperations` (the same derivation the callee's
// route builder answers to) and the response schema from the same
// `forApiRead(wireFieldsForAggregate(...))` walk the callee serializes.  These
// tests pin the properties that would silently break that — not the exact
// formatting of the emitted file.

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

const SRC = `
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
        create(orderId: string) {
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
    platform: node contexts: [Orders] dataSources: [ordersState] serves: OrdersApi port: 3000
  }
  deployable shippingSvc {
    platform: node contexts: [Shipping] dataSources: [shippingState, orders] port: 3001
  }
}
`;

async function client(): Promise<string> {
  const files = await emit(SRC);
  return files.get("shipping_svc/resources/api-clients.ts") ?? "";
}

describe("Hono typed in-system api client", () => {
  it("reads its base URL from the same env seam compose injects", async () => {
    const src = await client();
    expect(src).toContain(`process.env.${resourceEnvUrlVar("orders")}`);
  });

  it("emits the callee's ABSOLUTE path, interpolating path params", async () => {
    const src = await client();
    // `/api/...` — not the router-relative `/{id}` the callee's own emitter
    // uses.  A caller must not need to know how the callee mounts sub-routers.
    expect(src).toContain("`/api/orders/${encodeURIComponent(String(id))}`");
  });

  it("parses the response with a schema derived from the callee's wire shape", async () => {
    const src = await client();
    expect(src).toContain("export const OrderResponse = z.object({");
    // Exactly the served field list — id + declared fields + version.
    expect(src).toMatch(/OrderResponse = z\.object\(\{[\s\S]*code: z\.string\(\)/);
    expect(src).toMatch(/OrderResponse = z\.object\(\{[\s\S]*version: z\.number\(\)\.int\(\)/);
    expect(src).toContain("return OrderResponse.parse(await res.json());");
  });

  it("sends EVERY body argument of a multi-arg operation", async () => {
    const src = await client();
    // The `create` route takes one whole-shape body; a domain operation takes
    // one body param per declared argument.  Serializing only the first — the
    // shape a naive emitter produces — silently drops the rest.
    expect(src).toContain("body: JSON.stringify({ code, status })");
    expect(src).toContain("orders$updateOrder(id: string, code: string, status: string)");
  });

  it("throws a status-carrying error rather than collapsing failures", async () => {
    const src = await client();
    expect(src).toContain("export class RemoteCallError extends Error");
    expect(src).toContain('throw new RemoteCallError("orders", "getOrderById", res.status)');
  });

  it("returns void for a 204 operation instead of parsing an absent body", async () => {
    const src = await client();
    expect(src).toMatch(/orders\$destroyOrder\(id: string\): Promise<void>/);
  });

  it("wires the call site and its import into the workflow module", async () => {
    const files = await emit(SRC);
    const wf = files.get("shipping_svc/http/workflows.ts") ?? "";
    expect(wf).toContain(`import { orders$getOrderById } from "../resources/api-clients";`);
    expect(wf).toContain("(await orders$getOrderById(orderId))");
  });

  it("brands a foreign aggregate id used as a workflow starter param", async () => {
    // The canonical cross-service shape: `create(orderId: Order id)` on a
    // deployable that does NOT host `Order`.  The route emits
    // `Ids.OrderId(body.orderId)`, so without the brand the generated project
    // fails `tsc` on a missing export.  Pre-existing (it reproduces with no api
    // call at all) — the foreign-id collection covered workflow STATE fields
    // and foreign event fields, never starter params.
    const files = await emit(SRC.replace("create(orderId: string)", "create(orderId: Order id)"));
    const ids = files.get("shipping_svc/domain/ids.ts") ?? "";
    expect(ids).toContain("export type OrderId =");
  });

  it("exposes ONLY the operations the SERVING deployable mounts", async () => {
    // `api OrdersApi from Core` names a SUBDOMAIN holding both Orders and
    // Shipping, but `ordersSvc` hosts only Orders and so mounts only the Order
    // routes.  Emitting Shipping client functions would compile clean and 404
    // at runtime — the precise failure this feature exists to prevent.
    const src = await client();
    expect(src).not.toMatch(/Shipment/);
  });

  it("emits no client module for a deployable that binds no api", async () => {
    // The byte-identity gate: the callee itself wires only a state resource.
    const files = await emit(SRC);
    expect(files.has("orders_svc/resources/api-clients.ts")).toBe(false);
  });
});
