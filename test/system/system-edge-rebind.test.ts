import { describe, expect, it } from "vitest";
import { isRebindableEdge, rebindEdgeTarget } from "../../web/src/builder/system/edge-rebind.js";

const CTX = `context Sales {
  aggregate Order {
  }
  aggregate Cart {
  }
  repository Orders for Order {
  }
}`;

const SYS = `system S {
  subdomain Sales {
    context Orders {
      aggregate Order {
      }
    }
  }
  subdomain Billing {
    context Inv {
      aggregate Invoice {
      }
    }
  }
  api OrdersApi from Sales
}`;

const DEPLOY = `system S {
  subdomain Sales {
    context Orders {
      aggregate Order {
      }
    }
  }
  deployable api { platform: node, contexts: [Orders], port: 4000 }
  deployable apiV2 { platform: node, contexts: [Orders], port: 4001 }
  deployable webApp { platform: react, targets: api, port: 3001 }
}`;

describe("edge drag-rebind", () => {
  it("flags only the single cross-ref edges as rebindable", () => {
    expect(isRebindableEdge("repository", "for")).toBe(true);
    expect(isRebindableEdge("api", "from")).toBe(true);
    expect(isRebindableEdge("deployable", "targets")).toBe(true);
    expect(isRebindableEdge("deployable", "module")).toBe(false);
    expect(isRebindableEdge("deployable", "serves")).toBe(false);
    expect(isRebindableEdge("deployable", "ui")).toBe(false);
    expect(isRebindableEdge("aggregate", "emits")).toBe(false);
  });

  it("repoints a repository's `for` aggregate", () => {
    const next = rebindEdgeTarget(CTX, "for", "repository:Orders", "aggregate:Cart")!;
    expect(next).toContain("repository Orders for Cart");
  });

  it("repoints an api's `from` subdomain", () => {
    const next = rebindEdgeTarget(SYS, "from", "api:OrdersApi", "subdomain:Billing")!;
    expect(next).toContain("api OrdersApi from Billing");
  });

  it("repoints a deployable's `targets` deployable", () => {
    const next = rebindEdgeTarget(DEPLOY, "targets", "deployable:webApp", "deployable:apiV2")!;
    expect(next).toContain("targets: apiV2");
    // The other deployables stay intact — no accidental cross-edits.
    expect(next).toContain("deployable api {");
    expect(next).toContain("deployable apiV2 {");
  });

  it("rejects a drop on the wrong target kind", () => {
    // repository expects an aggregate, not a module.
    expect(rebindEdgeTarget(CTX, "for", "repository:Orders", "module:Sales")).toBeNull();
    // api expects a module, not an aggregate.
    expect(rebindEdgeTarget(SYS, "from", "api:OrdersApi", "aggregate:Order")).toBeNull();
    // deployable.targets expects another deployable — a module is not valid.
    expect(rebindEdgeTarget(DEPLOY, "targets", "deployable:webApp", "module:Sales")).toBeNull();
  });

  it("rejects a non-rebindable edge label", () => {
    expect(rebindEdgeTarget(CTX, "emits", "aggregate:Order", "event:Placed")).toBeNull();
  });
});
