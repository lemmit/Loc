// Structured statement rows for the visual builder's body editor.
//
// `body.ts` used to structure only assignments, bare calls and emits; every
// other grammar form fell through to a verbatim `other` textarea (and the v2
// graph told a `precondition` from a `let` by sniffing the leading keyword out
// of that text).  These suites hold the line for the rest of the grammar's
// statement forms — `let` / `return` / `precondition` / `requires` and the
// three CONTAINER forms (`for`, `if let`, the effect-form `match`) whose bodies
// are nested statement lists edited recursively.
//
// The invariant every mutator keeps: an edit is a narrow CST splice guarded by
// an output re-parse, so everything outside the edited span — the nested block
// it lives in, the comments beside it, the rest of the file — is byte-
// preserved.  Assertions go through `lineDiff` (the builder's own hunk differ):
// asserting the exact removed/added lines proves nothing else moved.

import { describe, expect, it } from "vitest";
import { lineDiff } from "../../../web/src/builder/edit-engine.js";
import {
  addMatchArm,
  addStatement,
  type BodyLocator,
  deleteMatchArm,
  deleteStatement,
  editStatement,
  editStatementPart,
  insertIntoList,
  insertMatchArm,
  listBodies,
  listStatements,
  listStatementViews,
  moveStatement,
  primaryWorkflowCreate,
  removeSpan,
  replaceSpan,
  type StmtView,
  stmtText,
  swapSpans,
  workflowBodyParamNames,
  workflowBodyStatements,
} from "../../../web/src/builder/system/body.js";
import { listEmits, setEmitEvent } from "../../../web/src/builder/system/emit-event.js";
import { slotExpr, workflowSlotOptions } from "../../../web/src/builder/system/expr-slots.js";
import { parseRaw as parse } from "../../_helpers/index.js";

// One fixture carrying every statement form the grammar has, littered with the
// comments a reprint would destroy.
const SRC = `system Shop {

  context Sales {

    event Paid { at: datetime }

    aggregate Order {
      status: string
      total: decimal = 0

      operation confirm(n: int) {
        // domain validity
        precondition n > 0 message "n must be positive"
        requires currentUser.isAdmin
        let subtotal = n * 2
        for line in lines {
          // per-line fold
          total += line.amount
          status := "folding"
        }
        if let found = Orders.byId(n) {
          status := "found"
        } else {
          status := "missing"
        }
        match outcome {
          Ok v => {
            status := "ok"
          }
          Err e => {
            status := "failed"
          }
          else => {
            status := "unknown"
          }
        }
        emit Paid { at: now() }
        return status
      }

      operation empty(n: int) {
        for line in lines {
        }
      }
    }

    workflow place {
      // the primary starter
      create(orderId: int) {
        let a = orderId
      }
      create retry(again: int) {
        let b = again
      }
      handle settle(amount: decimal) {
        let c = amount
      }
      on(p: Paid) {
        let d = p
      }
      apply(q: Paid) {
        total := 1
      }
    }
  }
}`;

const confirm: BodyLocator = { kind: "operation", aggregate: "Order", op: "confirm" };
const empty: BodyLocator = { kind: "operation", aggregate: "Order", op: "empty" };
const place: BodyLocator = { kind: "workflow", name: "place" };

/** Every comment in the fixture — none of them may ever disappear. */
const COMMENTS = ["// domain validity", "// per-line fold", "// the primary starter"];

const expectCommentsIntact = (out: string | null): void => {
  expect(out).not.toBeNull();
  for (const c of COMMENTS) expect(out).toContain(c);
};

/** Assert the edit is exactly this hunk — nothing else in the file moved. */
const expectHunk = (
  before: string,
  after: string | null,
  removed: string[],
  added: string[],
): void => {
  expect(after).not.toBeNull();
  const hunk = lineDiff(before, after as string);
  expect({ removed: hunk.removed, added: hunk.added }).toEqual({ removed, added });
};

const views = (src: string, loc: BodyLocator = confirm): StmtView[] =>
  listStatementViews(parse(src), loc) as StmtView[];

const view = <K extends StmtView["kind"]>(
  kind: K,
  index: number,
  src = SRC,
): Extract<StmtView, { kind: K }> => {
  const v = views(src)[index];
  expect(v?.kind).toBe(kind);
  return v as Extract<StmtView, { kind: K }>;
};

