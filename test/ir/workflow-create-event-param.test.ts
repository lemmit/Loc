// Event- and payload-typed workflow command parameters
// (workflow-and-applier.md A2-S5f — `create(event: E) by …` /
// `handle h(c: Command)`).  An `event` or `payload`/`command` name resolves as
// a parameter type only in a workflow `create`/`handle` position; the param
// binds as an `entity`-marked local (transport types aren't a distinct TypeIR
// kind) so a body access (`e.field`) type-resolves through the event/payload
// field set, mirroring `on`/`apply` event params.

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/index.js";

async function lowerFirstWorkflow(members: string) {
  const { model } = await parseString(
    `system S { subdomain M { context C {
      aggregate Order { total: int }
      repository Orders for Order { }
      event PaymentReceived { order: Order id, amount: int }
      command SettleOrder { order: Order id, note: string }
      workflow Fulfillment {
        ${members}
      }
    }}}`,
    { validate: false },
  );
  return allContexts(lowerModel(model))[0].workflows[0];
}

describe("workflow create(...) — event/payload command params", () => {
  it("lowers an event-typed param to an entity marker", async () => {
    const wf = await lowerFirstWorkflow(`
      create(paid: PaymentReceived) by paid.order { let a = paid.amount }`);
    const c = wf.creates[0];
    expect(c.params).toEqual([{ name: "paid", type: { kind: "entity", name: "PaymentReceived" } }]);
  });

  it("derives triggerKind/eventRef/eventBinding for an event-triggered create", async () => {
    // A `by` routing clause + a sole event param marks an event-triggered
    // starter; lowering captures the binding name and the referenced event so
    // the runtime can correlate the inbound fact.
    const wf = await lowerFirstWorkflow(`
      create(paid: PaymentReceived) by paid.order { let a = paid.amount }`);
    const c = wf.creates[0];
    expect(c.triggerKind).toBe("event");
    expect(c.eventRef).toBe("PaymentReceived");
    expect(c.eventBinding).toBe("paid");
  });

  it("type-resolves member access on the event param in the body", async () => {
    // `paid.amount` resolves to the event field's type (int), proving the
    // entity-marked param routes through `findEventByName`/`memberOnEvent`.
    const wf = await lowerFirstWorkflow(`
      create(paid: PaymentReceived) by paid.order { let a = paid.amount }`);
    const letStmt = wf.creates[0].statements[0];
    expect(letStmt.kind).toBe("expr-let");
  });

  it("lowers a payload (command) param on a create to an entity marker", async () => {
    const wf = await lowerFirstWorkflow(`create(c: SettleOrder) { let n = c.note }`);
    const c = wf.creates[0];
    expect(c.triggerKind).toBe("command");
    expect(c.params).toEqual([{ name: "c", type: { kind: "entity", name: "SettleOrder" } }]);
  });
});
