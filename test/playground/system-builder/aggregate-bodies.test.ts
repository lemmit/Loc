// Aggregate body reach + nested-statement expression slots.
//
// Two additive extensions of the body/slot layer:
//
//  * `body.ts` used to reach only an aggregate's `operation`s — its `create` /
//    `destroy` / `apply` bodies were statement lists the builder could see in
//    the text and not edit.  They are now `listBodies` keys like a workflow's
//    members, reachable through the same `BodyLocator.member` precedent, so
//    every statement mutator works against them unchanged.
//  * `expr-slots.ts` addressed statements by flat top-level index only, so an
//    expression inside a `for` / `if let` / `match` block could never open the
//    structured editor.  A slot now carries an optional `path` (the `StmtPath`
//    body.ts already splices with) alongside its `index`.
//
// The house invariant holds throughout: an edit is a narrow CST splice guarded
// by an output re-parse, asserted through `lineDiff` so nothing else moved.

import { describe, expect, it } from "vitest";
import { lineDiff } from "../../../web/src/builder/edit-engine.js";
import {
  addStatement,
  aggregateBody,
  aggregateBodyParamNames,
  aggregateBodyStatements,
  type BodyLocator,
  deleteStatement,
  editStatement,
  editStatementPart,
  listBodies,
  listStatements,
  listStatementViews,
  moveStatement,
  nestedStmtLists,
  type StmtView,
  statementAt,
} from "../../../web/src/builder/system/body.js";
import {
  decodeStmtPath,
  type ExprSlot,
  editExprSlot,
  encodeStmtPath,
  exprSlotOptions,
  slotCandidates,
  slotExpr,
  workflowSlotOptions,
} from "../../../web/src/builder/system/expr-slots.js";
import { parseRaw as parse } from "../../_helpers/index.js";

const SRC = `system Shop {

  context Sales {

    event Paid { at: datetime }

    aggregate Order {
      status: string
      total: decimal = 0

      // the canonical creator
      create(initial: decimal) {
        total := initial
        for line in lines {
          total += line.amount
        }
      }

      create draft(note: string) {
        status := note
      }

      destroy {
        status := "gone"
      }

      destroy archive(reason: string) {
        status := reason
      }

      apply(e: Paid) {
        status := "paid"
      }

      operation confirm(n: int) {
        precondition n > 0
        for line in lines {
          let each = line.amount
          total += each
        }
        if let hit = Orders.byId(n) {
          status := "found"
        } else {
          status := "missing"
        }
        match outcome {
          Ok v => {
            let scaled = v
          }
        }
      }
    }

    workflow place {
      create(orderId: int) {
        for oid in ids {
          let a = orderId
        }
      }
    }
  }
}`;

/** Every comment in the fixture — none of them may ever disappear. */
const COMMENTS = ["// the canonical creator"];

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

const BROKEN = SRC.replace("aggregate Order {", "aggregate Order {{");

const contextMembers = (src: string) =>
  parse(src)
    .members.flatMap((m) => ("members" in m ? m.members : []))
    .flatMap((m) => ("members" in m ? m.members : []));

const order = (src = SRC) =>
  contextMembers(src).find(
    (m) => m.$type === "Aggregate" && (m as { name?: string }).name === "Order",
  ) as never;

const confirm: BodyLocator = { kind: "operation", aggregate: "Order", op: "confirm" };

// Statement indexes inside `confirm`.
const FOR = 1;
const IFLET = 2;
const MATCH = 3;

describe("aggregate body reach — enumeration", () => {
  it("lists operations, creates, destroys and applies with stable keys", () => {
    expect(listBodies(order()).map((b) => `${b.key}=${b.count}`)).toEqual([
      "create=2",
      "create:draft=1",
      "destroy=1",
      "destroy:archive=1",
      "apply:Paid=1",
      "op:confirm=4",
    ]);
    expect(listBodies(order()).map((b) => b.label)).toEqual([
      "create",
      "create draft",
      "destroy",
      "destroy archive",
      "apply Paid",
      "operation confirm",
    ]);
  });

  it("disambiguates a repeated key with a `#n` suffix", () => {
    const twice = SRC.replace(
      '      destroy {\n        status := "gone"\n      }',
      '      destroy {\n        status := "gone"\n      }\n\n      destroy {\n        status := "again"\n      }',
    );
    expect(listBodies(order(twice)).map((b) => b.key)).toContain("destroy#1");
    expect(listStatements(parse(twice), aggregateBody("Order", "destroy#1"))).toEqual([
      'status := "again"',
    ]);
  });

  it("reports each member's own parameters and statements", () => {
    expect(aggregateBodyParamNames(order(), "create")).toEqual(["initial"]);
    expect(aggregateBodyParamNames(order(), "destroy:archive")).toEqual(["reason"]);
    expect(aggregateBodyParamNames(order(), "apply:Paid")).toEqual(["e"]);
    expect(aggregateBodyParamNames(order(), "destroy")).toEqual([]);
    expect(aggregateBodyParamNames(order(), "op:confirm")).toEqual(["n"]);
    expect(aggregateBodyStatements(order(), "create:draft").length).toBe(1);
    expect(aggregateBodyStatements(order(), "nope:x")).toEqual([]);
  });

  it("leaves a non-aggregate node alone", () => {
    const wf = contextMembers(SRC).find((m) => m.$type === "Workflow") as never;
    expect(aggregateBodyStatements(wf, "create")).toEqual([]);
    expect(aggregateBodyParamNames(wf, "create")).toEqual([]);
  });
});

