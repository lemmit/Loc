// M-FT.11 — the three grammar gaps the Fable field test hit, end to end
// (parse → AST → IR), each pinned at the exact shape that used to fail:
//
//   F1  `key: string` as a field name.  `key` was minted as a HARD keyword by
//       `Channel`'s `key:` partition-field clause, so the field failed to parse
//       — and, because the grammar is newline-insensitive, the error landed on
//       the PREVIOUS line ("Expecting token of type '}' but found `key`").
//   F2  `if <cond> { … } else { … }` in an operation body.  Bodies had `if let`
//       and the effect-form `match` but no plain conditional, so `if status ==
//       Open {` reported "Expecting token of type 'let'".
//   F3  `a ?? b`.  Not an operator at all.
//
// The KEYWORD-POSITION half of F1 is pinned separately and exhaustively by
// `keyword-identifier-completeness.test.ts` (`key` is in its DOMAIN_WORD_FLOOR
// now); what this file adds is that the two `key` spellings COEXIST — the
// channel clause still parses while a field of that name does too.

import { EmptyFileSystem } from "langium";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import type { ExprIR, OperationIR, StmtIR } from "../../../src/ir/types/loom-ir.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

const services = createDddServices(EmptyFileSystem).Ddd;
const parse = parseHelper<Model>(services);

async function parsed(src: string): Promise<{ model: Model; errors: string[] }> {
  const doc = await parse(src, { validation: false });
  return {
    model: doc.parseResult.value,
    errors: [
      ...doc.parseResult.lexerErrors.map((e) => e.message),
      ...doc.parseResult.parserErrors.map((e) => e.message),
    ],
  };
}

/** Lower a source and pull one aggregate operation's statements out of the IR. */
async function opOf(src: string, aggName: string, opName: string): Promise<OperationIR> {
  const { model, errors } = await parsed(src);
  expect(errors, `parse errors: ${errors.join(" | ")}`).toEqual([]);
  const loom = lowerModel(model);
  const ctx = loom.systems.flatMap((s) => s.subdomains).flatMap((m) => m.contexts)[0];
  const agg = ctx?.aggregates.find((a) => a.name === aggName);
  const op = agg?.operations.find((o) => o.name === opName);
  expect(op, `operation ${aggName}.${opName} lowered`).toBeDefined();
  return op as OperationIR;
}

const SYS = (body: string): string => `system S {
  subdomain M { context C {
${body}
  } }
}`;

// ---------------------------------------------------------------------------
// F1 — `key` as an ordinary domain word
// ---------------------------------------------------------------------------

