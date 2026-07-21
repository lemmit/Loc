// ---------------------------------------------------------------------------
// Java read-model shapes (M-T6.4).  Shapes that used to CRASH java codegen with
// an ungated `throw new Error`, now IMPLEMENTED:
//
//   1. VO-typed workflow-instance / projection read-model fields — the
//      `<Vo>Response` record is co-located in the consuming package
//      (application.workflows) and the read-model DTO / Row references it
//      (parity with the aggregate response path).
//
// The entity (containment-part) variant of the read-model fields stays a
// defensive `loom.java-*-field-unsupported` backstop, but a part type never
// resolves in workflow / projection scope, so it is unreachable on valid `.ddd`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

async function codesFor(src: string): Promise<string[]> {
  const loom = await buildLoomModel(src);
  return validateLoomModel(loom)
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
}

// VO-typed saga instance-view field — the correlation-bearing workflow carries a
// valueobject state field, which lands on `instanceWireShape`.
const workflowVoDdd = (platform: string): string => `
system S {
  subdomain Sales {
    context Orders {
      valueobject Money {
        amount: int
        currency: string
      }
      aggregate Order {
        code: string
      }
      repository Orders for Order { }
      event OrderPlaced { order: Order id }
      workflow Fulfillment {
        orderId: Order id
        cost: Money
        create(p: OrderPlaced) by p.order { cost := Money { amount: 0, currency: "USD" } }
      }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: ${platform}, contexts: [Orders], dataSources: [st], serves: A, port: 4000 }
}`;

// VO-typed projection row field — the read-model row carries a valueobject
// field, which lands on the projection `wireShape`.
const projectionVoDdd = (platform: string): string => `
system S {
  subdomain Sales {
    context Orders {
      valueobject Money {
        amount: int
        currency: string
      }
      aggregate Order {
        code: string
      }
      repository Orders for Order { }
      event OrderPlaced { order: Order id }
      channel Lifecycle {
        carries: OrderPlaced
        delivery: broadcast
        retention: ephemeral
      }
      projection OrderBoard keyed by order {
        order: Order id
        cost: Money
        on(e: OrderPlaced) { order := e.order  cost := Money { amount: 0, currency: "USD" } }
      }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: ${platform}, contexts: [Orders], dataSources: [st], serves: A, port: 4000 }
}`;

const WF_ROOT = "d/src/main/java/com/loom/d/application/workflows";

describe("java read-model VO fields (M-T6.4 implementation)", () => {
  it("no longer gates a VO-typed saga instance field on java", async () => {
    expect(await codesFor(workflowVoDdd("java"))).not.toContain(
      "loom.java-workflow-instance-field-unsupported",
    );
  });

  it("emits MoneyResponse into application.workflows and the InstanceResponse references it", async () => {
    const files = await generateSystemFiles(workflowVoDdd("java"));
    const vo = files.get(`${WF_ROOT}/MoneyResponse.java`);
    expect(vo, "MoneyResponse.java co-located with the instance DTO").toBeDefined();
    expect(vo!).toContain("public static MoneyResponse from(Money value)");
    const dto = files.get(`${WF_ROOT}/FulfillmentInstanceResponse.java`)!;
    expect(dto).toContain("MoneyResponse cost");
  });

  it("no longer gates a VO-typed projection row field on java", async () => {
    expect(await codesFor(projectionVoDdd("java"))).not.toContain(
      "loom.java-projection-field-unsupported",
    );
  });

  it("emits MoneyResponse for a projection row and the ProjectionResponse references it", async () => {
    const files = await generateSystemFiles(projectionVoDdd("java"));
    expect(files.get(`${WF_ROOT}/MoneyResponse.java`)).toBeDefined();
    const dto = files.get(`${WF_ROOT}/OrderBoardResponse.java`)!;
    expect(dto).toContain("MoneyResponse cost");
  });
});