describe("aggregate body reach — statement listing", () => {
  it("lists and structures a create / destroy / apply body by key", () => {
    expect(listStatements(parse(SRC), aggregateBody("Order", "create"))).toEqual([
      "total := initial",
      "for line in lines {\n          total += line.amount\n        }",
    ]);
    expect(listStatements(parse(SRC), aggregateBody("Order", "create:draft"))).toEqual([
      "status := note",
    ]);
    expect(listStatements(parse(SRC), aggregateBody("Order", "destroy:archive"))).toEqual([
      "status := reason",
    ]);
    expect(listStatementViews(parse(SRC), aggregateBody("Order", "apply:Paid"))).toEqual([
      { kind: "assign", target: "status", op: ":=", value: '"paid"' },
    ]);
  });

  it("structures a create body's container statement like any other", () => {
    const views = listStatementViews(parse(SRC), aggregateBody("Order", "create")) as StmtView[];
    expect(views.map((v) => v.kind)).toEqual(["assign", "for"]);
    const loop = views[1] as Extract<StmtView, { kind: "for" }>;
    expect(loop.binder).toBe("line");
    expect(loop.body.items).toEqual([
      { kind: "assign", target: "total", op: "+=", value: "line.amount" },
    ]);
  });

  it("keeps the historical operation locator working unchanged", () => {
    expect(listStatements(parse(SRC), confirm)?.[0]).toBe("precondition n > 0");
    // …and resolves identically through the member key.
    expect(listStatements(parse(SRC), aggregateBody("Order", "op:confirm"))).toEqual(
      listStatements(parse(SRC), confirm),
    );
  });

  it("returns null for an unknown member key or aggregate", () => {
    expect(listStatements(parse(SRC), aggregateBody("Order", "create:nope"))).toBeNull();
    expect(listStatements(parse(SRC), aggregateBody("Nope", "create"))).toBeNull();
    expect(listStatementViews(parse(SRC), aggregateBody("Order", "apply:Nope"))).toBeNull();
  });
});

describe("aggregate body reach — statement editing", () => {
  it("edits / adds / deletes / moves inside a create body", () => {
    expectHunk(
      SRC,
      editStatement(SRC, aggregateBody("Order", "create"), 0, "total := initial * 2"),
      ["        total := initial"],
      ["        total := initial * 2"],
    );
    expectHunk(
      SRC,
      addStatement(SRC, aggregateBody("Order", "create:draft"), 'status := "draft"'),
      [],
      ['        status := "draft"'],
    );
    expectHunk(
      SRC,
      deleteStatement(SRC, aggregateBody("Order", "destroy"), 0),
      ['        status := "gone"'],
      [],
    );
    expectHunk(
      SRC,
      moveStatement(SRC, aggregateBody("Order", "create"), 0, 1),
      [
        "        total := initial",
        "        for line in lines {",
        "          total += line.amount",
        "        }",
      ],
      [
        "        for line in lines {",
        "          total += line.amount",
        "        }",
        "        total := initial",
      ],
    );
    expectCommentsIntact(
      editStatement(SRC, aggregateBody("Order", "create"), 0, "total := initial * 2"),
    );
  });

  it("edits a statement nested inside a create body's block", () => {
    expectHunk(
      SRC,
      editStatement(
        SRC,
        aggregateBody("Order", "create"),
        [{ index: 1 }, { index: 0 }],
        "total += line.amount * 2",
      ),
      ["          total += line.amount"],
      ["          total += line.amount * 2"],
    );
  });

  it("rewrites one part of a nested container in a create body", () => {
    expectHunk(
      SRC,
      editStatementPart(SRC, aggregateBody("Order", "create"), 1, "name", "row"),
      ["        for line in lines {"],
      ["        for row in lines {"],
    );
  });

  it("opens an empty apply body with the first added statement", () => {
    const emptied = SRC.replace(
      '      apply(e: Paid) {\n        status := "paid"\n      }',
      "      apply(e: Paid) {\n      }",
    );
    expectHunk(
      emptied,
      addStatement(emptied, aggregateBody("Order", "apply:Paid"), 'status := "paid"'),
      [],
      ['        status := "paid"'],
    );
  });

  it("refuses a broken source and an unknown member", () => {
    expect(editStatement(BROKEN, aggregateBody("Order", "create"), 0, "total := 1")).toBeNull();
    expect(addStatement(SRC, aggregateBody("Order", "create:nope"), "total := 1")).toBeNull();
    expect(deleteStatement(SRC, aggregateBody("Order", "apply:Nope"), 0)).toBeNull();
  });
});

