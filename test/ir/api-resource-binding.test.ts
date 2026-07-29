// M-T4.8 slice 1 — `resource { kind: api, use: <Api> }`: the in-system typed
// binding.  `use:` accepts an `Api` alongside a `Storage`; the address is then
// DERIVED from the deployable that `serves:` it rather than authored as a
// `storage restApi { baseUrl }`.
//
// What each block pins:
//   - lowering discriminates the two targets (`apiName` vs `storageName`) —
//     the pre-slice code wrote both into `storageName`, where a storage lookup
//     silently missed and every consumer read "no storage configured";
//   - the three IR gates that make the address derivable at all (served,
//     unambiguous, not self);
//   - `apiResourceBindings` joins a wired resource to its serving deployable.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { apiResourceBindings } from "../../src/ir/util/api-resource-binding.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** Two backends: `ordersSvc` serves `OrdersApi`, `shippingSvc` calls it. */
function system(opts: { serves?: string; shippingServes?: string; kind?: string } = {}): string {
  const serves = opts.serves ?? " serves: OrdersApi";
  const shippingServes = opts.shippingServes ?? "";
  const kind = opts.kind ?? "api";
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
    }
  }
  api OrdersApi from Core
  storage primary { type: postgres }
  resource ordersState   { for: Orders,   kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  resource orders        { for: Shipping, kind: ${kind}, use: OrdersApi }
  deployable ordersSvc {
    platform: node contexts: [Orders] dataSources: [ordersState]${serves} port: 3000
  }
  deployable shippingSvc {
    platform: node contexts: [Shipping] dataSources: [shippingState, orders]${shippingServes} port: 3001
  }
}
`;
}

async function lower(source: string) {
  const { model } = await parseString(source, { validate: false });
  return enrichLoomModel(lowerModel(model));
}

async function irDiagnostics(source: string) {
  return validateLoomModel(await lower(source));
}

describe("resource { kind: api, use: <Api> } — lowering", () => {
  it("discriminates an api target from a storage target", async () => {
    const loom = await lower(system());
    const sys = loom.systems[0];
    if (!sys) throw new Error("no system lowered");

    const apiBound = sys.dataSources.find((r) => r.name === "orders");
    expect(apiBound?.apiName).toBe("OrdersApi");
    // Not written into `storageName` — a storage lookup keyed by "OrdersApi"
    // resolves to nothing, which downstream reads as "no storage configured".
    expect(apiBound?.storageName).toBe("");

    const storageBound = sys.dataSources.find((r) => r.name === "ordersState");
    expect(storageBound?.storageName).toBe("primary");
    expect(storageBound?.apiName).toBeUndefined();
  });

  it("accepts the well-formed binding with no diagnostics", async () => {
    expect(await irDiagnostics(system())).toEqual([]);
  });
});

describe("resource { kind: api, use: <Api> } — IR gates", () => {
  it("rejects an api no backend serves — the address is underivable", async () => {
    const diags = await irDiagnostics(system({ serves: "" }));
    const d = diags.find((x) => x.code === "loom.resource-api-unserved");
    expect(d?.severity).toBe("error");
    expect(d?.message).toContain("no backend deployable serves it");
  });

  it("rejects an api two backends serve — the caller's address is ambiguous", async () => {
    const diags = await irDiagnostics(system({ shippingServes: " serves: OrdersApi" }));
    const d = diags.find((x) => x.code === "loom.resource-api-ambiguous-server");
    expect(d?.severity).toBe("error");
    expect(d?.message).toContain("ordersSvc");
    expect(d?.message).toContain("shippingSvc");
  });

  it("rejects a deployable calling an api it serves itself", async () => {
    const diags = await irDiagnostics(system({ serves: "", shippingServes: " serves: OrdersApi" }));
    const d = diags.find((x) => x.code === "loom.resource-api-self-call");
    expect(d?.severity).toBe("error");
    expect(d?.message).toContain("already in-process");
  });
});

describe("apiResourceBindings", () => {
  it("joins a wired api resource to the deployable that serves it", async () => {
    const loom = await lower(system());
    const sys = loom.systems[0];
    if (!sys) throw new Error("no system lowered");
    const caller = sys.deployables.find((d) => d.name === "shippingSvc");
    if (!caller) throw new Error("no caller deployable");

    const bindings = apiResourceBindings(caller, sys);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.apiName).toBe("OrdersApi");
    expect(bindings[0]?.resource.name).toBe("orders");
    expect(bindings[0]?.server.name).toBe("ordersSvc");
  });

  it("returns nothing for a deployable that wires only storage resources", async () => {
    const loom = await lower(system());
    const sys = loom.systems[0];
    if (!sys) throw new Error("no system lowered");
    const callee = sys.deployables.find((d) => d.name === "ordersSvc");
    if (!callee) throw new Error("no callee deployable");
    expect(apiResourceBindings(callee, sys)).toEqual([]);
  });

  it("drops an unresolvable binding rather than guessing a server", async () => {
    // Unserved: the IR gate above already errors, so the generator must never
    // see a half-resolved binding it would have to invent an address for.
    const loom = await lower(system({ serves: "" }));
    const sys = loom.systems[0];
    if (!sys) throw new Error("no system lowered");
    const caller = sys.deployables.find((d) => d.name === "shippingSvc");
    if (!caller) throw new Error("no caller deployable");
    expect(apiResourceBindings(caller, sys)).toEqual([]);
  });
});
