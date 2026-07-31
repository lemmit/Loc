// M-T4.8 slice 4b — the .NET typed in-system api client.
//
// Third sibling of `test/generator/typescript/api-client.test.ts` and
// `test/generator/python/api-client.test.ts`.  Beyond the shared contract, the
// properties pinned here are the three defects `dotnet build /warnaserror`
// caught that no vitest-tier assertion would have — every one of them emitted
// a model that was valid and an emitter that reported success:
//
//   1. a `var body` local colliding with the `body` PARAMETER of a
//      whole-shape create,
//   2. a C# id (`readonly record struct OrderId(Guid Value)`) passed straight
//      into a `string` wire parameter,
//   3. blanket-nullable record members, which compile here and then fail
//      CS8604 one frame out when the value reaches a domain factory.
//
// Plus the one property no compiler can see: camelCase JSON binding. Without
// it every field deserializes to its default and the call "succeeds" carrying
// nothing — which is what the runtime e2e exists to catch.

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
    platform: dotnet contexts: [Shipping] dataSources: [shippingState, orders] port: 3001
  }
}
`;
}

async function client(paramType = "string"): Promise<string> {
  const files = await emit(system(paramType));
  return files.get("shipping_svc/Resources/ApiClients.cs") ?? "";
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
    platform: dotnet contexts: [Shipping] dataSources: [shippingState, orders] port: 3001
  }
}
`;
}

describe(".NET typed in-system api client", () => {
  it("reads its base URL from the same env seam compose injects", async () => {
    expect(await client()).toContain(
      `Environment.GetEnvironmentVariable("${resourceEnvUrlVar("orders")}")`,
    );
  });

  it("emits the callee's ABSOLUTE path, escaping path params", async () => {
    expect(await client()).toContain(
      '$"/api/orders/{Uri.EscapeDataString(id?.ToString() ?? string.Empty)}"',
    );
  });

  it("binds camelCase JSON — the failure no compiler can see", async () => {
    // The callee serializes `orderCode`; the record member is `OrderCode`.
    // Without BOTH options every field takes its default and the call
    // "succeeds" carrying nothing.
    const src = await client();
    expect(src).toContain("PropertyNamingPolicy = JsonNamingPolicy.CamelCase,");
    expect(src).toContain("PropertyNameCaseInsensitive = true,");
  });

  it("mirrors the callee's optionality instead of blanket-nullable members", async () => {
    // Blanket-nullable compiles HERE and then fails CS8604 one frame out, when
    // the value reaches a domain factory that wants `string`.
    const src = await client();
    expect(src).toMatch(/public sealed record OrderResponse\([\s\S]*?string Code,/);
    expect(src).not.toMatch(/public sealed record OrderResponse\([\s\S]*?string\? Code,/);
  });

  it("does not shadow a whole-shape `body` parameter with a local", async () => {
    // `var body = await res.Content.ReadAsStringAsync()` inside a method whose
    // parameter is also `body` is a C# compile error.
    const src = await client();
    expect(src).toContain("Orders_CreateOrder(object body)");
    expect(src).not.toContain("var body = await res.Content.ReadAsStringAsync();");
    expect(src).toContain("var __payload = await res.Content.ReadAsStringAsync();");
  });

  it("sends EVERY body argument of a multi-arg operation", async () => {
    const src = await client();
    expect(src).toContain('["code"] = code, ["status"] = status');
  });

  it("throws a status-carrying exception rather than collapsing failures", async () => {
    const src = await client();
    expect(src).toContain("public sealed class RemoteCallException : Exception");
    expect(src).toContain('throw new RemoteCallException("orders", "getOrderById"');
  });

  it("coerces a C# id argument to its wire string at the call site", async () => {
    // A C# id is a `readonly record struct`, not a string — TS and Python get
    // this for free because their branded ids ARE strings.
    const files = await emit(system("Order id"));
    const handler = files.get("shipping_svc/Application/Workflows/FulfilHandler.cs") ?? "";
    expect(handler).toContain("ApiClients.Orders_GetOrderById(command.OrderId.ToString())");
  });

  it("adds the Resources using even with no sourceType-routed resource", async () => {
    // An api-bound resource has no `storage`, so it never reaches a
    // ResourceAdapter and `resourceClasses` stays empty — the resource-op
    // using gate never fires for it.
    const files = await emit(system("string"));
    expect(files.get("shipping_svc/Application/Workflows/FulfilHandler.cs") ?? "").toContain(
      "using ShippingSvc.Resources;",
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
    const src = files.get("shipping_svc/Resources/ApiClients.cs") ?? "";
    expect(src).toContain(
      "public static async Task<OrderResponse?> Orders_ByCodeOrder(string code)",
    );
    expect(src).toContain("if ((int)res.StatusCode == 404)");
  });

  it("emits no client class for a deployable that binds no api", async () => {
    const files = await emit(system("string"));
    expect(files.has("orders_svc/Resources/ApiClients.cs")).toBe(false);
  });
});
