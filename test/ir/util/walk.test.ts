// Property test for the shared IR child-walker (`src/ir/util/walk.ts`).
//
// The whole point of the walker is exhaustiveness: every child slot of every
// `ExprIR` / `StmtIR` / `WorkflowStmtIR` kind must be visited exactly once.
// This test pins that by building, for EVERY kind of each union, a minimal node
// whose child slots hold distinct sentinel objects, then asserting the walker
// hands back exactly those sentinels (by reference).
//
// Completeness is enforced at the type level, mirroring `print-completeness`:
// each sample table is a `Record<Union["kind"], …>`, so a newly-added IR kind
// makes the table a `tsc` error until its sample (and thus its child wiring in
// `walk.ts`) is added.  Combined with the `never`-checked switches in `walk.ts`
// itself, a new kind fails in two independent places until wired.

import { describe, expect, it } from "vitest";
import type { ExprIR, StmtIR, TypeIR, WorkflowStmtIR } from "../../../src/ir/types/loom-ir.js";
import {
  walkExprChildren,
  walkStmtChildren,
  walkWorkflowStmtChildren,
} from "../../../src/ir/util/walk.js";

// A fresh, reference-unique sentinel expression per call.
let counter = 0;
const sent = (): ExprIR => ({ kind: "literal", lit: "int", value: `s${counter++}` });
const sentStmt = (): StmtIR => ({ kind: "expression", expr: sent() });
const sentWf = (): WorkflowStmtIR => ({ kind: "precondition", expr: sent(), source: "" });

const T: TypeIR = { kind: "primitive", name: "string" };
const ENTITY: TypeIR = { kind: "entity", name: "X" };

/** Assert `actual` is exactly `expected` — same references, any order. */
function sameRefs<A>(actual: A[], expected: A[]): void {
  expect(actual.length).toBe(expected.length);
  for (const e of expected) expect(actual).toContain(e);
}

interface ExprCase {
  node: ExprIR;
  exprChildren: ExprIR[];
  stmtChildren: StmtIR[];
}

/** One sample per `ExprIR.kind`.  `Record<ExprIR["kind"], …>` ⇒ a new kind is
 *  a compile error here until its child slots are declared. */
function exprCases(): Record<ExprIR["kind"], () => ExprCase> {
  return {
    literal: () => ({
      node: { kind: "literal", lit: "int", value: "1" },
      exprChildren: [],
      stmtChildren: [],
    }),
    this: () => ({ node: { kind: "this" }, exprChildren: [], stmtChildren: [] }),
    id: () => ({ node: { kind: "id" }, exprChildren: [], stmtChildren: [] }),
    ref: () => ({
      node: { kind: "ref", name: "x", refKind: "param" },
      exprChildren: [],
      stmtChildren: [],
    }),
    "action-ref": () => ({
      node: { kind: "action-ref", actionName: "a" },
      exprChildren: [],
      stmtChildren: [],
    }),
    member: () => {
      const r = sent();
      return {
        node: { kind: "member", receiver: r, member: "m", receiverType: T, memberType: T },
        exprChildren: [r],
        stmtChildren: [],
      };
    },
    "method-call": () => {
      const r = sent();
      const a0 = sent();
      const a1 = sent();
      return {
        node: {
          kind: "method-call",
          receiver: r,
          member: "m",
          args: [a0, a1],
          receiverType: T,
          isCollectionOp: false,
        },
        exprChildren: [r, a0, a1],
        stmtChildren: [],
      };
    },
    call: () => {
      const a0 = sent();
      const a1 = sent();
      const styleVal = sent();
      return {
        node: {
          kind: "call",
          callKind: "function",
          name: "f",
          args: [a0, a1],
          style: { entries: [{ key: "background", value: styleVal }] },
        },
        exprChildren: [a0, a1, styleVal],
        stmtChildren: [],
      };
    },
    lambda: () => {
      const body = sent();
      const blockStmt = sentStmt();
      return {
        node: { kind: "lambda", param: "x", body, block: [blockStmt] },
        exprChildren: [body],
        stmtChildren: [blockStmt],
      };
    },
    new: () => {
      const v = sent();
      return {
        node: { kind: "new", partName: "P", fields: [{ name: "a", value: v }] },
        exprChildren: [v],
        stmtChildren: [],
      };
    },
    object: () => {
      const v = sent();
      return {
        node: { kind: "object", fields: [{ name: "a", value: v }] },
        exprChildren: [v],
        stmtChildren: [],
      };
    },
    list: () => {
      const a = sent();
      const b = sent();
      return { node: { kind: "list", elements: [a, b] }, exprChildren: [a, b], stmtChildren: [] };
    },
    paren: () => {
      const inner = sent();
      return { node: { kind: "paren", inner }, exprChildren: [inner], stmtChildren: [] };
    },
    unary: () => {
      const operand = sent();
      return {
        node: { kind: "unary", op: "-", operand },
        exprChildren: [operand],
        stmtChildren: [],
      };
    },
    binary: () => {
      const l = sent();
      const r = sent();
      return {
        node: { kind: "binary", op: "+", left: l, right: r },
        exprChildren: [l, r],
        stmtChildren: [],
      };
    },
    ternary: () => {
      const c = sent();
      const t = sent();
      const o = sent();
      return {
        // biome-ignore lint/suspicious/noThenProperty: `then` is the ternary ExprIR's real field name
        node: { kind: "ternary", cond: c, then: t, otherwise: o },
        exprChildren: [c, t, o],
        stmtChildren: [],
      };
    },
    convert: () => {
      const v = sent();
      return {
        node: { kind: "convert", target: "string", from: undefined, value: v },
        exprChildren: [v],
        stmtChildren: [],
      };
    },
    match: () => {
      const subject = sent();
      const armCond = sent();
      const armVal = sent();
      const variantVal = sent();
      const otherwise = sent();
      return {
        node: {
          kind: "match",
          subject,
          arms: [{ cond: armCond, value: armVal }],
          variantArms: [{ varType: ENTITY, value: variantVal }],
          otherwise,
        },
        exprChildren: [subject, armCond, armVal, variantVal, otherwise],
        stmtChildren: [],
      };
    },
  };
}

