// ---------------------------------------------------------------------------
// Java read-model shapes (M-T6.4).  Two shapes that used to CRASH java codegen
// with an ungated `throw new Error`:
//
//   1. VO-typed workflow-instance / projection read-model fields — now EMIT: the
//      `<Vo>Response` record is co-located in application.workflows and the
//      InstanceResponse / ProjectionResponse DTOs reference it (parity with the
//      aggregate response path).
//   2. cross-aggregate view `follows` — still gated honestly with
//      `loom.java-view-follows-unsupported` (feature not yet on java).
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
      // Workflow-sourced view — its <View>Row also surfaces the VO field, in a
      // different package (application.views).
      view CostlyFulfillments = Fulfillment where cost.amount > 0
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

// Cross-aggregate view `follows` — an output bind reaches another aggregate via
// `X id` (`customerId.name`), producing `output.auxiliaries`.
const viewFollowsDdd = (platform: string): string => `
system S {
  subdomain Sales {
    context Orders {
      aggregate Customer {
        name: string
      }
      aggregate Order {
        customerId: Customer id
        status: string
      }
      repository Customers for Customer { }
      repository Orders for Order { }
      view CustomerOrders {
        orderId: Order id
        customerName: string
        from Order where status == "x"
        bind orderId = id,
             customerName = customerId.name
      }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: ${platform}, contexts: [Orders], dataSources: [st], serves: A, port: 4000 }
}`;

const WF_ROOT = "d/src/main/java/com/loom/d/application/workflows";
const VIEW_ROOT = "d/src/main/java/com/loom/d/application/views";

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

  it("emits MoneyResponse into application.views for the workflow-sourced view Row", async () => {
    const files = await generateSystemFiles(workflowVoDdd("java"));
    expect(files.get(`${VIEW_ROOT}/MoneyResponse.java`)).toBeDefined();
    const row = files.get(`${VIEW_ROOT}/CostlyFulfillmentsRow.java`)!;
    expect(row).toContain("MoneyResponse cost");
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

describe("java cross-aggregate view follows (still gated, M-T6.4)", () => {
  it("gates a cross-aggregate view follows on java", async () => {
    expect(await codesFor(viewFollowsDdd("java"))).toContain("loom.java-view-follows-unsupported");
  });
  it("does not gate the same view follows on node", async () => {
    expect(await codesFor(viewFollowsDdd("node"))).not.toContain(
      "loom.java-view-follows-unsupported",
    );
  });
});