describe("F1 — `key` is a soft keyword", () => {
  it("parses as a field, and the field is readable in an operation body", async () => {
    const { model, errors } = await parsed(
      SYS(`    aggregate Cache {
      key: string
      hits: int
      operation touch() {
        precondition key != ""
        hits := hits + 1
      }
    }`),
    );
    expect(errors).toEqual([]);
    const loom = lowerModel(model);
    const agg = loom.systems
      .flatMap((sys) => sys.subdomains)
      .flatMap((m) => m.contexts)[0]
      ?.aggregates.find((a) => a.name === "Cache");
    expect(agg?.fields.map((f) => f.name)).toContain("key");
    // ...and the READ resolves: the guard's `key` is a this-prop ref, not an
    // unresolved name (the "declarable-but-unreadable" class, BUG-004).
    const guard = agg?.operations.find((o) => o.name === "touch")?.statements[0];
    expect(guard?.kind).toBe("precondition");
    expect(JSON.stringify(guard)).toContain('"this-prop"');
  });

  it("STILL parses `Channel`'s own `key:` clause — the two spellings coexist", async () => {
    const { errors } = await parsed(
      SYS(`    aggregate Order { total: int }
    event Placed { orderId: string }
    channel Orders {
      carries: Placed,
      delivery: queue,
      key: orderId
    }`),
    );
    expect(errors).toEqual([]);
  });

  it("parses as an operation parameter and a `let` name", async () => {
    const { errors } = await parsed(
      SYS(`    aggregate Cache {
      hits: int
      operation put(key: string) {
        let k = key
        hits := hits + 1
      }
    }`),
    );
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F2 — the `if` statement
// ---------------------------------------------------------------------------

const IF_SRC = (body: string): string =>
  SYS(`    enum Status { Open, Done }
    aggregate Task {
      title: string
      count: int
      status: Status
      operation run(n: int) {
${body}
      }
    }`);

describe("F2 — `if … { } else { }` in an operation body", () => {
  it('parses and lowers to a `kind: "if"` statement with both branches', async () => {
    const op = await opOf(
      IF_SRC(`        if status == Open {
          count := 1
        } else {
          count := 2
        }`),
      "Task",
      "run",
    );
    expect(op.statements).toHaveLength(1);
    const s = op.statements[0]!;
    expect(s.kind).toBe("if");
    if (s.kind !== "if") return;
    expect(s.cond.kind).toBe("binary");
    expect(s.thenBody.map((b) => b.kind)).toEqual(["assign"]);
    expect(s.elseBody?.map((b) => b.kind)).toEqual(["assign"]);
  });

  it("an `else`-less `if` lowers with elseBody ABSENT (not an empty array)", async () => {
    const op = await opOf(IF_SRC(`        if n > 0 { count := 1 }`), "Task", "run");
    const s = op.statements[0]!;
    expect(s.kind).toBe("if");
    if (s.kind !== "if") return;
    expect(s.elseBody).toBeUndefined();
  });

  it("`else if` chains into a single-statement elseBody holding the next `if`", async () => {
    const op = await opOf(
      IF_SRC(`        if n > 2 {
          count := 3
        } else if n > 1 {
          count := 2
        } else {
          count := 1
        }`),
      "Task",
      "run",
    );
    const s = op.statements[0]!;
    expect(s.kind).toBe("if");
    if (s.kind !== "if") return;
    expect(s.elseBody).toHaveLength(1);
    const inner = s.elseBody?.[0];
    expect(inner?.kind).toBe("if");
    if (inner?.kind !== "if") return;
    expect(inner.thenBody.map((b) => b.kind)).toEqual(["assign"]);
    expect(inner.elseBody?.map((b) => b.kind)).toEqual(["assign"]);
  });

  it("nests, and a branch carries the full statement vocabulary", async () => {
    const op = await opOf(
      IF_SRC(`        if n > 0 {
          let m = n + 1
          if m > 5 {
            count := m
          }
          precondition m > 0
        }`),
      "Task",
      "run",
    );
    const s = op.statements[0]!;
    if (s.kind !== "if") throw new Error("expected an if");
    expect(s.thenBody.map((b) => b.kind)).toEqual(["let", "if", "precondition"]);
  });

  // The reason `IfStmt.cond` is `CondExpr` and not `Expression`: a full
  // expression lets `BuilderCall` (`Name { … }`) claim the `if`'s own body
  // block.  A bare-name condition is the shape that trips it.
  it("a BARE NAME condition does not have its body swallowed as a BuilderCall", async () => {
    const op = await opOf(
      SYS(`    aggregate Task {
      count: int
      active: bool
      operation run() {
        if active {
          count := 1
        }
      }
    }`),
      "Task",
      "run",
    );
    const s = op.statements[0]!;
    expect(s.kind).toBe("if");
    if (s.kind !== "if") return;
    // The body is the `if`'s, not a builder's entry list.
    expect(s.cond.kind).toBe("ref");
    expect(s.thenBody.map((b) => b.kind)).toEqual(["assign"]);
  });

  it("does not shadow `if let`, whose second token is the hard `let` keyword", async () => {
    const { errors } = await parsed(
      SYS(`    aggregate Task { count: int }
    criterion Busy of Task = this.count > 0
    repository Tasks for Task {}
    workflow W {
      handle go() {
        if let t = Tasks.find(Busy) {
          count := 1
        } else {
          count := 2
        }
      }
    }`),
    );
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F3 — `??`
// ---------------------------------------------------------------------------

const COALESCE_SRC = (expr: string): string =>
  SYS(`    aggregate Task {
      note: string
      hint: string?
      alt: string?
      operation run(fallback: string) {
        note := ${expr}
      }
    }`);

/** The single `assign` an operation body of the shape above lowers to. */
async function coalesceValue(expr: string): Promise<ExprIR> {
  const op = await opOf(COALESCE_SRC(expr), "Task", "run");
  const s: StmtIR = op.statements[0]!;
  if (s.kind !== "assign") throw new Error(`expected an assign, got ${s.kind}`);
  return s.value;
}

describe("F3 — `??` nullish coalescing", () => {
  it("desugars to the existing ternary IR — `a == null ? b : a`", async () => {
    const v = await coalesceValue("hint ?? fallback");
    expect(v.kind).toBe("ternary");
    if (v.kind !== "ternary") return;
    expect(v.cond.kind).toBe("binary");
    if (v.cond.kind !== "binary") return;
    expect(v.cond.op).toBe("==");
    expect(v.cond.right).toEqual({ kind: "literal", lit: "null", value: "null" });
    // The fallback is the THEN branch (the null case); the value itself is the
    // otherwise branch.
    expect(v.then).toMatchObject({ kind: "ref", name: "fallback" });
    expect(v.otherwise).toMatchObject({ kind: "ref", name: "hint" });
  });

  it("is RIGHT-associative — `a ?? b ?? c` is `a ?? (b ?? c)`", async () => {
    const v = await coalesceValue("hint ?? alt ?? fallback");
    if (v.kind !== "ternary") throw new Error("expected a ternary");
    // Outer test is on `hint`; its null-branch is the inner `alt ?? fallback`.
    expect(v.otherwise).toMatchObject({ kind: "ref", name: "hint" });
    expect(v.then.kind).toBe("ternary");
    if (v.then.kind !== "ternary") return;
    expect(v.then.otherwise).toMatchObject({ kind: "ref", name: "alt" });
    expect(v.then.then).toMatchObject({ kind: "ref", name: "fallback" });
  });

  it("binds LOOSER than `||` — `a ?? b || c` groups as `a ?? (b || c)`", async () => {
    const op = await opOf(
      SYS(`    aggregate Task {
      flag: bool
      p: bool?
      q: bool
      operation run(r: bool) {
        flag := p ?? q || r
      }
    }`),
      "Task",
      "run",
    );
    const s = op.statements[0]!;
    if (s.kind !== "assign" || s.value.kind !== "ternary") throw new Error("expected a ternary");
    // The `||` sits INSIDE the coalesce's fallback branch, not around it.
    expect(s.value.then.kind).toBe("binary");
    if (s.value.then.kind !== "binary") return;
    expect(s.value.then.op).toBe("||");
  });

  it("binds TIGHTER than `?:` — `a ?? b ? c : d` groups as `(a ?? b) ? c : d`", async () => {
    const v = await coalesceValue('hint ?? fallback == "x" ? "y" : "z"');
    // Outermost node is the TERNARY the `? :` built; its condition holds the
    // coalesce.  (If `??` bound looser, the outermost node would be the
    // coalesce instead and `otherwise` would be a bare `hint` ref.)
    if (v.kind !== "ternary") throw new Error("expected a ternary");
    expect(v.then).toMatchObject({ kind: "literal", value: "y" });
    expect(v.otherwise).toMatchObject({ kind: "literal", value: "z" });
  });

  it("works in a page body, where it rides the same ternary the frontends render", async () => {
    const { model, errors } = await parsed(`system S {
  subdomain M { context C { aggregate Task { title: string } } }
  ui Web {
    framework: react
    page Home {
      state { note: string? }
      body: Stack { Heading { text: note ?? "untitled" } }
    }
  }
}`);
    expect(errors).toEqual([]);
    const loom = lowerModel(model);
    const page = loom.systems[0]?.uis[0]?.pages.find((p) => p.name === "Home");
    expect(JSON.stringify(page?.body)).toContain('"ternary"');
  });
});
