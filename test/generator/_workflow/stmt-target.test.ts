import { describe, expect, it } from "vitest";
import {
  collectUnionFindLets,
  renderWorkflowStmtChunks,
  renderWorkflowStmts,
  type WorkflowStmtTarget,
} from "../../../src/generator/_workflow/stmt-target.js";
import type { WorkflowStmtIR } from "../../../src/ir/types/loom-ir.js";

// The shared `WorkflowStmtIR` spine (`renderWorkflowStmts`) owns the ONLY
// dispatch + `for-each`/`if-let` recursion for the Hono/.NET/Java/Python
// workflow emitters — a bug here breaks four backends at once, but the core
// had no direct test (only incidental exercise through full generation).
// M-T9.17 slice 1.
//
// A recording mock `WorkflowStmtTarget` lets us pin dispatch, recursion,
// indentation, and chunk granularity without any real backend or IR body.

// ExprIR is required on several stmt kinds but the mock target never inspects
// it, so a shared throwaway suffices.
const EXPR: unknown = { kind: "literal" };

/** Build a `WorkflowStmtIR` of `kind` with just enough shape for the spine.
 *  The mock target reads only `st.kind` (+ nested bodies for the two
 *  recursive kinds), so unrelated required fields are cast away. */
function stmt(kind: WorkflowStmtIR["kind"], extra: Record<string, unknown> = {}): WorkflowStmtIR {
  return { kind, ...extra } as unknown as WorkflowStmtIR;
}

/** A target whose every leaf emits one marker line `"<indent><KIND>"` and
 *  records the indent it was called at.  `for-each`/`if-let` wrap the
 *  spine-rendered child lines so we can see the recursion + indent step. */
function recordingTarget(): {
  target: WorkflowStmtTarget;
  calls: { kind: string; indent: string }[];
} {
  const calls: { kind: string; indent: string }[] = [];
  const leaf =
    (kind: string) =>
    (_st: unknown, indent: string): string[] => {
      calls.push({ kind, indent });
      return [`${indent}${kind}`];
    };
  const target: WorkflowStmtTarget = {
    indentUnit: "  ",
    precondition: leaf("precondition"),
    requires: leaf("requires"),
    emit: leaf("emit"),
    factoryLet: leaf("factory-let"),
    repoLet: leaf("repo-let"),
    exprLet: leaf("expr-let"),
    assign: leaf("assign"),
    repoRun: leaf("repo-run"),
    opCall: leaf("op-call"),
    repoDelete: leaf("repo-delete"),
    resourceCall: leaf("resource-call"),
    domainServiceCall: leaf("domain-service-call"),
    forEach: (_st, indent, renderedBody) => {
      calls.push({ kind: "for-each", indent });
      return [`${indent}for {`, ...renderedBody, `${indent}}`];
    },
    ifLet: (_st, indent, renderedThen, renderedElse) => {
      calls.push({ kind: "if-let", indent });
      return [`${indent}if {`, ...renderedThen, `${indent}} else {`, ...renderedElse, `${indent}}`];
    },
  };
  return { target, calls };
}

