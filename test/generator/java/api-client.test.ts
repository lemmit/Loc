// M-T4.8 slice 4c — the Java/Spring Boot typed in-system api client.
//
// Fourth sibling of the hono / python / .NET client tests.  Beyond the shared
// contract, this pins the two Java-specific decisions and the ONE defect
// `gradle testClasses` caught that no vitest-tier assertion would have:
//
//   - SYNCHRONOUS: Spring workflow beans block, so the call site carries no
//     await wrapper (the .NET arm parenthesises `(await …)` because C# needs
//     it).
//   - A foreign aggregate id emitted its BRAND only when the project also used
//     channels — so `create(orderId: Order id)` in a channel-less project
//     compiled to `new OrderId(...)` with no `OrderId.java` anywhere.  Valid
//     model, emitter reports success, javac says "cannot find symbol".

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";
import { resourceEnvUrlVar } from "../../../src/util/resource-env.js";
import { expectEmitted } from "../../_helpers/emitted.js";

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
    platform: node contexts: [Orders]   dataSources: [ordersState] serves: OrdersApi port: 3000
  }
  deployable shippingSvc {
    platform: java contexts: [Shipping] dataSources: [shippingState, orders] port: 3001
  }
}
`;
}

const CLIENT = "shipping_svc/src/main/java/com/loom/shippingsvc/resources/ApiClients.java";
const WORKFLOW =
  "shipping_svc/src/main/java/com/loom/shippingsvc/application/workflows/ShippingWorkflows.java";

async function client(paramType = "string"): Promise<string> {
  return (await emit(system(paramType))).get(CLIENT) ?? "";
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
    platform: java contexts: [Shipping] dataSources: [shippingState, orders] port: 3001
  }
}
`;
}

describe("Java typed in-system api client", () => {
  it("reads its base URL from the same env seam compose injects", async () => {
    expect(await client()).toContain(
      `System.getenv().getOrDefault("${resourceEnvUrlVar("orders")}"`,
    );
  });

  it("emits the callee's ABSOLUTE path, encoding path params", async () => {
    expect(await client()).toContain('"/api/orders/" + enc(String.valueOf(id))');
  });

  it("uses JDK-native HTTP and Jackson — no new Gradle dependency", async () => {
    const src = await client();
    expect(src).toContain("import java.net.http.HttpClient;");
    expect(src).toContain("MAPPER.readValue(res.body(), OrderResponse.class)");
    // Both ship with the JDK / Spring Boot, so the build file is untouched.
    const files = await emit(system("string"));
    // `expectEmitted`, not `?? ""`: the assertion below is NEGATIVE, and a
    // missing build file would satisfy it for free (test/_helpers/emitted.ts).
    const gradle = expectEmitted(files, "shipping_svc/build.gradle.kts");
    expect(gradle).not.toContain("java.net.http");
  });

  it("boxes record components so a missing field is null, not a parse crash", async () => {
    expect(await client()).toContain(
      "public record OrderResponse(String id, String code, String status, Integer version) { }",
    );
  });

  it("sends EVERY body argument of a multi-arg operation", async () => {
    expect(await client()).toContain('java.util.Map.of("code", code, "status", status)');
  });

  it("throws a status-carrying exception rather than collapsing failures", async () => {
    const src = await client();
    expect(src).toContain("class RemoteCallException extends RuntimeException");
    expect(src).toContain('throw new RemoteCallException("orders", "getOrderById"');
  });

  it("calls SYNCHRONOUSLY — no await wrapper, unlike the .NET sibling", async () => {
    const files = await emit(system("string"));
    const wf = files.get(WORKFLOW) ?? "";
    expect(wf).toContain("ApiClients.ordersGetOrderById(");
    expect(wf).not.toContain("await ApiClients");
  });

  it("coerces a Java id argument to its wire string at the call site", async () => {
    const files = await emit(system("Order id"));
    expect(files.get(WORKFLOW) ?? "").toContain(
      "ApiClients.ordersGetOrderById(orderId.toString())",
    );
  });

  it("imports the resources package even with no sourceType-routed resource", async () => {
    // An api-bound resource has no `storage`, so `resourceClasses` stays empty
    // and the resource-op import gate never fires for it.
    const files = await emit(system("string"));
    expect(files.get(WORKFLOW) ?? "").toContain("import com.loom.shippingsvc.resources.*;");
  });

  it("brands a foreign aggregate id in a CHANNEL-LESS project", async () => {
    // Regression: this emission used to sit inside `if (hasChannels && system)`,
    // so any channel-less project referencing a foreign id failed javac.
    const files = await emit(system("Order id"));
    expect(
      files.has("shipping_svc/src/main/java/com/loom/shippingsvc/domain/ids/OrderId.java"),
    ).toBe(true);
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
    const src =
      files.get("shipping_svc/src/main/java/com/loom/shippingsvc/resources/ApiClients.java") ?? "";
    expect(src).toContain("public static OrderResponse ordersByCodeOrder(String code) {");
    expect(src).toContain("if (res.statusCode() == 404) {");
  });

  it("emits no client class for a deployable that binds no api", async () => {
    const files = await emit(system("string"));
    expect(
      [...files.keys()].some((k) => k.startsWith("orders_svc") && k.endsWith("ApiClients.java")),
    ).toBe(false);
  });
});