describe("statement addressing helpers", () => {
  it("statementAt resolves a flat index and a nested path", () => {
    const body = aggregateBodyStatements(order(), "create");
    expect(statementAt(body, 0)?.$cstNode?.text).toBe("total := initial");
    expect(statementAt(body, [{ index: 1 }, { index: 0 }])?.$cstNode?.text).toBe(
      "total += line.amount",
    );
    expect(statementAt(body, [{ index: 1 }, { index: 9 }])).toBeNull();
    expect(statementAt(body, [])).toBeNull();
  });

  it("nestedStmtLists reports each container's lists by descent key", () => {
    const body = listStatements(parse(SRC), confirm) as string[];
    expect(body.length).toBe(4);
    const stmts = aggregateBodyStatements(order(), "op:confirm");
    expect(nestedStmtLists(stmts[0]!)).toEqual([]);
    expect(nestedStmtLists(stmts[FOR]!).map((n) => n.list)).toEqual(["body"]);
    expect(nestedStmtLists(stmts[IFLET]!).map((n) => n.list)).toEqual(["then", "else"]);
    expect(nestedStmtLists(stmts[MATCH]!).map((n) => n.list)).toEqual([{ arm: 0 }]);
  });
});

describe("nested-statement expression slots", () => {
  const optionsFor = (src = SRC) => exprSlotOptions(order(src));
  const byValue = (value: string, src = SRC): ExprSlot => {
    const found = optionsFor(src).find((o) => o.value === value);
    expect(found, `no slot option ${value}`).toBeDefined();
    return (found as { slot: ExprSlot }).slot;
  };

  it("round-trips a descent path through the option-value encoding", () => {
    expect(encodeStmtPath([])).toBe("");
    expect(encodeStmtPath([{ index: 1, list: "body" }])).toBe("/b1");
    expect(
      encodeStmtPath([
        { index: 0, list: "then" },
        { index: 2, list: { arm: 3 } },
      ]),
    ).toBe("/t0/a3.2");
    expect(decodeStmtPath("/b1")).toEqual([{ index: 1, list: "body" }]);
    expect(decodeStmtPath("/t0/a3.2")).toEqual([
      { index: 0, list: "then" },
      { index: 2, list: { arm: 3 } },
    ]);
    expect(decodeStmtPath("/e4")).toEqual([{ index: 4, list: "else" }]);
    expect(decodeStmtPath("")).toEqual([]);
    // A malformed suffix is null, not "the top-level statement".
    expect(decodeStmtPath("/zz")).toBeNull();
    expect(decodeStmtPath("/b")).toBeNull();
  });

  it("offers a slot for every expression nested in a container statement", () => {
    const values = optionsFor().map((o) => o.value);
    // The top-level statements keep their historical bare values …
    expect(values).toContain("stmt:confirm:0");
    // … and each nested statement hangs off its container's index by path.
    expect(values).toContain("stmt:confirm:1/b0");
    expect(values).toContain("stmt:confirm:1/b1");
    expect(values).toContain("stmt:confirm:2/t0");
    expect(values).toContain("stmt:confirm:2/e0");
    expect(values).toContain("stmt:confirm:3/a0.0");
  });

  it("labels a nested option with the block it lives in", () => {
    const option = optionsFor().find((o) => o.value === "stmt:confirm:1/b0");
    expect(option?.label).toBe("confirm: body › let each = line.amount");
    expect(optionsFor().find((o) => o.value === "stmt:confirm:2/e0")?.label).toContain("else › ");
  });

  it("resolves a nested slot to that statement's own expression", () => {
    expect(slotExpr(parse(SRC), byValue("stmt:confirm:1/b0"))?.$cstNode?.text).toBe("line.amount");
    expect(slotExpr(parse(SRC), byValue("stmt:confirm:1/b1"))?.$cstNode?.text).toBe("each");
    expect(slotExpr(parse(SRC), byValue("stmt:confirm:2/e0"))?.$cstNode?.text).toBe('"missing"');
    expect(slotExpr(parse(SRC), byValue("stmt:confirm:3/a0.0"))?.$cstNode?.text).toBe("v");
  });

  it("edits a nested slot by splicing only that expression's span", () => {
    expectHunk(
      SRC,
      editExprSlot(SRC, byValue("stmt:confirm:1/b0"), "line.amount * 2"),
      ["          let each = line.amount"],
      ["          let each = line.amount * 2"],
    );
    expectHunk(
      SRC,
      editExprSlot(SRC, byValue("stmt:confirm:3/a0.0"), "v + 1"),
      ["            let scaled = v"],
      ["            let scaled = v + 1"],
    );
    expectCommentsIntact(editExprSlot(SRC, byValue("stmt:confirm:1/b1"), "each * 2"));
  });

  it("refuses an unparseable nested edit and an out-of-range path", () => {
    expect(editExprSlot(SRC, byValue("stmt:confirm:1/b0"), "line.")).toBeNull();
    const bogus: ExprSlot = {
      kind: "stmtExpr",
      owner: "Order",
      op: "confirm",
      index: 1,
      path: [{ index: 9, list: "body" }],
    };
    expect(slotExpr(parse(SRC), bogus)).toBeNull();
    expect(editExprSlot(SRC, bogus, "1")).toBeNull();
  });

  it("binds the container's binder and enclosing lets at a nested slot", () => {
    const names = slotCandidates(parse(SRC), byValue("stmt:confirm:1/b1"));
    expect(names).toContain("n"); // the operation's parameter
    expect(names).toContain("line"); // the `for` binder
    expect(names).toContain("each"); // the let declared earlier in the block
    // The arm binder is in scope inside its own arm.
    expect(slotCandidates(parse(SRC), byValue("stmt:confirm:3/a0.0"))).toContain("v");
    // …and the if-let binder inside the `then` branch only.
    expect(slotCandidates(parse(SRC), byValue("stmt:confirm:2/t0"))).toContain("hit");
    expect(slotCandidates(parse(SRC), byValue("stmt:confirm:2/e0"))).not.toContain("hit");
  });

  it("hangs nested slots off a workflow member body too", () => {
    const wf = contextMembers(SRC).find((m) => m.$type === "Workflow") as never;
    const option = workflowSlotOptions(wf).find((o) => o.value === "wf:0/b0");
    expect(option?.label).toBe("body › let a = orderId");
    expect(slotExpr(parse(SRC), option?.slot as ExprSlot)?.$cstNode?.text).toBe("orderId");
    expect(slotCandidates(parse(SRC), option?.slot as ExprSlot)).toContain("oid");
    expectHunk(
      SRC,
      editExprSlot(SRC, option?.slot as ExprSlot, "orderId + 1"),
      ["          let a = orderId"],
      ["          let a = orderId + 1"],
    );
  });
});

