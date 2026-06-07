// Workflow `on(e: Event) by <expr>` correlation typing (workflow-and-applier.md
// A2-S3).  Covers lowering the `by` routing expression, the type-mismatch rule,
// and name-match inference when `by` is omitted.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/index.js";

function src(reactors: string): string {
  return `
    system S { subdomain M { context C {
      aggregate Order { total: int }
      aggregate Payment { amount: int }
      event PaymentReceived { order: Order id, amount: int, payment: Payment id }
      event OrderConfirmed { orderId: Order id }
      workflow Fulfillment {
        orderId: Order id
        ${reactors}
      }
    }}}`;
}

async function lowerFirstWorkflow(reactors: string) {
  const { model } = await parseString(src(reactors), { validate: false });
  return allContexts(lowerModel(model))[0].workflows[0];
}

/** Correlation diagnostics (by code) from the IR validator. */
async function diagsFor(reactors: string): Promise<string[]> {
  const { model } = await parseString(src(reactors), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter(
      (d) =>
        (d.code ?? "").startsWith("loom.correlation") ||
        (d.code ?? "").startsWith("loom.workflow-correlation"),
    )
    .map((d) => d.code ?? "");
}

describe("workflow by-correlation — lowering", () => {
  it("lowers `by paid.order` into the reactor's correlation expr", async () => {
    const wf = await lowerFirstWorkflow(
      `on(paid: PaymentReceived) by paid.order { let x = paid.amount }`,
    );
    const corr = wf.subscriptions?.[0].correlation;
    expect(corr?.kind).toBe("member");
    if (corr?.kind === "member") {
      expect(corr.member).toBe("order");
      expect(corr.receiverType).toEqual({ kind: "entity", name: "PaymentReceived" });
      expect(corr.memberType).toEqual({ kind: "id", targetName: "Order", valueType: "guid" });
    }
  });

  it("leaves correlation undefined when `by` is omitted", async () => {
    const wf = await lowerFirstWorkflow(`on(c: OrderConfirmed) { let x = c.orderId }`);
    expect(wf.subscriptions?.[0].correlation).toBeUndefined();
  });
});

describe("workflow by-correlation — validation", () => {
  it("accepts a `by` expr whose id type matches the correlation field", async () => {
    const diags = await diagsFor(`on(paid: PaymentReceived) by paid.order { let x = paid.amount }`);
    expect(diags).toEqual([]);
  });

  it("rejects a `by` expr of a different id type (rule 12)", async () => {
    const diags = await diagsFor(
      `on(paid: PaymentReceived) by paid.payment { let x = paid.amount }`,
    );
    expect(diags).toContain("loom.correlation-type-mismatch");
  });

  it("rejects a `by` expr that is not an id value", async () => {
    const diags = await diagsFor(
      `on(paid: PaymentReceived) by paid.amount { let x = paid.amount }`,
    );
    expect(diags).toContain("loom.correlation-type-mismatch");
  });

  it("accepts an omitted `by` when the event has a name-matching field", async () => {
    // OrderConfirmed has `orderId`, matching the correlation field name.
    const diags = await diagsFor(`on(c: OrderConfirmed) { let x = c.orderId }`);
    expect(diags).toEqual([]);
  });

  it("rejects an omitted `by` when no event field name-matches the correlation field", async () => {
    // PaymentReceived has `order`, not `orderId` — routing can't be inferred.
    const diags = await diagsFor(`on(paid: PaymentReceived) { let x = paid.amount }`);
    expect(diags).toContain("loom.correlation-uninferrable");
  });
});

/** Every diagnostic code from the IR validator for a workflow built around the
 *  injected members. */
async function codesFor(members: string): Promise<string[]> {
  const { model } = await parseString(src(members), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code ?? "");
}

describe("event-triggered create — correlation + overlap", () => {
  it("validates an event-create `by` against the correlation field, same as a reactor", async () => {
    const ok = await diagsFor(
      `create(paid: PaymentReceived) by paid.order { let x = paid.amount }`,
    );
    expect(ok).toEqual([]);
  });

  it("rejects an event-create `by` of a different id type (rule 24 via the uniform check)", async () => {
    const diags = await diagsFor(
      `create(paid: PaymentReceived) by paid.payment { let x = paid.amount }`,
    );
    expect(diags).toContain("loom.correlation-type-mismatch");
  });

  it("flags two event-triggered creates on the same event (rule 23)", async () => {
    const codes = await codesFor(
      `create a(paid: PaymentReceived) by paid.order { let x = paid.amount }
       create b(p2: PaymentReceived) by p2.order { let x = p2.amount }`,
    );
    expect(codes).toContain("loom.event-create-overlap-workflow");
  });

  it("requires a correlation field when a workflow has only an event-create (rule 10)", async () => {
    const noIdField = `
      system S { subdomain M { context C {
        aggregate Order { total: int }
        event PaymentReceived { order: Order id, amount: int }
        workflow W {
          count: int
          create(paid: PaymentReceived) by paid.order { let x = paid.amount }
        }
      }}}`;
    const { model } = await parseString(noIdField, { validate: false });
    const codes = validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code ?? "");
    expect(codes).toContain("loom.workflow-correlation-required");
  });
});
