// M-T4.8 slice 4d — the Phoenix/Elixir typed in-system api client, the last of
// the five.  With this `REMOTE_API_OP_UNSUPPORTED` is empty.
//
// Beyond the shared contract, this pins the Elixir-specific decisions and the
// two defects generation surfaced — one of which no compiler could ever catch:
//
//   1. the base URL must be read by a FUNCTION, not a `@module_attribute`.  An
//      attribute is evaluated at COMPILE time and a release is built in the
//      Docker image — long before compose sets the variable — so the attribute
//      form bakes in the localhost fallback and silently never sees the real
//      address.  `mix compile` is perfectly happy with it.
//   2. the response is projected onto ATOM keys.  Req decodes JSON to a
//      STRING-keyed map, and `o.code` in domain code is map-dot, which only
//      resolves atom keys — so without the projection the call succeeds and
//      the caller cannot read a single field off it.

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
    platform: elixir contexts: [Shipping] dataSources: [shippingState, orders] port: 3001
  }
}
`;
}

const CLIENT = "shipping_svc/lib/shipping_svc/resources/api_clients.ex";

async function client(paramType = "string"): Promise<string> {
  return (await emit(system(paramType))).get(CLIENT) ?? "";
}

describe("Phoenix typed in-system api client", () => {
  it("reads its base URL at RUNTIME, not as a compile-time attribute", async () => {
    const src = await client();
    // The defect this pins is invisible to `mix compile`: a `@module_attribute`
    // is frozen at image-build time and would never see compose's variable.
    expect(src).toContain("defp orders_base_url do");
    expect(src).toContain(`System.get_env("${resourceEnvUrlVar("orders")}")`);
    expect(src).not.toContain("@orders_base_url ");
  });

  it("emits the callee's ABSOLUTE path, encoding path params", async () => {
    expect(await client()).toContain('"/api/orders/" <> URI.encode_www_form(to_string(id))');
  });

  it("projects the response onto ATOM keys so map-dot reads work", async () => {
    // Req decodes to STRING keys; `o.code` only resolves atom keys.
    const src = await client();
    expect(src).toContain('code: Map.get(payload, "code")');
    expect(src).toContain('order_code: Map.get(payload, "orderCode")');
  });

  it("does not shadow a whole-shape `body` parameter", async () => {
    const src = await client();
    expect(src).toContain("def orders_create_order(body) do");
    expect(src).toContain("payload = res.body || %{}");
    expect(src).not.toContain("body = res.body");
  });

  it("closes the map literal without a trailing comma", async () => {
    // Elixir rejects `%{a: 1,}` — a parse error the emitter cannot see.
    expect(await client()).not.toMatch(/,\n\s*\}/);
  });

  it("sends EVERY body argument of a multi-arg operation", async () => {
    expect(await client()).toContain('json: %{"code" => code, "status" => status}');
  });

  it("raises a status-carrying exception rather than collapsing failures", async () => {
    const src = await client();
    expect(src).toContain("defexception [:resource, :operation_id, :status]");
    expect(src).toContain("raise RemoteCallError,");
  });

  it("declares :req, which the sourceType adapter never reaches for an api binding", async () => {
    // An api-bound resource has no `storage`, so the restApi ResourceAdapter —
    // where `:req` is normally declared — is skipped by design.
    const files = await emit(system("string"));
    expect(files.get("shipping_svc/mix.exs") ?? "").toContain('{:req, "~> 0.5"}');
  });

  it("calls through the FULLY-QUALIFIED module — no alias to get wrong", async () => {
    const files = await emit(system("string"));
    const wf = files.get("shipping_svc/lib/shipping_svc/shipping/workflows/fulfil.ex") ?? "";
    expect(wf).toContain("ShippingSvc.Resources.ApiClients.orders_get_order_by_id(");
  });

  it("emits no client module for a deployable that binds no api", async () => {
    const files = await emit(system("string"));
    expect(files.has("orders_svc/lib/orders_svc/resources/api_clients.ex")).toBe(false);
  });
});