describe("aggregate member expression slots", () => {
  it("offers the create / destroy / apply bodies alongside the operations", () => {
    const values = exprSlotOptions(order()).map((o) => o.value);
    expect(values).toContain("stmt:confirm:0");
    expect(values).toContain("stmt@create:0");
    expect(values).toContain("stmt@create:1/b0");
    expect(values).toContain("stmt@create:draft:0");
    expect(values).toContain("stmt@destroy:archive:0");
    expect(values).toContain("stmt@apply:Paid:0");
    // No duplicate `stmt@op:…` entry for an operation already enumerated.
    expect(values.filter((v) => v.startsWith("stmt@op:"))).toEqual([]);
  });

  it("resolves and edits a create-body slot", () => {
    const slot = exprSlotOptions(order()).find((o) => o.value === "stmt@create:0")
      ?.slot as ExprSlot;
    expect(slotExpr(parse(SRC), slot)?.$cstNode?.text).toBe("initial");
    expectHunk(
      SRC,
      editExprSlot(SRC, slot, "initial * 2"),
      ["        total := initial"],
      ["        total := initial * 2"],
    );
  });

  it("binds the member's own parameters for a create-body slot", () => {
    const slot = exprSlotOptions(order()).find((o) => o.value === "stmt@create:1/b0")
      ?.slot as ExprSlot;
    const names = slotCandidates(parse(SRC), slot);
    expect(names).toContain("initial"); // the create's parameter
    expect(names).toContain("line"); // the `for` binder
    const applySlot = exprSlotOptions(order()).find((o) => o.value === "stmt@apply:Paid:0")
      ?.slot as ExprSlot;
    expect(slotCandidates(parse(SRC), applySlot)).toContain("e");
  });
});
