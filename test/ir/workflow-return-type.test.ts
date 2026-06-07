import { describe, expect, it } from "vitest";
import { computeWorkflowReturnType } from "../../src/ir/enrich/enrichments.js";
import type { TypeIR, WorkflowIR, WorkflowStmtIR } from "../../src/ir/types/loom-ir.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/index.js";

// Slice 4 (static-analysis-followups.md): the tail-position type derivation.
// `computeWorkflowReturnType` mirrors the backends' `last-bind` return rule —
// the value of the last `factory-let` / `repo-let` / `expr-let` — and falls
// back to `undefined` (the conservative `{:ok, term()}` arm) whenever the tail
// isn't a single, narrowable bind.

const INT: TypeIR = { kind: "primitive", name: "int" };

function wf(statements: WorkflowStmtIR[]): WorkflowIR {
  return {
    name: "doThing",
    params: [],
    transactional: false,
    statements,
    savesAtExit: [],
    creates: [],
    eventSourced: false,
  };
}

describe("computeWorkflowReturnType — tail bind", () => {
  it("a factory-let tail yields the created aggregate's entity type", () => {
    const out = computeWorkflowReturnType(
      wf([{ kind: "factory-let", name: "order", aggName: "Order", fields: [] }]),
    );
    expect(out).toEqual({ kind: "entity", name: "Order" });
  });

  it("a repo-let tail yields its (option-stripped) return type", () => {
    const out = computeWorkflowReturnType(
      wf([
        {
          kind: "repo-let",
          name: "o",
          repoName: "Orders",
          aggName: "Order",
          method: "getById",
          args: [],
          returnType: { kind: "optional", inner: { kind: "entity", name: "Order" } },
        },
      ]),
    );
    expect(out).toEqual({ kind: "entity", name: "Order" });
  });

  it("an expr-let tail yields its declared type", () => {
    const out = computeWorkflowReturnType(
      wf([
        {
          kind: "expr-let",
          name: "n",
          type: INT,
          expr: { kind: "literal", lit: "int", value: "1" },
        },
      ]),
    );
    expect(out).toEqual(INT);
  });

  it("picks the LAST value bind, skipping a trailing op-call (binds `_`)", () => {
    const out = computeWorkflowReturnType(
      wf([
        { kind: "factory-let", name: "order", aggName: "Order", fields: [] },
        { kind: "op-call", target: "order", aggName: "Order", op: "confirm", args: [] },
      ]),
    );
    // op-call doesn't bind a usable value — the factory-let stays the return.
    expect(out).toEqual({ kind: "entity", name: "Order" });
  });
});

describe("computeWorkflowReturnType — conservative fallback", () => {
  it("undefined for a body with no value bind", () => {
    expect(
      computeWorkflowReturnType(
        wf([{ kind: "op-call", target: "order", aggName: "Order", op: "confirm", args: [] }]),
      ),
    ).toBeUndefined();
  });

  it("undefined for an empty body", () => {
    expect(computeWorkflowReturnType(wf([]))).toBeUndefined();
  });

  it("undefined when the body ends in a loop/sequence (repo-run present)", () => {
    expect(
      computeWorkflowReturnType(
        wf([
          {
            kind: "repo-run",
            name: "xs",
            repoName: "Orders",
            aggName: "Order",
            retrievalName: "Recent",
            retrievalArgs: [],
            returnType: { kind: "array", element: { kind: "entity", name: "Order" } },
          },
        ]),
      ),
    ).toBeUndefined();
  });

  it("undefined for a transport-only tail type (union not narrowable)", () => {
    const union: TypeIR = {
      kind: "union",
      variants: [
        { kind: "entity", name: "Order" },
        { kind: "entity", name: "Cancel" },
      ],
    };
    expect(
      computeWorkflowReturnType(
        wf([
          {
            kind: "expr-let",
            name: "r",
            type: union,
            expr: { kind: "literal", lit: "null", value: "null" },
          },
        ]),
      ),
    ).toBeUndefined();
  });
});

describe("enrichLoomModel — populates workflow.returnType", () => {
  it("a workflow whose body creates an aggregate carries that entity returnType", async () => {
    // buildLoomModel runs the full parse → lower → enrich path, so the
    // workflow comes back already carrying its derived returnType.
    const model = await buildLoomModel(`
      context Sales {
        aggregate Order {
          customerId: string
        }
        repository Orders for Order { }
        workflow PlaceOrder {
          create(customerId: string) {
            let order = Order.create({ customerId: customerId })
          }
        }
      }
    `);
    const ctx = allContexts(model).find((c) => c.name === "Sales")!;
    const placeOrder = ctx.workflows.find((w) => w.name === "PlaceOrder")!;
    expect(placeOrder.returnType).toEqual({ kind: "entity", name: "Order" });
  });
});