// A source the parser rejects — every mutator must refuse it rather than splice
// at offsets the error-recovery parser invented.
const BROKEN = SRC.replace("aggregate Order {", "aggregate Order {{");

// Index of each statement in `confirm`'s body.
const PRE = 0;
const REQ = 1;
const LET = 2;
const FOR = 3;
const IFLET = 4;
const MATCH = 5;
const RET = 7;

describe("statement rows — every grammar form is structured", () => {
  it("classifies each statement by its AST form, not its leading keyword", () => {
    expect(views(SRC).map((v) => v.kind)).toEqual([
      "precondition",
      "requires",
      "let",
      "for",
      "ifLet",
      "match",
      "emit",
      "return",
    ]);
  });

  it("splits precondition / requires / let / return into their parts", () => {
    expect(views(SRC)[PRE]).toEqual({
      kind: "precondition",
      expr: "n > 0",
      message: "n must be positive",
    });
    expect(views(SRC)[REQ]).toEqual({ kind: "requires", expr: "currentUser.isAdmin" });
    expect(views(SRC)[LET]).toEqual({ kind: "let", name: "subtotal", value: "n * 2" });
    expect(views(SRC)[RET]).toEqual({ kind: "return", value: "status" });
  });

  it("omits `message` when the precondition declares none", () => {
    const src = SRC.replace(' message "n must be positive"', "");
    expect(views(src)[PRE]).toEqual({ kind: "precondition", expr: "n > 0" });
  });

  it("splits a `for` into binder / iterable / a nested statement list", () => {
    const f = view("for", FOR);
    expect(f.binder).toBe("line");
    expect(f.iterable).toBe("lines");
    expect(f.body.items.map((s) => stmtText(s))).toEqual([
      "total += line.amount",
      'status := "folding"',
    ]);
  });

  it("splits an `if let` into binder / subject / then + else lists", () => {
    const il = view("ifLet", IFLET);
    expect(il.binder).toBe("found");
    expect(il.subject).toBe("Orders.byId(n)");
    expect(il.then.items.map(stmtText)).toEqual(['status := "found"']);
    expect(il.else?.items.map(stmtText)).toEqual(['status := "missing"']);
  });

  it("leaves `else` null when the `if let` has no else block", () => {
    const src = SRC.replace(' else {\n          status := "missing"\n        }', "");
    expect(view("ifLet", IFLET, src).else).toBeNull();
  });

  it("splits a statement-form `match` into subject / arms / else", () => {
    const m = view("match", MATCH);
    expect(m.subject).toBe("outcome");
    expect(m.arms.map((a) => [a.variant, a.binder])).toEqual([
      ["Ok", "v"],
      ["Err", "e"],
    ]);
    expect(m.arms[0]?.body.items.map(stmtText)).toEqual(['status := "ok"']);
    expect(m.else?.items.map(stmtText)).toEqual(['status := "unknown"']);
  });

  it("falls back to a verbatim row below the structured nesting depth", () => {
    const src = SRC.replace(
      "        if let found = Orders.byId(n) {",
      "        for outer in xs {\n          if let inner = Orders.byId(n) {\n            for innermost in ys {\n              total += 1\n            }\n          }\n        }\n        if let found = Orders.byId(n) {",
    );
    const outer = view("for", IFLET, src);
    const inner = outer.body.items[0];
    expect(inner?.kind).toBe("ifLet");
    // Depth 2 — the innermost loop is a plain text row.
    const innermost = (inner as Extract<StmtView, { kind: "ifLet" }>).then.items[0];
    expect(innermost?.kind).toBe("other");
    expect(stmtText(innermost as StmtView)).toContain("for innermost in ys");
  });

  it("keeps the assignment / call / emit rows exactly as they were", () => {
    expect(views(SRC)[6]).toEqual({
      kind: "emit",
      event: "Paid",
      fields: [{ name: "at", value: "now()" }],
    });
    const f = view("for", FOR);
    expect(f.body.items[0]).toEqual({
      kind: "assign",
      target: "total",
      op: "+=",
      value: "line.amount",
    });
  });
});

