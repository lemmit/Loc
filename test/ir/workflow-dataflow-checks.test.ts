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
// `test/language/validation/validation.test.ts`.  `name-collision` /
// `create-unknown-aggregate` are preempted by earlier checks
// (`loom.duplicate-workflow`, correlation resolution), and `unknown-repository`
// / `run-unknown-repository` are unreachable (an unknown repo name lowers to a
// generic `expr-let`, never the `repo-let`/`repo-run` those arms switch on) —
// all four handed to M-T9.8 as unemittable.  The six below are the reachable,
// previously-untested remainder.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/index.js";

// A non-event `create(id)` workflow — avoids the event-triggered
// correlation-required noise so the injected data-flow error is isolated.
const src = (body: string) => `
  system S { subdomain M { context C {
    enum Priority { Low, High }
    event Done { at: datetime }
    aggregate Order {
      total: int
      priority: Priority
      operation bump() { total := total + 1 }
    }
    aggregate Widget {
      size: int
      operation grow() { size := size + 1 }
    }
    criterion HighP of Order = priority == High
    criterion BigW of Widget = size > 10
    retrieval OrderQ(p: Priority) of Order { where: HighP }
    retrieval WidgetQ of Widget { where: BigW }
    repository Orders for Order { }
    repository Widgets for Widget { }
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

  it("flags a `Repo.run(<Retrieval>)` whose retrieval is over another aggregate", async () => {
    // WidgetQ is `of Widget`, but Orders is a repository for Order.
    expect(await codes("let xs = Orders.run(WidgetQ())")).toContain(
      "loom.workflow-run-retrieval-mismatch",
    );
  });

  it("accepts a `Repo.run(<Retrieval>)` whose retrieval matches the repository", async () => {
    expect(await codes("let xs = Orders.run(OrderQ(High))")).not.toContain(
      "loom.workflow-run-retrieval-mismatch",
    );
  });

  it("flags a `for … in` op-call on an unknown binding", async () => {
    const c = await codes(
      "let xs = Orders.run(OrderQ(High))\n        for o in xs { ghost.bump() }",
    );
    expect(c).toContain("loom.workflow-foreach-unknown-binding");
  });

  // M-T9.34 drain finding: `checkBranchOpCalls` validated an if-let branch's
  // op-call targets against the OUTER binding map only, so a `let` declared
  // inside that branch was invisible and its own deref was reported unknown —
  // while every backend emitter already walks into the branch bodies and wires
  // the repository for exactly this shape (see
  // `test/generator/dotnet/dotnet-workflow-repo-find.test.ts`, "injects a
  // repository first used inside an if-let branch body").  The validator was
  // the side that was wrong.
  it("accepts an op-call on a binding declared INSIDE the if-let branch", async () => {
    const c = await codes(
      "if let o = Orders.find(HighP) { let w = Widgets.getById(orderId)  w.grow() }",
    );
    expect(c).not.toContain("loom.workflow-foreach-unknown-binding");
  });

  it("still flags an op-call on a name no branch ever bound", async () => {
    const c = await codes(
      "if let o = Orders.find(HighP) { let w = Widgets.getById(orderId)  ghost.grow() }",
    );
    expect(c).toContain("loom.workflow-foreach-unknown-binding");
  });

  it("does not leak a branch-local binding past the branch that declared it", async () => {
    const c = await codes(
      "if let o = Orders.find(HighP) { let w = Widgets.getById(orderId) } else { w.grow() }",
    );
    expect(c).toContain("loom.workflow-foreach-unknown-binding");
  });

  it("accepts a `for … in` op-call on the loop variable", async () => {
    const c = await codes("let xs = Orders.run(OrderQ(High))\n        for o in xs { o.bump() }");
    expect(c).not.toContain("loom.workflow-foreach-unknown-binding");
  });
});
