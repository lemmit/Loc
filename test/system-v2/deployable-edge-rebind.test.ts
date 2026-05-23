import { describe, expect, it } from "vitest";
import {
  isRebindableDeployableEdge,
  rebindDeployableEdgeTarget,
} from "../../web/src/builder/system-v2/deployable-edge-rebind.js";

const SRC = `system S {
  module Sales {
    context Orders {
      aggregate Order {
      }
    }
  }
  ui Web {
  }
  ui Mobile {
  }
  deployable api { platform: hono, modules: Sales, port: 3000 }
  deployable other { platform: hono, modules: Sales, port: 3100 }
  deployable webApp { platform: react, targets: api, ui: Web, port: 3001 }
}`;

describe("v2 deployable edge drag-rebind", () => {
  it("flags only `targets` and `ui` as rebindable", () => {
    expect(isRebindableDeployableEdge("targets")).toBe(true);
    expect(isRebindableDeployableEdge("ui")).toBe(true);
    expect(isRebindableDeployableEdge("modules")).toBe(false);
    expect(isRebindableDeployableEdge("serves")).toBe(false);
  });

  it("repoints a deployable's `targets` edge to another deployable", () => {
    const next = rebindDeployableEdgeTarget(SRC, "targets", "deployable:webApp", "deployable:other")!;
    expect(next).toContain("targets: other");
  });

  it("repoints a deployable's `ui` edge to another ui", () => {
    const next = rebindDeployableEdgeTarget(SRC, "ui", "deployable:webApp", "ui:Mobile")!;
    expect(next).toContain("ui: Mobile");
  });

  it("rejects a wrong target kind / self-target / non-deployable owner", () => {
    expect(rebindDeployableEdgeTarget(SRC, "targets", "deployable:webApp", "module:Sales")).toBeNull();
    expect(rebindDeployableEdgeTarget(SRC, "targets", "deployable:webApp", "deployable:webApp")).toBeNull();
    expect(rebindDeployableEdgeTarget(SRC, "ui", "module:Sales", "ui:Web")).toBeNull();
  });

  it("rejects a non-rebindable edge label", () => {
    expect(rebindDeployableEdgeTarget(SRC, "modules", "deployable:webApp", "module:Sales")).toBeNull();
    expect(rebindDeployableEdgeTarget(SRC, "serves", "deployable:webApp", "api:any")).toBeNull();
  });
});