describe("statement rows — header part mutators", () => {
  it("rewrites a `for` binder and iterable, block untouched", () => {
    expectHunk(
      SRC,
      editStatementPart(SRC, confirm, FOR, "name", "row"),
      ["        for line in lines {"],
      ["        for row in lines {"],
    );
    expectHunk(
      SRC,
      editStatementPart(SRC, confirm, FOR, "iterable", "order.lines"),
      ["        for line in lines {"],
      ["        for line in order.lines {"],
    );
    expectCommentsIntact(editStatementPart(SRC, confirm, FOR, "name", "row"));
  });

  it("rewrites an `if let` binder and subject", () => {
    expectHunk(
      SRC,
      editStatementPart(SRC, confirm, IFLET, "name", "hit"),
      ["        if let found = Orders.byId(n) {"],
      ["        if let hit = Orders.byId(n) {"],
    );
    expectHunk(
      SRC,
      editStatementPart(SRC, confirm, IFLET, "subject", "Orders.byRef(n)"),
      ["        if let found = Orders.byId(n) {"],
      ["        if let found = Orders.byRef(n) {"],
    );
  });

  it("rewrites a match subject, an arm variant and an arm binder", () => {
    expectHunk(
      SRC,
      editStatementPart(SRC, confirm, MATCH, "subject", "result"),
      ["        match outcome {"],
      ["        match result {"],
    );
    expectHunk(
      SRC,
      editStatementPart(SRC, confirm, MATCH, { arm: 1, field: "variant" }, "Failure"),
      ["          Err e => {"],
      ["          Failure e => {"],
    );
    expectHunk(
      SRC,
      editStatementPart(SRC, confirm, MATCH, { arm: 0, field: "binder" }, "value"),
      ["          Ok v => {"],
      ["          Ok value => {"],
    );
  });

  it("adds a binder to an arm that declares none", () => {
    const bare = SRC.replace("Ok v => {", "Ok => {");
    expectHunk(
      bare,
      editStatementPart(bare, confirm, MATCH, { arm: 0, field: "binder" }, "v"),
      ["          Ok => {"],
      ["          Ok v => {"],
    );
  });

  it("rewrites a let name / a single-expression predicate", () => {
    expectHunk(
      SRC,
      editStatementPart(SRC, confirm, LET, "name", "sub"),
      ["        let subtotal = n * 2"],
      ["        let sub = n * 2"],
    );
    expectHunk(
      SRC,
      editStatementPart(SRC, confirm, LET, "expr", "n * 3"),
      ["        let subtotal = n * 2"],
      ["        let subtotal = n * 3"],
    );
    expectHunk(
      SRC,
      editStatementPart(SRC, confirm, REQ, "expr", "currentUser.isOwner"),
      ["        requires currentUser.isAdmin"],
      ["        requires currentUser.isOwner"],
    );
    expectHunk(
      SRC,
      editStatementPart(SRC, confirm, RET, "expr", "total"),
      ["        return status"],
      ["        return total"],
    );
  });

  it("sets / replaces / drops a precondition message", () => {
    expectHunk(
      SRC,
      editStatementPart(SRC, confirm, PRE, "message", "n is required"),
      ['        precondition n > 0 message "n must be positive"'],
      ['        precondition n > 0 message "n is required"'],
    );
    expectHunk(
      SRC,
      editStatementPart(SRC, confirm, PRE, "message", ""),
      ['        precondition n > 0 message "n must be positive"'],
      ["        precondition n > 0"],
    );
    const bare = SRC.replace(' message "n must be positive"', "");
    expectHunk(
      bare,
      editStatementPart(bare, confirm, PRE, "message", "n is required"),
      ["        precondition n > 0"],
      ['        precondition n > 0 message "n is required"'],
    );
    expectCommentsIntact(editStatementPart(SRC, confirm, PRE, "message", "x"));
  });

  it("refuses a part the statement does not have, or an unparseable value", () => {
    expect(editStatementPart(SRC, confirm, REQ, "iterable", "xs")).toBeNull();
    expect(editStatementPart(SRC, confirm, PRE, "name", "x")).toBeNull();
    expect(editStatementPart(SRC, confirm, FOR, "iterable", "lines(")).toBeNull();
    expect(editStatementPart(SRC, confirm, MATCH, { arm: 9, field: "variant" }, "X")).toBeNull();
    expect(editStatementPart(BROKEN, confirm, FOR, "name", "row")).toBeNull();
  });
});

