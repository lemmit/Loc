// M-T4.8 slice 1 — the composer half: a `resource { kind: api, use: <Api> }`
// derives its address from the deployable that `serves:` that api.
//
// This is the gate on the wiring gap the feature exists to close.  Before it,
// reaching a sibling service meant a `storage restApi { config: { baseUrl:
// "http://orders_svc:3000" } }` — a hand-typed string that carried nothing the
// compiler didn't already know and rotted silently when the deployable was
// renamed.  Compose emitted no cross-service `depends_on` either, so a caller
// that booted first failed its opening request with ECONNREFUSED.
//
// The env-var name is asserted against `resourceEnvUrlVar` rather than a
// literal: it is the seam the emitted client reads, and a drift between the
// two halves is invisible at compile time (the client would silently fall back
// to its baked-in default).

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";
import { resourceEnvUrlVar } from "../../src/util/resource-env.js";

async function emit(src: string) {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  return generateSystems(doc.parseResult.value as Model).files;
}

const TWO_SERVICES = `
system Acme {
  subdomain Core {
    context Orders {
      aggregate Order with crudish { code: string  status: string }
      repository Orders for Order { }
    }
    context Shipping {
      aggregate Shipment with crudish { orderCode: string  status: string }
      repository Shipments for Shipment { }
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

/** The `shipping_svc:` service block of a compose file. */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`no service '${name}' in compose`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

describe("api-bound resource — derived compose wiring", () => {
  it("injects the called service's address, derived from its slug + container port", async () => {
    const files = await emit(TWO_SERVICES);
    const compose = files.get("docker-compose.yml") ?? "";
    const caller = serviceBlock(compose, "shipping_svc");

    // Container port, NOT the host-mapped `port: 3001` — inside the compose
    // network the callee answers on its own container port.
    expect(caller).toContain(`${resourceEnvUrlVar("orders")}: "http://orders_svc:3000"`);
    // No authored baseUrl anywhere: the whole point is that nothing in the
    // `.ddd` names an address.
    expect(TWO_SERVICES).not.toContain("baseUrl");
  });

  it("orders the caller's startup after the called service's healthcheck", async () => {
    const files = await emit(TWO_SERVICES);
    const caller = serviceBlock(files.get("docker-compose.yml") ?? "", "shipping_svc");
    expect(caller).toMatch(/depends_on:[\s\S]*orders_svc:\s*\n\s*condition: service_healthy/);
  });

  it("leaves the called service with no reverse dependency", async () => {
    const files = await emit(TWO_SERVICES);
    const callee = serviceBlock(files.get("docker-compose.yml") ?? "", "orders_svc");
    expect(callee).not.toContain("shipping_svc");
    expect(callee).not.toContain(resourceEnvUrlVar("orders"));
  });

  it("emits nothing extra for a system with no api-bound resource", async () => {
    // The gate that keeps every pre-existing system byte-identical.
    const files = await emit(
      TWO_SERVICES.replace(/\n\s*resource orders .*\n/, "\n").replace(", orders]", "]"),
    );
    const compose = files.get("docker-compose.yml") ?? "";
    const caller = serviceBlock(compose, "shipping_svc");
    expect(caller).not.toContain("orders_svc");
    expect(caller).not.toContain(resourceEnvUrlVar("orders"));
  });
});
