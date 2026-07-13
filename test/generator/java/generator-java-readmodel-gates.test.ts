// ---------------------------------------------------------------------------
// Java read-model gates (M-T6.4) — three shapes the java view /
// workflow-instance / projection emitters cannot render used to CRASH codegen
// with an ungated `throw new Error`; they now fail honestly at validation with
// a `loom.java-*-unsupported` diagnostic (the emitter throws stay as
// unreachable backstops).  Each gate is java-specific: the SAME model on a node
// deployable validates clean and emits.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

async function codesFor(src: string): Promise<string[]> {
  const loom = await buildLoomModel(src);
  return validateLoomModel(loom)
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
}

// (1) Cross-aggregate view `follows` — an output bind reaches another
//     aggregate via `X id` (`customerId.name`), producing `output.auxiliaries`.
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

// (2) VO-typed saga instance-view field — the correlation-bearing workflow
//     carries a valueobject state field, which lands on `instanceWireShape`.
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

// (3) VO-typed projection row field — the read-model row carries a valueobject
//     field, which lands on the projection `wireShape`.
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

describe("java read-model gates (M-T6.4)", () => {
  it("gates a cross-aggregate view follows on java", async () => {
    expect(await codesFor(viewFollowsDdd("java"))).toContain("loom.java-view-follows-unsupported");
  });
  it("does not gate the same view follows on node", async () => {
    expect(await codesFor(viewFollowsDdd("node"))).not.toContain(
      "loom.java-view-follows-unsupported",
    );
  });

  it("gates a VO-typed saga instance field on java", async () => {
    expect(await codesFor(workflowVoDdd("java"))).toContain(
      "loom.java-workflow-instance-field-unsupported",
    );
  });
  it("does not gate the same saga instance field on node", async () => {
    expect(await codesFor(workflowVoDdd("node"))).not.toContain(
      "loom.java-workflow-instance-field-unsupported",
    );
  });

  it("gates a VO-typed projection row field on java", async () => {
    expect(await codesFor(projectionVoDdd("java"))).toContain(
      "loom.java-projection-field-unsupported",
    );
  });
  it("does not gate the same projection row field on node", async () => {
    expect(await codesFor(projectionVoDdd("node"))).not.toContain(
      "loom.java-projection-field-unsupported",
    );
  });
});