describe("statement rows — match arms", () => {
  it("appends an arm with an empty block", () => {
    expectHunk(
      SRC,
      addMatchArm(SRC, confirm, MATCH, "Pending", "p"),
      [],
      ["          Pending p => {", "          }"],
    );
    expectCommentsIntact(addMatchArm(SRC, confirm, MATCH, "Pending"));
  });

  it("deletes an arm and its separator only", () => {
    expectHunk(
      SRC,
      deleteMatchArm(SRC, confirm, MATCH, 1),
      ["          Err e => {", '            status := "failed"', "          }"],
      [],
    );
    expectCommentsIntact(deleteMatchArm(SRC, confirm, MATCH, 0));
  });

  it("keeps comma-separated arms well-formed", () => {
    const commas = SRC.replace(
      '          Ok v => {\n            status := "ok"\n          }\n',
      '          Ok v => { status := "ok" },\n',
    );
    const out = deleteMatchArm(commas, confirm, MATCH, 0);
    expect(out).not.toBeNull();
    expect(out).not.toContain("Ok v =>");
    expect(out).toContain("Err e => {");
  });

  it("refuses an arm op on a non-match statement / a bad index", () => {
    expect(addMatchArm(SRC, confirm, FOR, "Ok")).toBeNull();
    expect(addMatchArm(SRC, confirm, MATCH, "  ")).toBeNull();
    expect(deleteMatchArm(SRC, confirm, MATCH, 9)).toBeNull();
    expect(deleteMatchArm(BROKEN, confirm, MATCH, 0)).toBeNull();
  });
});

describe("statement rows — nested statement lists", () => {
  it("edits a statement inside a `for` body", () => {
    expectHunk(
      SRC,
      editStatement(SRC, confirm, [{ index: FOR }, { index: 1 }], 'status := "done"'),
      ['          status := "folding"'],
      ['          status := "done"'],
    );
    expectCommentsIntact(editStatement(SRC, confirm, [{ index: FOR }, { index: 0 }], "total += 1"));
  });

  it("edits a statement inside each `if let` branch", () => {
    expectHunk(
      SRC,
      editStatement(
        SRC,
        confirm,
        [{ index: IFLET }, { index: 0, list: "then" }],
        'status := "hit"',
      ),
      ['          status := "found"'],
      ['          status := "hit"'],
    );
    expectHunk(
      SRC,
      editStatement(
        SRC,
        confirm,
        [{ index: IFLET }, { index: 0, list: "else" }],
        'status := "none"',
      ),
      ['          status := "missing"'],
      ['          status := "none"'],
    );
  });

  it("edits a statement inside a match arm and inside the else block", () => {
    expectHunk(
      SRC,
      editStatement(
        SRC,
        confirm,
        [{ index: MATCH }, { index: 0, list: { arm: 1 } }],
        'status := "bad"',
      ),
      ['            status := "failed"'],
      ['            status := "bad"'],
    );
    expectHunk(
      SRC,
      editStatement(SRC, confirm, [{ index: MATCH }, { index: 0, list: "else" }], 'status := "?"'),
      ['            status := "unknown"'],
      ['            status := "?"'],
    );
  });

  it("deletes a nested statement, taking only its own line", () => {
    expectHunk(
      SRC,
      deleteStatement(SRC, confirm, [{ index: FOR }, { index: 1 }]),
      ['          status := "folding"'],
      [],
    );
    // The comment documenting the deleted block's first statement stays.
    expectCommentsIntact(deleteStatement(SRC, confirm, [{ index: FOR }, { index: 0 }]));
  });

  it("moves a nested statement by swapping it with its sibling", () => {
    expectHunk(
      SRC,
      moveStatement(SRC, confirm, [{ index: FOR }, { index: 0 }], 1),
      ["          total += line.amount", '          status := "folding"'],
      ['          status := "folding"', "          total += line.amount"],
    );
    // Can't move past the ends of the NESTED list.
    expect(moveStatement(SRC, confirm, [{ index: FOR }, { index: 0 }], -1)).toBeNull();
    expect(moveStatement(SRC, confirm, [{ index: FOR }, { index: 1 }], 1)).toBeNull();
  });

  it("adds a statement to a nested list, matching its indentation", () => {
    expectHunk(
      SRC,
      addStatement(SRC, confirm, "total += 1", { at: FOR }),
      [],
      ["          total += 1"],
    );
    expectHunk(
      SRC,
      addStatement(SRC, confirm, 'status := "x"', { at: IFLET, list: "else" }),
      [],
      ['          status := "x"'],
    );
    expectHunk(
      SRC,
      addStatement(SRC, confirm, 'status := "x"', { at: MATCH, list: { arm: 0 } }),
      [],
      ['            status := "x"'],
    );
  });

  it("opens an empty nested block on the first added statement", () => {
    // The `}` keeps its own line and its indentation — no blank line left.
    expectHunk(
      SRC,
      addStatement(SRC, empty, "total += 1", { at: 0 }),
      [],
      ["          total += 1"],
    );
    expect(addStatement(SRC, empty, "total += 1", { at: 0 })).toContain(
      "for line in lines {\n          total += 1\n        }",
    );
  });

  it("refuses a nested address the body does not have", () => {
    expect(editStatement(SRC, confirm, [{ index: FOR }, { index: 9 }], "total += 1")).toBeNull();
    expect(editStatement(SRC, confirm, [{ index: LET }, { index: 0 }], "total += 1")).toBeNull();
    expect(addStatement(SRC, confirm, "total += 1", { at: LET })).toBeNull();
    expect(addStatement(SRC, confirm, "total += 1", { at: IFLET, list: { arm: 0 } })).toBeNull();
    expect(deleteStatement(SRC, confirm, [{ index: FOR }, { index: 9 }])).toBeNull();
    expect(editStatement(BROKEN, confirm, [{ index: FOR }, { index: 0 }], "total += 1")).toBeNull();
  });

  it("still addresses a top-level statement by bare index", () => {
    expectHunk(
      SRC,
      editStatement(SRC, confirm, REQ, "requires currentUser.isOwner"),
      ["        requires currentUser.isAdmin"],
      ["        requires currentUser.isOwner"],
    );
    expect(deleteStatement(SRC, confirm, RET)).toContain("emit Paid");
  });
});