describe("renderWorkflowStmts — shared workflow-statement spine", () => {
  it("dispatches every leaf kind to its target method, in order", () => {
    const { target, calls } = recordingTarget();
    const stmts: WorkflowStmtIR[] = [
      stmt("precondition", { expr: EXPR, source: "x" }),
      stmt("requires", { expr: EXPR, source: "x" }),
      stmt("emit", { eventName: "E", fields: [] }),
      stmt("factory-let", { name: "a", aggName: "A", fields: [] }),
      stmt("repo-let", {
        name: "b",
        repoName: "R",
        aggName: "A",
        method: "getById",
        args: [],
        returnType: { kind: "entity" },
      }),
      stmt("expr-let", { name: "c", type: { kind: "int" }, expr: EXPR }),
      stmt("assign", {}),
      stmt("repo-run", {
        name: "d",
        repoName: "R",
        aggName: "A",
        retrievalName: "q",
        retrievalArgs: [],
        returnType: { kind: "array", element: { kind: "entity" } },
      }),
      stmt("op-call", { target: "b", aggName: "A", op: "do", args: [] }),
      stmt("repo-delete", { repoName: "R", aggName: "A", entity: EXPR }),
      stmt("resource-call", { call: EXPR }),
      stmt("domain-service-call", { service: "S", op: "run", call: EXPR }),
    ];

    const lines = renderWorkflowStmts(stmts, target, "");

    expect(calls.map((c) => c.kind)).toEqual([
      "precondition",
      "requires",
      "emit",
      "factory-let",
      "repo-let",
      "expr-let",
      "assign",
      "repo-run",
      "op-call",
      "repo-delete",
      "resource-call",
      "domain-service-call",
    ]);
    // Flat one-line-per-leaf output at the top-level indent.
    expect(lines).toEqual(calls.map((c) => c.kind));
  });

  it("recurses into `for-each` bodies at indent + indentUnit", () => {
    const { target, calls } = recordingTarget();
    const stmts: WorkflowStmtIR[] = [
      stmt("for-each", {
        var: "o",
        varAggName: "Order",
        iterable: EXPR,
        savesPerIteration: [],
        body: [stmt("op-call", { target: "o", aggName: "Order", op: "ship", args: [] })],
      }),
    ];

    const lines = renderWorkflowStmts(stmts, target, "");

    // The nested op-call was rendered one indent step deeper than the loop.
    const inner = calls.find((c) => c.kind === "op-call");
    expect(inner?.indent).toBe("  ");
    expect(lines).toEqual(["for {", "  op-call", "}"]);
  });

  it("recurses into both `if-let` branches, else defaulting to empty", () => {
    const { target } = recordingTarget();
    const withElse: WorkflowStmtIR[] = [
      stmt("if-let", {
        var: "m",
        repoName: "R",
        aggName: "A",
        retrievalName: "q",
        retrievalArgs: [],
        synthCriterion: { name: "c" },
        savesInThen: [],
        savesInElse: [],
        thenBody: [stmt("emit", { eventName: "Hit", fields: [] })],
        elseBody: [stmt("emit", { eventName: "Miss", fields: [] })],
      }),
    ];
    expect(renderWorkflowStmts(withElse, target, "")).toEqual([
      "if {",
      "  emit",
      "} else {",
      "  emit",
      "}",
    ]);

    // An absent elseBody renders as an empty branch (no crash, no lines).
    const { target: t2 } = recordingTarget();
    const noElse: WorkflowStmtIR[] = [
      stmt("if-let", {
        var: "m",
        repoName: "R",
        aggName: "A",
        retrievalName: "q",
        retrievalArgs: [],
        synthCriterion: { name: "c" },
        savesInThen: [],
        savesInElse: [],
        thenBody: [stmt("emit", { eventName: "Hit", fields: [] })],
      }),
    ];
    expect(renderWorkflowStmts(noElse, t2, "")).toEqual(["if {", "  emit", "} else {", "}"]);
  });

  it("nests indentation across two recursion levels", () => {
    const { target, calls } = recordingTarget();
    const stmts: WorkflowStmtIR[] = [
      stmt("for-each", {
        var: "o",
        varAggName: "Order",
        iterable: EXPR,
        savesPerIteration: [],
        body: [
          stmt("for-each", {
            var: "l",
            varAggName: "Line",
            iterable: EXPR,
            savesPerIteration: [],
            body: [stmt("assign", {})],
          }),
        ],
      }),
    ];

    renderWorkflowStmts(stmts, target, "");

    // Each nesting level is one `indentUnit` (2 spaces) deeper: outer
    // for-each @ 0, inner @ 2, the leaf @ 4.  (Call order is bottom-up — the
    // spine renders child lines before invoking the parent's `forEach` — so
    // assert the indent-per-kind set, not the sequence.)
    expect(calls.map((c) => `${c.kind}@${c.indent.length}`).sort()).toEqual([
      "assign@4",
      "for-each@0",
      "for-each@2",
    ]);
  });
});

describe("renderWorkflowStmtChunks — per-top-level-statement granularity", () => {
  it("returns exactly one chunk per top-level statement, flattening to the same lines", () => {
    const { target } = recordingTarget();
    const stmts: WorkflowStmtIR[] = [
      stmt("emit", { eventName: "E", fields: [] }),
      stmt("for-each", {
        var: "o",
        varAggName: "Order",
        iterable: EXPR,
        savesPerIteration: [],
        body: [stmt("assign", {}), stmt("assign", {})],
      }),
    ];

    const chunks = renderWorkflowStmtChunks(stmts, target, "");

    // 2 top-level statements → 2 chunks; the for-each's multi-line body stays
    // inside its own chunk (not split across chunks).
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual(["emit"]);
    expect(chunks[1]).toEqual(["for {", "  assign", "  assign", "}"]);
    // flat === chunks.flat(), the documented equivalence.
    expect(renderWorkflowStmts(stmts, target, "")).toEqual(chunks.flat());
  });
});

describe("collectUnionFindLets", () => {
  const unionRepoLet = (name: string): WorkflowStmtIR =>
    stmt("repo-let", {
      name,
      repoName: "R",
      aggName: "A",
      method: "find",
      args: [],
      returnType: { kind: "union" },
    });
  const entityRepoLet = (name: string): WorkflowStmtIR =>
    stmt("repo-let", {
      name,
      repoName: "R",
      aggName: "A",
      method: "getById",
      args: [],
      returnType: { kind: "entity" },
    });

  it("collects only union-returning repo-let bindings", () => {
    const set = collectUnionFindLets([unionRepoLet("u"), entityRepoLet("e")]);
    expect([...set]).toEqual(["u"]);
  });

  it("descends into for-each and both if-let branches", () => {
    const stmts: WorkflowStmtIR[] = [
      stmt("for-each", {
        var: "o",
        varAggName: "O",
        iterable: EXPR,
        savesPerIteration: [],
        body: [unionRepoLet("inLoop")],
      }),
      stmt("if-let", {
        var: "m",
        repoName: "R",
        aggName: "A",
        retrievalName: "q",
        retrievalArgs: [],
        synthCriterion: { name: "c" },
        savesInThen: [],
        savesInElse: [],
        thenBody: [unionRepoLet("inThen")],
        elseBody: [unionRepoLet("inElse")],
      }),
    ];
    expect([...collectUnionFindLets(stmts)].sort()).toEqual(["inElse", "inLoop", "inThen"]);
  });

  it("returns an empty set when no union find-lets are present", () => {
    expect(collectUnionFindLets([entityRepoLet("e")]).size).toBe(0);
  });
});
