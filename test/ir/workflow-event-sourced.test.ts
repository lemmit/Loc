// Event-sourced workflows + `apply(...)` folds (workflow-and-applier.md A2-S5b).
// A workflow marked `eventSourced` folds its events into state via appliers,
// exactly like an event-sourced aggregate; handler bodies are emit-only.

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/index.js";

async function lowerFirstWorkflow(body: string) {
  const { model } = await parseString(
    `system S { subdomain M { context C {
      aggregate Order { total: int }
      event PaymentReceived { order: Order id, amount: int }
      event OrderCounted { order: Order id }
      ${body}
    }}}`,
    { validate: false },
  );
  return allContexts(lowerModel(model))[0].workflows[0];
}

describe("event-sourced workflows — lowering", () => {
  it("lowers the `eventSourced` flag and apply(...) members", async () => {
    const wf = await lowerFirstWorkflow(`
      workflow Tally eventSourced() {
        orderId: Order id
        count: int
        apply(paid: PaymentReceived) { count := paid.amount }
      }`);
    expect(wf.eventSourced).toBe(true);
    expect(wf.appliers).toHaveLength(1);
    expect(wf.appliers?.[0].event).toBe("PaymentReceived");
    expect(wf.appliers?.[0].param).toBe("paid");
  });

  it("folds an applier body into workflow state (count := paid.amount)", async () => {
    const wf = await lowerFirstWorkflow(`
      workflow Tally eventSourced() {
        orderId: Order id
        count: int
        apply(paid: PaymentReceived) { count := paid.amount }
      }`);
    const stmt = wf.appliers?.[0].statements[0];
    expect(stmt?.kind).toBe("assign");
    const value = stmt?.kind === "assign" ? stmt.value : undefined;
    expect(value?.kind).toBe("member");
    if (value?.kind === "member") {
      expect(value.member).toBe("amount");
      expect(value.memberType).toEqual({ kind: "primitive", name: "int" });
    }
  });

  it("leaves eventSourced false and appliers undefined for a plain workflow", async () => {
    const wf = await lowerFirstWorkflow(`workflow Plain() { let x = 1 }`);
    expect(wf.eventSourced).toBe(false);
    expect(wf.appliers).toBeUndefined();
  });
});

describe("event-sourced workflows — discipline validation", () => {
  const ctx = (body: string) =>
    `system S { subdomain M { context C {
      aggregate Order { total: int }
      event PaymentReceived { order: Order id, amount: int }
      event OrderCounted { order: Order id }
      ${body}
    }}}`;

  it("rejects apply(...) on a non-event-sourced workflow", async () => {
    const { errors } = await parseString(
      ctx(`workflow Bad() { apply(paid: PaymentReceived) { let x = paid.amount } }`),
    );
    expect(errors.some((e) => /not event-sourced/.test(e))).toBe(true);
  });

  it("rejects an emitted event with no applier", async () => {
    const { errors } = await parseString(
      ctx(`workflow Emit eventSourced() {
        orderId: Order id
        on(paid: PaymentReceived) by paid.order { emit OrderCounted { order: paid.order } }
      }`),
    );
    expect(errors.some((e) => /no applier folds it/.test(e))).toBe(true);
  });

  it("accepts an emitted event with a matching applier", async () => {
    const { errors } = await parseString(
      ctx(`workflow Ok eventSourced() {
        orderId: Order id
        count: int
        on(paid: PaymentReceived) by paid.order { emit OrderCounted { order: paid.order } }
        apply(c: OrderCounted) { count := 1 }
      }`),
    );
    expect(errors).toEqual([]);
  });

  it("rejects two appliers for the same event", async () => {
    const { errors } = await parseString(
      ctx(`workflow Dup eventSourced() {
        count: int
        apply(paid: PaymentReceived) { count := paid.amount }
        apply(p2: PaymentReceived) { count := p2.amount }
      }`),
    );
    expect(errors.some((e) => /more than one applier/.test(e))).toBe(true);
  });

  it("rejects direct mutation in an event-sourced handler body", async () => {
    const { errors } = await parseString(
      ctx(`workflow Mut eventSourced() {
        orderId: Order id
        count: int
        on(paid: PaymentReceived) by paid.order { count := paid.amount }
      }`),
    );
    expect(errors.some((e) => /must not mutate 'this' directly/.test(e))).toBe(true);
  });
});