describe("statement rows — the span helpers the UI rows splice with", () => {
  // The rows edit a container's OWN source text by span and commit the whole
  // statement through `editStatement`; the result must match what the direct
  // part mutator produces, or the two paths would drift.
  it("replaceSpan over a view's part span == editStatementPart", () => {
    const f = view("for", FOR);
    const next = editStatement(SRC, confirm, FOR, replaceSpan(f.src, f.binderAt, "row"));
    expect(next).toBe(editStatementPart(SRC, confirm, FOR, "name", "row"));
  });

  it("nested span splices == the path-addressed mutators", () => {
    const f = view("for", FOR);
    expect(
      editStatement(SRC, confirm, FOR, replaceSpan(f.src, f.body.spans[1]!, 'status := "done"')),
    ).toBe(editStatement(SRC, confirm, [{ index: FOR }, { index: 1 }], 'status := "done"'));
    expect(editStatement(SRC, confirm, FOR, removeSpan(f.src, f.body.spans[1]!))).toBe(
      deleteStatement(SRC, confirm, [{ index: FOR }, { index: 1 }]),
    );
    expect(
      editStatement(SRC, confirm, FOR, swapSpans(f.src, f.body.spans[0]!, f.body.spans[1]!)),
    ).toBe(moveStatement(SRC, confirm, [{ index: FOR }, { index: 0 }], 1));
    expect(editStatement(SRC, confirm, FOR, insertIntoList(f.src, f.body, "total += 1"))).toBe(
      addStatement(SRC, confirm, "total += 1", { at: FOR }),
    );
  });

  it("insertMatchArm == addMatchArm", () => {
    const m = view("match", MATCH);
    expect(editStatement(SRC, confirm, MATCH, insertMatchArm(m.src, m, "Pending", "p"))).toBe(
      addMatchArm(SRC, confirm, MATCH, "Pending", "p"),
    );
  });

  it("opens an empty nested block through the list view too", () => {
    const e = listStatementViews(parse(SRC), empty)![0] as Extract<StmtView, { kind: "for" }>;
    expect(editStatement(SRC, empty, 0, insertIntoList(e.src, e.body, "total += 1"))).toBe(
      addStatement(SRC, empty, "total += 1", { at: 0 }),
    );
  });
});

