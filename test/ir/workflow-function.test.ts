// Workflow `function` — an expression-bodied, private pure helper (the
// aggregate-parity member).  A workflow body is not a class, so each backend
// emits these as per-workflow-scoped MODULE helpers; a call to one lowers to
// `callKind: "workflow-fn"` carrying the enclosing workflow name so backends
// render the scoped, per-backend-cased name (`<wf><fn>`).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/index.js";

async function irErrorCodes(body: string): Promise<string[]> {
  const { model } = await parseString(
    `system S { subdomain M { context C {
      aggregate Order { total: int  priority: int  sla: int }
      repository Orders for Order
      ${body}
    }}}`,
    { validate: false },
  );
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
}

async function lowerFirstWorkflow(body: string) {
  const { model } = await parseString(
    `system S { subdomain M { context C {
      aggregate Order { total: int  priority: int  sla: int }
      repository Orders for Order
      ${body}
    }}}`,
    { validate: false },
  );
  return allContexts(lowerModel(model))[0].workflows[0];
}

describe("workflow function(...) — lowering + call model", () => {
  it("lowers function members onto WorkflowIR.functions", async () => {
    const wf = await lowerFirstWorkflow(`
      workflow Ops {
        function slaDays(priority: int): int = priority > 5 ? 1 : 5
        create(priority: int) { let sla = slaDays(priority) }
      }`);
    expect(wf.functions).toHaveLength(1);
    const [fn] = wf.functions ?? [];
    expect(fn.name).toBe("slaDays");
    expect(fn.params).toEqual([{ name: "priority", type: { kind: "primitive", name: "int" } }]);
    expect(fn.returnType).toEqual({ kind: "primitive", name: "int" });
    expect("expr" in fn.body).toBe(true);
  });

  it("resolves a call to a workflow-fn call (scoped, not this-method, not free)", async () => {
    const wf = await lowerFirstWorkflow(`
      workflow Ops {
        function slaDays(priority: int): int = priority > 5 ? 1 : 5
        create(priority: int) { let sla = slaDays(priority) }
      }`);
    const stmt = wf.creates[0].statements.find(
      (s): s is Extract<typeof s, { kind: "expr-let" }> => s.kind === "expr-let",
    );
    expect(stmt?.expr.kind).toBe("call");
    const call = stmt?.expr as Extract<NonNullable<typeof stmt>["expr"], { kind: "call" }>;
    expect(call.callKind).toBe("workflow-fn");
    expect(call.name).toBe("slaDays");
    // Carries the enclosing workflow name so backends render `<wf><fn>`.
    expect(call.wfScope).toBe("Ops");
  });

  it("types a workflow-fn call's result from the function's declared return", async () => {
    const wf = await lowerFirstWorkflow(`
      workflow Ops {
        function slaDays(priority: int): int = priority > 5 ? 1 : 5
        create(priority: int) { let sla = slaDays(priority) }
      }`);
    const stmt = wf.creates[0].statements.find(
      (s): s is Extract<typeof s, { kind: "expr-let" }> => s.kind === "expr-let",
    );
    expect(stmt?.type).toEqual({ kind: "primitive", name: "int" });
  });

  it("leaves functions undefined when none declared", async () => {
    const wf = await lowerFirstWorkflow(`workflow Ops { create() { let z = 1 } }`);
    expect(wf.functions).toBeUndefined();
  });
});

describe("workflow function(...) — pure block body (parity with aggregate fns)", () => {
  it("lowers a block-bodied workflow function", async () => {
    const wf = await lowerFirstWorkflow(`
      workflow Ops {
        function slaDays(priority: int): int {
          let expedited = priority > 5
          return expedited ? 1 : 5
        }
        create(priority: int) { let sla = slaDays(priority) }
      }`);
    const [fn] = wf.functions ?? [];
    expect("stmts" in fn.body).toBe(true);
  });

  it("accepts a pure block body", async () => {
    const codes = await irErrorCodes(`
      workflow Ops {
        function slaDays(priority: int): int {
          let expedited = priority > 5
          precondition priority >= 0
          return expedited ? 1 : 5
        }
        create(priority: int) { let sla = slaDays(priority) }
      }`);
    expect(codes).not.toContain("loom.function-block-impure");
  });

  it("rejects an impure block body — an `emit` (loom.function-block-impure)", async () => {
    const codes = await irErrorCodes(`
      event Rejected { at: datetime }
      workflow Ops {
        function bad(priority: int): int {
          emit Rejected { at: now() }
          return priority
        }
        create(priority: int) { let sla = bad(priority) }
      }`);
    expect(codes).toContain("loom.function-block-impure");
  });
});

describe("workflow function(...) — state-access gate (loom.workflow-function-uses-state)", () => {
  it("accepts a function that is pure over its parameters", async () => {
    const codes = await irErrorCodes(`
      workflow Ops {
        sagaId: Order id
        function slaDays(priority: int): int = priority > 5 ? 1 : 5
        create(priority: int) { let sla = slaDays(priority) }
      }`);
    expect(codes).not.toContain("loom.workflow-function-uses-state");
  });

  it("rejects a function that reads the workflow's own state (`this`)", async () => {
    // `attempts` is a workflow state field; a module-scoped helper has no `this`.
    const codes = await irErrorCodes(`
      workflow Ops {
        sagaId: Order id
        attempts: int
        function overLimit(): bool = attempts > 3
        create(orderId: Order id) { let x = overLimit() }
      }`);
    expect(codes).toContain("loom.workflow-function-uses-state");
  });
});
