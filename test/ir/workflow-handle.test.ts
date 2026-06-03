// Named workflow command handlers — `handle name(params) { … }`
// (workflow-and-applier.md A2-S5c).

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/index.js";

async function lowerFirstWorkflow(body: string) {
  const { model } = await parseString(
    `system S { subdomain M { context C {
      aggregate Order { total: int }
      repository Orders for Order
      event PaymentReceived { order: Order id, amount: int }
      command SettleOrder { order: Order id, note: string }
      ${body}
    }}}`,
    { validate: false },
  );
  return allContexts(lowerModel(model))[0].workflows[0];
}

describe("workflow handle(...) command handlers — lowering", () => {
  it("lowers a handle member with name, params and body", async () => {
    const wf = await lowerFirstWorkflow(`
      workflow Ops {
        handle bump(n: int) { let x = n }
      }`);
    expect(wf.handlers).toHaveLength(1);
    const [h] = wf.handlers ?? [];
    expect(h.name).toBe("bump");
    expect(h.params).toEqual([{ name: "n", type: { kind: "primitive", name: "int" } }]);
    expect(h.statements).toHaveLength(1);
    expect(h.statements[0].kind).toBe("expr-let");
  });

  it("derives exit-saves for a handle that loads + operates on an aggregate", async () => {
    const wf = await lowerFirstWorkflow(`
      workflow Ops {
        handle settle(orderId: Order id) {
          let o = Orders.getById(orderId)
        }
      }`);
    const [h] = wf.handlers ?? [];
    expect(h.statements[0].kind).toBe("repo-let");
  });

  it("supports multiple handles (multi-command saga)", async () => {
    const wf = await lowerFirstWorkflow(`
      workflow Ops {
        handle a(n: int) { let x = n }
        handle b(m: int) { let y = m }
      }`);
    expect(wf.handlers?.map((h) => h.name)).toEqual(["a", "b"]);
  });

  it("leaves handlers undefined when none declared", async () => {
    const wf = await lowerFirstWorkflow(`workflow Ops { create() { let z = 1 } }`);
    expect(wf.handlers).toBeUndefined();
  });

  it("lowers a handle whose param is a payload (command) type", async () => {
    // `handle settle(c: SettleOrder)` — the command payload binds as an
    // entity-marked param (payloads aren't a distinct TypeIR kind), and a
    // body access `c.note` type-resolves through the payload's field set.
    const wf = await lowerFirstWorkflow(`
      workflow Ops {
        handle settle(c: SettleOrder) { let n = c.note }
      }`);
    const [h] = wf.handlers ?? [];
    expect(h.name).toBe("settle");
    expect(h.params).toEqual([{ name: "c", type: { kind: "entity", name: "SettleOrder" } }]);
    expect(h.statements[0].kind).toBe("expr-let");
  });
});

describe("workflow handle(...) — event-sourced discipline", () => {
  it("rejects direct mutation in a handle body of an event-sourced workflow", async () => {
    const { errors } = await parseString(
      `system S { subdomain M { context C {
        aggregate Order { total: int }
        event PaymentReceived { order: Order id, amount: int }
        workflow Es eventSourced {
          count: int
          handle touch(n: int) { count := n }
        }
      }}}`,
    );
    expect(errors.some((e) => /must not mutate 'this' directly/.test(e))).toBe(true);
  });
});