describe("workflow body reach — every statement-bearing member", () => {
  it("enumerates creates / handles / ons / applies with stable keys", () => {
    const wf = parse(SRC)
      .members.flatMap((m) => ("members" in m ? m.members : []))
      .flatMap((m) => ("members" in m ? m.members : []))
      .find((m) => m.$type === "Workflow");
    expect(listBodies(wf as never).map((b) => b.key)).toEqual([
      "create",
      "create:retry",
      "handle:settle",
      "on:Paid",
      "apply:Paid",
    ]);
    expect(listBodies(wf as never).map((b) => b.count)).toEqual([1, 1, 1, 1, 1]);
  });

  it("lists each member's statements by key, defaulting to the primary create", () => {
    expect(listStatements(parse(SRC), place)).toEqual(["let a = orderId"]);
    expect(listStatements(parse(SRC), { ...place, member: "create" })).toEqual(["let a = orderId"]);
    expect(listStatements(parse(SRC), { ...place, member: "create:retry" })).toEqual([
      "let b = again",
    ]);
    expect(listStatements(parse(SRC), { ...place, member: "handle:settle" })).toEqual([
      "let c = amount",
    ]);
    expect(listStatements(parse(SRC), { ...place, member: "on:Paid" })).toEqual(["let d = p"]);
    expect(listStatements(parse(SRC), { ...place, member: "apply:Paid" })).toEqual(["total := 1"]);
    expect(listStatements(parse(SRC), { ...place, member: "handle:nope" })).toBeNull();
  });

  it("structures a handle / on / apply body like any other", () => {
    expect(listStatementViews(parse(SRC), { ...place, member: "handle:settle" })).toEqual([
      { kind: "let", name: "c", value: "amount" },
    ]);
    expect(listStatementViews(parse(SRC), { ...place, member: "apply:Paid" })).toEqual([
      { kind: "assign", target: "total", op: ":=", value: "1" },
    ]);
  });

  it("edits / adds / deletes inside a handle, an on and an apply body", () => {
    expectHunk(
      SRC,
      editStatement(SRC, { ...place, member: "handle:settle" }, 0, "let c = amount * 2"),
      ["        let c = amount"],
      ["        let c = amount * 2"],
    );
    expectHunk(
      SRC,
      addStatement(SRC, { ...place, member: "on:Paid" }, "let e = 1"),
      [],
      ["        let e = 1"],
    );
    expectHunk(
      SRC,
      deleteStatement(SRC, { ...place, member: "apply:Paid" }, 0),
      ["        total := 1"],
      [],
    );
    expectCommentsIntact(
      editStatement(SRC, { ...place, member: "create:retry" }, 0, "let b = again + 1"),
    );
  });

  it("binds each member's own parameters for expression-slot scoping", () => {
    const wf = parse(SRC)
      .members.flatMap((m) => ("members" in m ? m.members : []))
      .flatMap((m) => ("members" in m ? m.members : []))
      .find((m) => m.$type === "Workflow") as never;
    expect(workflowBodyParamNames(wf)).toEqual(["orderId"]);
    expect(workflowBodyParamNames(wf, "handle:settle")).toEqual(["amount"]);
    expect(workflowBodyParamNames(wf, "on:Paid")).toEqual(["p"]);
    expect(workflowBodyParamNames(wf, "apply:Paid")).toEqual(["q"]);
    expect(workflowBodyStatements(wf, "create:retry").length).toBe(1);
  });

  it("offers an expression slot per member body, primary keeping the bare key", () => {
    const wf = parse(SRC)
      .members.flatMap((m) => ("members" in m ? m.members : []))
      .flatMap((m) => ("members" in m ? m.members : []))
      .find((m) => m.$type === "Workflow") as never;
    const options = workflowSlotOptions(wf);
    expect(options.map((o) => o.value)).toEqual([
      "wf:0",
      "wf@create:retry:0",
      "wf@handle:settle:0",
      "wf@on:Paid:0",
      "wf@apply:Paid:0",
    ]);
    // Each member's slot resolves to that member's own expression.
    const handle = options.find((o) => o.value === "wf@handle:settle:0")!;
    expect(slotExpr(parse(SRC), handle.slot)?.$cstNode?.text).toBe("amount");
    expect(slotExpr(parse(SRC), options[0]!.slot)?.$cstNode?.text).toBe("orderId");
  });
});

