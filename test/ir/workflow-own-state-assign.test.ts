// Workflow own-state mutation (workflow.md, "handle = own-state mutation").
// A single-segment `field := value` (and the SCALAR compound forms
// `field += value` / `field -= value`) inside a workflow `create`/`handle`/`on`
// body whose head resolves to one of the workflow's OWN state `Property`
// members lowers to a `WorkflowStmtIR` of `kind: "assign"` (NOT the `__bad__`
// placeholder).  The compound forms rewrite `value` to a `binary` over the
// current value, riding every backend's shared expression renderer.
// Out of scope (still `__bad__` → `loom.workflow-unrecognised-statement`):
// COLLECTION own-state `+=`/`-=`, cross-aggregate writes, and deep paths.  An
// event-sourced workflow may not write its own state directly (any of
// `:=`/`+=`/`-=`) — `loom.workflow-eventsourced-assign`.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts, type WorkflowStmtIR } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/index.js";

/** A context wrapping one workflow body — events + a correlation aggregate in
 *  scope, postgres storage so the saga state row is real. */
function src(workflowBody: string): string {
  return `
    system S {
      subdomain M {
        context C {
          aggregate Order {
            status: string
            operation place() { status := "Placed"  emit OrderPlaced { order: id, at: now() } }
          }
          repository Orders for Order {}
          event OrderPlaced { order: Order id, at: datetime }
          channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
          workflow OrderFulfillment {
            ${workflowBody}
          }
        }
      }
      api A from C
      storage pg { type: postgres }
      resource sagaState { for: C, kind: state, use: pg }
      deployable d {
        platform: node
        contexts: [C]
        dataSources: [sagaState]
        serves: A
        port: 4000
      }
    }`;
}

/** Lower (no AST validation) and return the primary create body's statements. */
async function createStmts(workflowBody: string): Promise<WorkflowStmtIR[]> {
  const { model } = await parseString(src(workflowBody), { validate: false });
  const wf = allContexts(lowerModel(model))[0].workflows[0];
  return wf.statements;
}

/** IR-validate diagnostic codes (AST validation skipped to isolate the IR
 *  gates from the parallel Langium-level checks). */