interface StmtCase {
  node: StmtIR;
  exprChildren: ExprIR[];
}

function stmtCases(): Record<StmtIR["kind"], () => StmtCase> {
  return {
    precondition: () => {
      const e = sent();
      return { node: { kind: "precondition", expr: e, source: "" }, exprChildren: [e] };
    },
    requires: () => {
      const e = sent();
      return { node: { kind: "requires", expr: e, source: "" }, exprChildren: [e] };
    },
    let: () => {
      const e = sent();
      return { node: { kind: "let", name: "x", expr: e, type: T }, exprChildren: [e] };
    },
    assign: () => {
      const v = sent();
      return {
        node: { kind: "assign", target: { segments: ["a"] }, value: v, targetType: T },
        exprChildren: [v],
      };
    },
    add: () => {
      const v = sent();
      return {
        node: {
          kind: "add",
          target: { segments: ["a"] },
          value: v,
          elementType: T,
          collection: true,
        },
        exprChildren: [v],
      };
    },
    remove: () => {
      const v = sent();
      return {
        node: {
          kind: "remove",
          target: { segments: ["a"] },
          value: v,
          elementType: T,
          collection: true,
        },
        exprChildren: [v],
      };
    },
    emit: () => {
      const v = sent();
      return {
        node: { kind: "emit", eventName: "E", fields: [{ name: "a", value: v }] },
        exprChildren: [v],
      };
    },
    call: () => {
      const a0 = sent();
      const a1 = sent();
      return {
        node: { kind: "call", target: "function", name: "f", args: [a0, a1] },
        exprChildren: [a0, a1],
      };
    },
    expression: () => {
      const e = sent();
      return { node: { kind: "expression", expr: e }, exprChildren: [e] };
    },
    return: () => {
      const v = sent();
      return { node: { kind: "return", value: v }, exprChildren: [v] };
    },
  };
}

interface WfCase {
  node: WorkflowStmtIR;
  exprChildren: ExprIR[];
  wfChildren: WorkflowStmtIR[];
}