describe("the shared primary-create helper", () => {
  const wfOf = (src: string) =>
    parse(src)
      .members.flatMap((m) => ("members" in m ? m.members : []))
      .flatMap((m) => ("members" in m ? m.members : []))
      .find((m) => m.$type === "Workflow") as never;

  it("prefers the unnamed create over a named one declared first", () => {
    const src = `system S {
  context C {
    workflow w {
      create first(a: int) {
        let x = a
      }
      create(b: int) {
        let y = b
      }
    }
  }
}`;
    expect(primaryWorkflowCreate(wfOf(src))?.name).toBeUndefined();
    expect(listStatements(parse(src), { kind: "workflow", name: "w" })).toEqual(["let y = b"]);
  });

  it("falls back to the first create when they are all named", () => {
    const src = `system S {
  context C {
    workflow w {
      create first(a: int) {
        let x = a
      }
      create second(b: int) {
        let y = b
      }
    }
  }
}`;
    expect(primaryWorkflowCreate(wfOf(src))?.name).toBe("first");
    expect(listStatements(parse(src), { kind: "workflow", name: "w" })).toEqual(["let x = a"]);
  });

  it("is the same rule the emit editor scopes to", () => {
    // `listEmits` / `setEmitEvent` share the helper — an emit in the primary
    // create is addressable, one in a named create is not (reactor emits are a
    // separate surface).
    const src = `system S {
  context C {
    event A { at: datetime }
    event B { at: datetime }
    workflow w {
      create named(a: int) {
        emit A { at: now() }
      }
      create(b: int) {
        emit B { at: now() }
      }
    }
  }
}`;
    expect(listEmits(wfOf(src)).map((e) => e.event)).toEqual(["B"]);
    expect(setEmitEvent(src, "workflow", "w", undefined, 0, "A")).toContain(
      "emit A { at: now() }\n      }\n      create(b: int) {\n        emit A",
    );
  });
});

describe("statement rows — the verbatim fallback still works", () => {
  it("keeps an unstructured statement editable as text", () => {
    // A bare LValue statement (no call, no mutation suffix) has no structured
    // row — it keeps its source verbatim and edits through the text field.
    const src = `system S {
  context C {
    workflow w {
      create(a: int) {
        Orders.run(R(a))
        a
      }
    }
  }
}`;
    const loc: BodyLocator = { kind: "workflow", name: "w" };
    expect(listStatementViews(parse(src), loc)).toEqual([
      { kind: "call", head: "Orders.run", args: ["R(a)"] },
      { kind: "other", src: "a" },
    ]);
    expect(editStatement(src, loc, 1, "b")).toContain("\n        b\n");
    // Same for a container nested past the structured depth.
    const nested = views(
      SRC.replace(
        "        return status",
        "        for a in xs {\n          for b in ys {\n            for c in zs {\n              total += 1\n            }\n          }\n        }",
      ),
    )[RET] as Extract<StmtView, { kind: "for" }>;
    const mid = nested.body.items[0] as Extract<StmtView, { kind: "for" }>;
    expect(mid.body.items[0]?.kind).toBe("other");
    expect(stmtText(mid.body.items[0] as StmtView)).toContain("for c in zs");
  });

  it("rejects a syntactically invalid edit at every level", () => {
    expect(editStatement(SRC, confirm, LET, "let subtotal =")).toBeNull();
    expect(editStatement(SRC, confirm, [{ index: FOR }, { index: 0 }], "total +=")).toBeNull();
    expect(addStatement(SRC, confirm, "total +=", { at: FOR })).toBeNull();
    expect(addStatement(SRC, confirm, "   ")).toBeNull();
  });
});
