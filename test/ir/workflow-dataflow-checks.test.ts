// Negative tests for the workflow-body data-flow checks in
// `src/ir/validate/checks/workflow-checks.ts` (phase ⑦).  These IR-level gates
// re-validate a lowered workflow statement sequence — unknown names in a
// precondition, op-calls against an unbound let / a non-existent operation, and
// an `emit` that omits a declared event field.  M-T9.19: each fires in the
// generator/emit tests only incidentally (if at all); this pins them directly
// so a no-op regression (the check silently stops emitting) is caught.
//
// Scope note (verify-first): the sibling data-flow codes are already covered —
// `emit-unknown-field` / `emit-unknown-event` by message in
// `test/language/validation/validation.test.ts`, and `name-collision` /
// `create-unknown-aggregate` are preempted by earlier checks
// (`loom.duplicate-workflow`, correlation resolution) so they never reach these
// arms.  The four below are the reachable, previously-untested remainder.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/index.js";

// A non-event `create(id)` workflow — avoids the event-triggered
// correlation-required noise so the injected data-flow error is isolated.
const src = (body: string) => `
  system S { subdomain M { context C {
    event Done { at: datetime }
    aggregate Order {
      total: int
      operation bump() { total := total + 1 }
    }
    repository Orders for Order { }
    workflow W {
      create(orderId: Order id) {
        ${body}
      }
    }
  }}}`;

/** All workflow-* diagnostic codes the IR validator emits for `body`. */
async function codes(body: string): Promise<string[]> {
  const { model } = await parseString(src(body), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .map((d) => d.code ?? "")
    .filter((c) => c.startsWith("loom.workflow-"));
}

describe("workflow-body data-flow checks (IR, phase ⑦)", () => {
  it("flags a precondition that references an unknown name", async () => {
    expect(await codes("precondition ghostName")).toContain("loom.workflow-unknown-name");
  });

  it("accepts a precondition over a bound name", async () => {
    const c = await codes("let o = Orders.getById(orderId)\n        precondition o.total >= 0");
    expect(c).not.toContain("loom.workflow-unknown-name");
  });

  it("flags an op-call on an unknown let-binding", async () => {
    expect(await codes("ghost.bump()")).toContain("loom.workflow-unknown-binding");
  });

  it("flags an op-call of an unknown operation on a bound aggregate", async () => {
    const c = await codes("let o = Orders.getById(orderId)\n        o.ghostOp()");
    expect(c).toContain("loom.workflow-unknown-operation");
  });

  it("accepts an op-call of a real operation on a bound aggregate", async () => {
    const c = await codes("let o = Orders.getById(orderId)\n        o.bump()");
    expect(c).not.toContain("loom.workflow-unknown-binding");
    expect(c).not.toContain("loom.workflow-unknown-operation");
  });

  it("flags an emit that omits a declared event field", async () => {
    expect(await codes("emit Done { }")).toContain("loom.workflow-emit-missing-field");
  });

  it("accepts an emit that provides every declared event field", async () => {
    expect(await codes("emit Done { at: now() }")).not.toContain(
      "loom.workflow-emit-missing-field",
    );
  });
});