async function irDiagCodes(workflowBody: string): Promise<string[]> {
  const { model } = await parseString(src(workflowBody), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .map((d) => d.code ?? "")
    .filter(Boolean);
}

describe("workflow own-state assignment — lowering", () => {
  it("lowers `attempts := 1` to an `assign` over the own-state field (not __bad__)", async () => {
    const stmts = await createStmts(
      `orderId: Order id
       attempts: int
       create(p: OrderPlaced) by p.order { attempts := 1 }`,
    );
    // No unrecognised-placeholder leaked through.
    expect(
      stmts.some((s) => s.kind === "expr-let" && (s as { name?: string }).name === "__bad__"),
    ).toBe(false);

    const assign = stmts.find((s) => s.kind === "assign");
    expect(assign, "no assign statement lowered").toBeDefined();
    if (assign?.kind !== "assign") throw new Error("unreachable");

    // Target is the single own-state segment.
    expect(assign.target.segments).toEqual(["attempts"]);
    expect(assign.targetType).toEqual({ kind: "primitive", name: "int" });

    // Value is the typed literal `1`.
    expect(assign.value.kind).toBe("literal");
    if (assign.value.kind === "literal") {
      expect(assign.value.lit).toBe("int");
      expect(assign.value.value).toBe("1");
    }
  });

  it("lowers an own-state assignment from a bound expression (attempts := attempts + 1)", async () => {
    const stmts = await createStmts(
      `orderId: Order id
       attempts: int
       create(p: OrderPlaced) by p.order { attempts := attempts + 1 }`,
    );
    const assign = stmts.find((s) => s.kind === "assign");
    expect(assign?.kind).toBe("assign");
    if (assign?.kind === "assign") {
      expect(assign.target.segments).toEqual(["attempts"]);
      expect(assign.value.kind).toBe("binary");
    }
  });
});

describe("workflow own-state assignment — validation", () => {
  it("accepts a workflow whose only own-state mutation is a `:=`", async () => {
    const diags = await irDiagCodes(
      `orderId: Order id
       attempts: int
       create(p: OrderPlaced) by p.order { attempts := 1 }`,
    );
    expect(diags).not.toContain("loom.workflow-unrecognised-statement");
    expect(diags).not.toContain("loom.workflow-eventsourced-assign");
  });

  it("accepts a scalar compound own-state mutation `attempts += 1`", async () => {
    // `+=`/`-=` on a SCALAR own-state field is a recognised form (it lowers to
    // an `assign` whose value is a `binary` over the current value) — no longer
    // the `__bad__` placeholder.
    const diags = await irDiagCodes(
      `orderId: Order id
       attempts: int
       create(p: OrderPlaced) by p.order { attempts += 1 }`,
    );
    expect(diags).not.toContain("loom.workflow-unrecognised-statement");
  });

  it("lowers `attempts += 1` to an `assign` with a `+` binary over the current value", async () => {
    const stmts = await createStmts(
      `orderId: Order id
       attempts: int
       create(p: OrderPlaced) by p.order { attempts += 1 }`,
    );
    expect(
      stmts.some((s) => s.kind === "expr-let" && (s as { name?: string }).name === "__bad__"),
    ).toBe(false);
    const assign = stmts.find((s) => s.kind === "assign");
    expect(assign?.kind).toBe("assign");
    if (assign?.kind === "assign") {
      expect(assign.target.segments).toEqual(["attempts"]);
      expect(assign.value.kind).toBe("binary");
      if (assign.value.kind === "binary") {
        expect(assign.value.op).toBe("+");
        // Left operand is the current own-state value (a `this-prop` read).
        // `toMatchObject` (not `toEqual`) since M14 stamps a real `origin` on
        // this ref — the head operand of the `+=` binary chain, lowered via
        // the recursive `lowerExpr` wrapper (src/ir/lower/lower-expr.ts).
        expect(assign.value.left).toMatchObject({
          kind: "ref",
          name: "attempts",
          refKind: "this-prop",
          type: { kind: "primitive", name: "int" },
        });
        expect(assign.value.leftType).toEqual({ kind: "primitive", name: "int" });
      }
    }
  });

  it("lowers `attempts -= 1` to an `assign` with a `-` binary", async () => {
    const stmts = await createStmts(
      `orderId: Order id
       attempts: int
       create(p: OrderPlaced) by p.order { attempts -= 1 }`,
    );
    const assign = stmts.find((s) => s.kind === "assign");
    expect(assign?.kind).toBe("assign");
    if (assign?.kind === "assign" && assign.value.kind === "binary") {
      expect(assign.value.op).toBe("-");
    }
  });

  it("rejects a cross-aggregate `:=` in a workflow body (still unrecognised)", async () => {
    const diags = await irDiagCodes(
      `orderId: Order id
       attempts: int
       create(p: OrderPlaced) by p.order {
         let o = Orders.getById(p.order)
         o.status := "Done"
       }`,
    );
    expect(diags).toContain("loom.workflow-unrecognised-statement");
  });

  it("rejects a `:=` inside an event-sourced workflow (loom.workflow-eventsourced-assign)", async () => {
    // An event-sourced workflow's state is folded only from its own emitted
    // events, so a direct `:=` is rejected at IR-validate — change state via
    // emit + a matching apply(...) clause instead.  The `eventSourced` keyword
    // is a workflow-header modifier, so this case can't ride the body-only
    // `src()` helper — it inlines the whole context.
    const ES_SRC = `
      system S {
        subdomain M {
          context C {
            aggregate Order {
              status: string
              operation place() { status := "Placed"  emit OrderPlaced { order: id, at: now() } }
            }
            repository Orders for Order {}
            event OrderPlaced { order: Order id, at: datetime }
            channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
            workflow OrderFulfillment eventSourced {
              orderId: Order id
              attempts: int
              create(p: OrderPlaced) by p.order { attempts := 1 }
            }
          }
        }
        api A from C
        storage pg { type: postgres }
        resource sagaState { for: C, kind: state, use: pg }
        deployable d {
          platform: node
          contexts: [C]
          dataSources: [sagaState]
          serves: A
          port: 4000
        }
      }`;
    const { model } = await parseString(ES_SRC, { validate: false });
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model)))
      .map((d) => d.code ?? "")
      .filter(Boolean);
    expect(diags).toContain("loom.workflow-eventsourced-assign");
  });
});
