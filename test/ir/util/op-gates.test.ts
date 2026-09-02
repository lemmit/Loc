import { describe, expect, it } from "vitest";
import type { ExprIR, OperationIR, StmtIR } from "../../../src/ir/types/loom-ir.js";
import {
  lifecycleGates,
  lifecycleGatesReadRow,
  lifecycleGatesUseCurrentUser,
  operationBody,
  operationBodyUsesCurrentUser,
  operationGates,
  operationGatesUseCurrentUser,
  splitLeadingGates,
} from "../../../src/ir/util/op-gates.js";

// WHERE a `requires` gate is emitted — hoisted to the caller (403) instead of
// evaluated inside the domain entity.  Every backend asks these predicates
// before deciding whether to bind a principal, bind the loaded row, or take a
// `currentUser` parameter on the domain method.  M-T9.17 slice 3 — no test
// imports this module directly today; it is reached only through generator
// output assertions, where a wrong arm reads as an ordinary emission diff far
// from its cause.
//
// The module's two collection rules are DELIBERATELY DIFFERENT, and that
// asymmetry is the whole reason it exists:
//
//   • `operationGates` takes the LEADING RUN only — a `requires` further down a
//     body sits after statements that may have mutated the aggregate, so
//     hoisting it would change WHEN it evaluates.
//   • `lifecycleGates` takes EVERY `requires` in a create/destroy body — a
//     canonical lifecycle body has nothing for a gate to sit after, and
//     collecting only the leading run would silently drop the gate in
//     `create(name: string) { name := name  requires … }`, i.e. ship an open
//     route for a source that spelled one.
//
// So each rule is asserted with the OTHER rule's input: a trailing `requires`
// stays in the operation body and is still collected on the lifecycle path.  A
// copy that unified the two would pass a test that only ever put gates first.

const cuRef: ExprIR = {
  kind: "ref",
  name: "currentUser",
  refKind: "current-user",
} as unknown as ExprIR;

const lit = (v: string): ExprIR => ({ kind: "string", value: v }) as unknown as ExprIR;

/** A `requires` whose expression is inert — neither principal nor row. */
const gate = (source: string): StmtIR =>
  ({ kind: "requires", expr: lit(source), source }) as unknown as StmtIR;

/** A `requires` reading the request principal. */
const cuGate = (source = "currentUser.role == 'admin'"): StmtIR =>
  ({ kind: "requires", expr: cuRef, source }) as unknown as StmtIR;

/** A `requires` reading the loaded row through one of the three this-* ref
 *  kinds `exprReadsRow` recognises. */
const rowGate = (refKind: "this-prop" | "this-vo-prop" | "this-derived"): StmtIR =>
  ({
    kind: "requires",
    expr: { kind: "ref", name: "owner", refKind } as unknown as ExprIR,
    source: `this.owner (${refKind})`,
  }) as unknown as StmtIR;

const assign = (): StmtIR =>
  ({ kind: "assign", target: "name", value: lit("x") }) as unknown as StmtIR;

const op = (statements: StmtIR[]): OperationIR =>
  ({ name: "close", params: [], statements }) as unknown as OperationIR;

describe("splitLeadingGates — the leading run, and only the leading run", () => {
  it("returns empty gates and the untouched body for an ungated operation", () => {
    const stmts = [assign(), assign()];
    const split = splitLeadingGates(stmts);
    expect(split.gates).toEqual([]);
    expect(split.body).toEqual(stmts);
  });

  it("splits a single leading gate off the body", () => {
    const g = gate("a");
    const b = assign();
    expect(splitLeadingGates([g, b])).toEqual({ gates: [g], body: [b] });
  });

  it("takes the WHOLE leading run, not just the first gate", () => {
    // The header form (`operation close() requires <e> { … }`) lowers to a
    // synthetic `requires` PREPENDED to the body, so header + first-body gates
    // arrive as a run of two; stopping at one would leave the second inside
    // the domain method, where it has no principal to read.
    const [g1, g2, b] = [gate("a"), gate("b"), assign()];
    expect(splitLeadingGates([g1!, g2!, b!])).toEqual({ gates: [g1, g2], body: [b] });
  });

  it("leaves a TRAILING `requires` in the body — it must not be hoisted", () => {
    // The ordering rule: this gate sits after a statement that may have
    // mutated the aggregate or bound a `let` it reads, so moving it to the
    // caller changes when it evaluates, not just where it lives.
    const [a, g] = [assign(), gate("late")];
    const split = splitLeadingGates([a!, g!]);
    expect(split.gates).toEqual([]);
    expect(split.body).toEqual([a, g]);
  });

  it("stops the run at the FIRST non-gate, even when gates follow", () => {
    const [g1, a, g2] = [gate("a"), assign(), gate("late")];
    const split = splitLeadingGates([g1!, a!, g2!]);
    expect(split.gates).toEqual([g1]);
    expect(split.body).toEqual([a, g2]);
  });

  it("handles an empty statement list", () => {
    expect(splitLeadingGates([])).toEqual({ gates: [], body: [] });
  });

  it("`operationGates` / `operationBody` are the two halves of one split", () => {
    const [g, a] = [gate("a"), assign()];
    const o = op([g!, a!]);
    expect(operationGates(o)).toEqual([g]);
    expect(operationBody(o)).toEqual([a]);
  });
});