function wfCases(): Record<WorkflowStmtIR["kind"], () => WfCase> {
  const arr: TypeIR = { kind: "array", element: ENTITY };
  return {
    precondition: () => {
      const e = sent();
      return {
        node: { kind: "precondition", expr: e, source: "" },
        exprChildren: [e],
        wfChildren: [],
      };
    },
    requires: () => {
      const e = sent();
      return { node: { kind: "requires", expr: e, source: "" }, exprChildren: [e], wfChildren: [] };
    },
    emit: () => {
      const v = sent();
      return {
        node: { kind: "emit", eventName: "E", fields: [{ name: "a", value: v }] },
        exprChildren: [v],
        wfChildren: [],
      };
    },
    "factory-let": () => {
      const v = sent();
      return {
        node: { kind: "factory-let", name: "x", aggName: "X", fields: [{ name: "a", value: v }] },
        exprChildren: [v],
        wfChildren: [],
      };
    },
    "repo-let": () => {
      const a0 = sent();
      const a1 = sent();
      return {
        node: {
          kind: "repo-let",
          name: "x",
          repoName: "Xs",
          aggName: "X",
          method: "getById",
          args: [a0, a1],
          returnType: ENTITY,
        },
        exprChildren: [a0, a1],
        wfChildren: [],
      };
    },
    "expr-let": () => {
      const e = sent();
      return {
        node: { kind: "expr-let", name: "x", type: T, expr: e },
        exprChildren: [e],
        wfChildren: [],
      };
    },
    "repo-run": () => {
      const a0 = sent();
      const off = sent();
      const lim = sent();
      return {
        node: {
          kind: "repo-run",
          name: "xs",
          repoName: "Xs",
          aggName: "X",
          retrievalName: "R",
          retrievalArgs: [a0],
          page: { offset: off, limit: lim },
          returnType: arr,
        },
        exprChildren: [a0, off, lim],
        wfChildren: [],
      };
    },
    "op-call": () => {
      const a0 = sent();
      return {
        node: { kind: "op-call", target: "x", aggName: "X", op: "doIt", args: [a0] },
        exprChildren: [a0],
        wfChildren: [],
      };
    },
    "for-each": () => {
      const it = sent();
      const b0 = sentWf();
      return {
        node: {
          kind: "for-each",
          var: "o",
          varAggName: "X",
          iterable: it,
          body: [b0],
          savesPerIteration: [],
        },
        exprChildren: [it],
        wfChildren: [b0],
      };
    },
    "resource-call": () => {
      const call = sent();
      return { node: { kind: "resource-call", call }, exprChildren: [call], wfChildren: [] };
    },
    "domain-service-call": () => {
      const call = sent();
      return {
        node: { kind: "domain-service-call", service: "S", op: "run", call },
        exprChildren: [call],
        wfChildren: [],
      };
    },
    "if-let": () => {
      const a0 = sent();
      const t0 = sentWf();
      const e0 = sentWf();
      return {
        node: {
          kind: "if-let",
          var: "x",
          repoName: "Xs",
          aggName: "X",
          retrievalName: "R",
          retrievalArgs: [a0],
          synthCriterion: { name: "C" },
          thenBody: [t0],
          elseBody: [e0],
          savesInThen: [],
          savesInElse: [],
        },
        exprChildren: [a0],
        wfChildren: [t0, e0],
      };
    },
    assign: () => {
      const v = sent();
      return {
        node: { kind: "assign", target: { segments: ["a"] }, value: v, targetType: T },
        exprChildren: [v],
        wfChildren: [],
      };
    },
  };
}

describe("walkExprChildren — every ExprIR kind's children are visited once", () => {
  for (const [kind, make] of Object.entries(exprCases())) {
    it(`visits the children of \`${kind}\``, () => {
      const { node, exprChildren, stmtChildren } = make();
      const gotExpr: ExprIR[] = [];
      const gotStmt: StmtIR[] = [];
      walkExprChildren(node, { expr: (c) => gotExpr.push(c), stmt: (s) => gotStmt.push(s) });
      sameRefs(gotExpr, exprChildren);
      sameRefs(gotStmt, stmtChildren);
    });
  }
});

describe("walkStmtChildren — every StmtIR kind's expression children are visited once", () => {
  for (const [kind, make] of Object.entries(stmtCases())) {
    it(`visits the children of \`${kind}\``, () => {
      const { node, exprChildren } = make();
      const got: ExprIR[] = [];
      walkStmtChildren(node, (c) => got.push(c));
      sameRefs(got, exprChildren);
    });
  }
});

describe("walkWorkflowStmtChildren — every WorkflowStmtIR kind's children are visited once", () => {
  for (const [kind, make] of Object.entries(wfCases())) {
    it(`visits the children of \`${kind}\``, () => {
      const { node, exprChildren, wfChildren } = make();
      const gotExpr: ExprIR[] = [];
      const gotWf: WorkflowStmtIR[] = [];
      walkWorkflowStmtChildren(node, {
        expr: (c) => gotExpr.push(c),
        workflowStmt: (c) => gotWf.push(c),
      });
      sameRefs(gotExpr, exprChildren);
      sameRefs(gotWf, wfChildren);
    });
  }
});
