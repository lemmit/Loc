// OperationForm / WorkflowForm param-default seeding.
//
// An operation/workflow param default (`param: T = <expr>`, ParamIR.default)
// seeds the scaffolded form the same way an aggregate field default seeds the
// create form — both route through `initialValuesTs`.  A client-evaluable
// default (constant / enum) seeds; a `this`-relative default (the op-by-name
// form posts by route id, so the target record isn't loaded client-side) falls
// back to the type-zero seed until the this-relative slice lands.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYSTEM = (body: string) => `
  system S {
    subdomain M {
      context C {
        aggregate Shipment {
          eta:    datetime
          status: string
          derived display: string = status
          operation cancel(reason: string = "customer request", priority: int = 2) {
            status := "cancelled"
          }
          operation reschedule(to: datetime = this.eta) { eta := to }
        }
        repository Shipments for Shipment { }
      }
    }
    ui WebApp {
      page ShipmentOps {
        route: "/shipments/:id/ops"
        body:  ${body}
      }
    }
    deployable api { platform: node, contexts: [C], port: 3000 }
    deployable web { platform: static, targets: api, ui: WebApp, port: 3001 }
  }
`;

describe("OperationForm param-default seeding", () => {
  it("seeds constant/enum param defaults into the operation form", async () => {
    const files = await generateSystemFiles(SYSTEM(`OperationForm { of: Shipment, op: cancel }`));
    const tsx = files.get("web/src/pages/shipment_ops.tsx")!;
    expect(tsx).toBeDefined();
    const defaults = tsx.match(/defaultValues:\s*(\{[^}]*\})/)?.[1] ?? "";
    expect(defaults).toMatch(/reason:\s*"customer request"/);
    expect(defaults).toMatch(/priority:\s*2\b/);
  });

  it("falls back to type-zero for a this-relative param default (deferred)", async () => {
    const files = await generateSystemFiles(
      SYSTEM(`OperationForm { of: Shipment, op: reschedule }`),
    );
    const tsx = files.get("web/src/pages/shipment_ops.tsx")!;
    expect(tsx).toBeDefined();
    const defaults = tsx.match(/defaultValues:\s*(\{[^}]*\})/)?.[1] ?? "";
    // `to: datetime = this.eta` is not client-evaluable here → empty seed.
    expect(defaults).toMatch(/to:\s*""/);
  });
});