describe("lifecycleGates — EVERY requires, not the leading run", () => {
  it("collects a leading gate", () => {
    const g = gate("a");
    expect(lifecycleGates(op([g, assign()]))).toEqual([g]);
  });

  it("collects a TRAILING gate — the arm a leading-run copy would drop", () => {
    // `create(name: string) { name := name  requires currentUser.role == "admin" }`
    // — the exact source that would ship as an open route if this used
    // `splitLeadingGates`.  A lifecycle body has no statements a gate could
    // meaningfully sit after (everything else is an exempt no-op or a
    // `loom.lifecycle-body-dropped` error), so order carries no meaning here.
    const g = cuGate();
    expect(lifecycleGates(op([assign(), g]))).toEqual([g]);
  });

  it("collects gates from BOTH ends of a body at once", () => {
    const [g1, g2] = [gate("first"), gate("last")];
    expect(lifecycleGates(op([g1!, assign(), g2!]))).toEqual([g1, g2]);
  });

  it("yields an empty list for null and for undefined (no such lifecycle action)", () => {
    // Both spellings, because every call site uses this unconditionally on an
    // optional `creates`/`destroys` entry.
    expect(lifecycleGates(null)).toEqual([]);
    expect(lifecycleGates(undefined)).toEqual([]);
  });
});

describe("lifecycleGatesUseCurrentUser — must the caller bind a principal?", () => {
  it("is false with no gates, and for a gate that reads neither", () => {
    expect(lifecycleGatesUseCurrentUser(op([assign()]))).toBe(false);
    expect(lifecycleGatesUseCurrentUser(op([gate("inert")]))).toBe(false);
  });

  it("is true for a principal-reading gate", () => {
    expect(lifecycleGatesUseCurrentUser(op([cuGate()]))).toBe(true);
  });

  it("sees a principal read in a TRAILING gate too", () => {
    expect(lifecycleGatesUseCurrentUser(op([assign(), cuGate()]))).toBe(true);
  });

  it("is false for null/undefined", () => {
    expect(lifecycleGatesUseCurrentUser(null)).toBe(false);
    expect(lifecycleGatesUseCurrentUser(undefined)).toBe(false);
  });
});

describe("lifecycleGatesReadRow — bind the loaded row, or discard it?", () => {
  // A principal-ONLY destroy gate leaves the receiver binding unused, which
  // `mix compile --warnings-as-errors` rejects outright and which reads as dead
  // code on the other backends.  The load still happens (it is the 404 probe),
  // so "bind it or discard it" is exactly this predicate — and the earlier
  // attempt at it had no fixture that could observe the difference, because
  // every destroy guard in the corpus happened to read a field.
  it("is FALSE for a principal-only gate — the case with no observable fixture", () => {
    expect(lifecycleGatesReadRow(op([cuGate()]))).toBe(false);
  });

  it("is true on a `this-prop` read", () => {
    expect(lifecycleGatesReadRow(op([rowGate("this-prop")]))).toBe(true);
  });

  it("is true on a `this-vo-prop` read — a value-object member of the row", () => {
    expect(lifecycleGatesReadRow(op([rowGate("this-vo-prop")]))).toBe(true);
  });

  it("is true on a `this-derived` read — a derived field of the row", () => {
    // Each of the three ref kinds asserted ALONE: a copy that checked only
    // `this-prop` would still pass a test that supplied all three at once, and
    // would then discard the receiver a derived-reading gate needs.
    expect(lifecycleGatesReadRow(op([rowGate("this-derived")]))).toBe(true);
  });

  it("finds the row read NESTED inside a gate expression, not just at its root", () => {
    const nested: StmtIR = {
      kind: "requires",
      expr: {
        kind: "binary",
        op: "&&",
        left: cuRef,
        right: { kind: "ref", name: "owner", refKind: "this-prop" },
      } as unknown as ExprIR,
      source: "currentUser.id == this.owner",
    } as unknown as StmtIR;
    expect(lifecycleGatesReadRow(op([nested]))).toBe(true);
  });

  it("is false for null/undefined", () => {
    expect(lifecycleGatesReadRow(null)).toBe(false);
    expect(lifecycleGatesReadRow(undefined)).toBe(false);
  });
});

describe("the two currentUser questions an operation answers separately", () => {
  // `operationGatesUseCurrentUser` decides whether the CALLER resolves a
  // principal; `operationBodyUsesCurrentUser` decides whether the emitted
  // DOMAIN METHOD still takes a `currentUser` parameter after hoisting.  A
  // gates-only read must answer true/false, not true/true — a domain method
  // with an unused principal parameter is the dead-code shape the hoist exists
  // to remove.
  it("a gates-only principal read: caller binds, domain method does NOT", () => {
    const o = op([cuGate(), assign()]);
    expect(operationGatesUseCurrentUser(o)).toBe(true);
    expect(operationBodyUsesCurrentUser(o)).toBe(false);
  });

  it("a body-only principal read: domain method takes it, no gate needs it", () => {
    const bodyRead: StmtIR = {
      kind: "assign",
      target: "actor",
      value: cuRef,
    } as unknown as StmtIR;
    const o = op([gate("inert"), bodyRead]);
    expect(operationGatesUseCurrentUser(o)).toBe(false);
    expect(operationBodyUsesCurrentUser(o)).toBe(true);
  });

  it("a TRAILING gate's principal read counts as BODY usage, not gate usage", () => {
    // The ordering rule made observable end to end: a non-leading `requires`
    // is not hoisted, so its `currentUser` is read inside the domain method
    // and the method must still take the parameter.
    const o = op([assign(), cuGate()]);
    expect(operationGatesUseCurrentUser(o)).toBe(false);
    expect(operationBodyUsesCurrentUser(o)).toBe(true);
  });

  it("both are false for an operation that mentions no principal at all", () => {
    const o = op([gate("inert"), assign()]);
    expect(operationGatesUseCurrentUser(o)).toBe(false);
    expect(operationBodyUsesCurrentUser(o)).toBe(false);
  });
});
