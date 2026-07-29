// The composition contracts the v2 pane's wiring depends on.
//
// `op-surface.test.ts` and `aggregate-bodies.test.ts` pin each pure mutator on
// its own.  These tests pin the way the PANE composes them — the assumptions
// baked into the body picker, the nested `ƒx` rows and the two header
// inspectors, none of which any single-module suite asserts:
//
//  * picking the operation the drill path already names must resolve to the
//    HISTORICAL member-less locator, byte for byte, or every pre-existing
//    expression-slot key silently re-points;
//  * the `StmtPath` the nested rows build (`[...enclosing, {index, list}]`)
//    must be the same address `slotExpr` / `editExprSlot` resolve, and must
//    key distinctly from its top-level statement;
//  * the inspectors' "empty field = drop the clause" convention and the
//    `ignoring` text→spec mapping must round-trip through the readers.

import { describe, expect, it } from "vitest";
import {
  addStatement,
  aggregateBody,
  type BodyKey,
  deleteStatement,
  editStatement,
  listBodies,
  listStatements,
  listStatementViews,
  moveStatement,
} from "../../../web/src/builder/system/body.js";
import {
  type ExprSlot,
  editExprSlot,
  encodeStmtPath,
  slotCandidates,
  slotExpr,
} from "../../../web/src/builder/system/expr-slots.js";
import {
  findSurface,
  opSurface,
  setFindGate,
  setFindIgnoring,
  setOpGate,
  setOpReturnType,
} from "../../../web/src/builder/system/op-surface.js";
import { parseRaw as parse } from "../../_helpers/index.js";

const SRC = `system Shop {

  context Sales {

    event Paid { at: datetime }

    aggregate Order {
      status: string
      total: decimal = 0

      create(initial: decimal) {
        total := initial
      }

      destroy archive(reason: string) {
        status := reason
      }

      apply(e: Paid) {
        status := "paid"
      }

      operation confirm(n: int) requires isOwner {
        precondition n > 0
        for line in lines {
          let each = line.amount
          total += each
        }
      }
    }

    repository Orders for Order {
      find byStatus(s: string): Order[] where status == s
    }
  }
}`;

const agg = () => {
  const ast = parse(SRC);
  for (const m of ast.members) {
    if (m.$type === "System") {
      for (const sm of (m as { members: { $type: string }[] }).members) {
        if (sm.$type === "BoundedContext") {
          for (const cm of (sm as unknown as { members: { $type: string; name?: string }[] })
            .members) {
            if (cm.$type === "Aggregate" && cm.name === "Order") return cm as never;
          }
        }
      }
    }
  }
  throw new Error("Order not found");
};

// The pane's own rule (`primaryBodyKey`): on an operation leaf the picker
// highlights `op:<the operation the path names>`.
const primaryKey = (opName: string): BodyKey => `op:${opName}`;

describe("body picker — the keys the pane offers on an operation leaf", () => {
  it("lists the aggregate's operations AND its lifecycle bodies", () => {
    expect(listBodies(agg()).map((b) => b.key)).toEqual([
      "create",
      "destroy:archive",
      "apply:Paid",
      "op:confirm",
    ]);
  });

  it("the highlighted primary key is one the picker actually lists", () => {
    const keys = listBodies(agg()).map((b) => b.key);
    expect(keys).toContain(primaryKey("confirm"));
  });

  it("picking the primary op resolves to the historical member-less locator", () => {
    // The pane clears the override for an `op:` key rather than pinning it —
    // this is the equivalence that makes that safe.
    const ast = parse(SRC);
    const historical = listStatements(ast, {
      kind: "operation",
      aggregate: "Order",
      op: "confirm",
    });
    const viaKey = listStatements(ast, aggregateBody("Order", primaryKey("confirm")));
    expect(viaKey).toEqual(historical);
    expect(historical).not.toBeNull();
  });

  it("a lifecycle key drives every statement mutator the panel exposes", () => {
    const loc = aggregateBody("Order", "destroy:archive");
    expect(listStatementViews(parse(SRC), loc)?.map((v) => v.kind)).toEqual(["assign"]);

    const added = addStatement(SRC, loc, 'status := "x"');
    expect(added).not.toBeNull();
    expect(listStatements(parse(added as string), loc)).toHaveLength(2);

    const moved = moveStatement(added as string, loc, 0, 1);
    expect(moved).not.toBeNull();
    expect(listStatements(parse(moved as string), loc)?.[0]).toBe('status := "x"');

    const edited = editStatement(added as string, loc, 1, 'status := "y"');
    expect(listStatements(parse(edited as string), loc)?.[1]).toBe('status := "y"');

    const deleted = deleteStatement(added as string, loc, 1);
    expect(listStatements(parse(deleted as string), loc)).toHaveLength(1);
  });

  it("a lifecycle body's statements are reachable but its operation name is not", () => {
    // `apply:Paid` has no operation name — reaching it is exactly what the
    // member key is for.
    expect(
      listStatements(parse(SRC), { kind: "operation", aggregate: "Order", op: "apply" }),
    ).toBeNull();
    expect(listStatements(parse(SRC), aggregateBody("Order", "apply:Paid"))).toEqual([
      'status := "paid"',
    ]);
  });
});

describe("nested ƒx rows — the path the container rows build", () => {
  // `NestedList` gives child `i` of the enclosing statement's `list` the path
  // `[...enclosingPath, { index: i, list }]`.  Statement 1 of `confirm` is the
  // `for` loop; its body's second statement is `total += each`.
  const nestedPath = [{ index: 1, list: "body" as const }];
  const slot = (path: typeof nestedPath | []): ExprSlot => ({
    kind: "stmtExpr",
    owner: "Order",
    op: "confirm",
    index: 1,
    ...(path.length > 0 ? { path } : {}),
  });

  it("resolves the nested statement's expression (the top-level index alone does not)", () => {
    const ast = parse(SRC);
    // The `for` statement itself has no editable expression slot.
    expect(slotExpr(ast, slot([]))).toBeNull();
    expect(slotExpr(ast, slot(nestedPath))?.$cstNode?.text).toBe("each");
  });

  it("keys distinctly from its top-level statement", () => {
    expect(encodeStmtPath([])).toBe("");
    expect(encodeStmtPath(nestedPath)).toBe("/b1");
    // The pane's key template: `${base}:${index}${encodeStmtPath(path)}:${field}`.
    const key = (p: typeof nestedPath | []): string => `Order.confirm:1${encodeStmtPath(p)}:`;
    expect(key(nestedPath)).not.toBe(key([]));
  });

  it("sees the enclosing loop binder and the nested let in scope", () => {
    const names = slotCandidates(parse(SRC), slot(nestedPath));
    expect(names).toContain("line");
    expect(names).toContain("each");
  });

  it("commits through the nested slot without disturbing the enclosing block", () => {
    const next = editExprSlot(SRC, slot(nestedPath), "each * 2");
    expect(next).not.toBeNull();
    expect(next as string).toContain("total += each * 2");
    expect(next as string).toContain("let each = line.amount");
  });
});

describe("operation inspector — the setter conventions the fields rely on", () => {
  const surface = (src: string) => opSurface(parse(src), "Order", "confirm");

  it("reads the header the inspector renders", () => {
    const s = surface(SRC);
    expect(s?.params.map((p) => `${p.name}:${p.baseLabel}`)).toEqual(["n:int"]);
    expect(s?.requires).toBe("isOwner");
    expect(s?.when).toBeNull();
    expect(s?.returnTypeText).toBeNull();
  });

  it("an emptied gate field drops the clause; re-typing puts it back", () => {
    const dropped = setOpGate(SRC, "Order", "confirm", "requires", null);
    expect(surface(dropped as string)?.requires).toBeNull();
    const restored = setOpGate(dropped as string, "Order", "confirm", "requires", "isOwner");
    expect(surface(restored as string)?.requires).toBe("isOwner");
  });

  it("dropping an absent clause is a no-op, not a failure", () => {
    // The inspector commits on blur; blurring an already-empty field must not
    // rewrite the document (and must not read as a rejected edit).
    expect(setOpGate(SRC, "Order", "confirm", "when", null)).toBe(SRC);
    expect(setOpReturnType(SRC, "Order", "confirm", null)).toBe(SRC);
  });

  it("round-trips a return type through the field's raw text", () => {
    // The field shows `returnTypeText` and commits it back verbatim, so the
    // reader's spelling has to be the one the setter accepts (no `:` prefix).
    const typed = setOpReturnType(SRC, "Order", "confirm", "decimal") as string;
    expect(surface(typed)?.returnTypeText).toBe("decimal");
    expect(setOpReturnType(typed, "Order", "confirm", "decimal")).toBe(typed);
  });
});

describe("find inspector — the ignoring text→spec mapping", () => {
  // The pane maps the field's text: "" → null (drop), "*" → "*", else a
  // comma-split name list.
  const specOf = (text: string): "*" | string[] | null => {
    const t = text.trim();
    return t === "" ? null : t === "*" ? "*" : t.split(",").map((s) => s.trim());
  };
  const surface = (src: string) => findSurface(parse(src), "Orders", "byStatus");

  it("starts with neither clause", () => {
    expect(surface(SRC)?.requires).toBeNull();
    expect(surface(SRC)?.ignoring).toBeNull();
    expect(surface(SRC)?.where).toBe("status == s");
  });

  it("a bare * bypasses every capability filter", () => {
    const next = setFindIgnoring(SRC, "Orders", "byStatus", specOf("*"));
    expect(surface(next as string)?.ignoring).toBe("*");
  });

  it("a comma list bypasses exactly those, whitespace and all", () => {
    const next = setFindIgnoring(
      SRC,
      "Orders",
      "byStatus",
      specOf(" tenantOwned , softDeletable "),
    );
    expect(surface(next as string)?.ignoring).toEqual(["tenantOwned", "softDeletable"]);
  });

  it("emptying the field drops the clause and leaves the where filter intact", () => {
    const set = setFindIgnoring(SRC, "Orders", "byStatus", specOf("*")) as string;
    const cleared = setFindIgnoring(set, "Orders", "byStatus", specOf("")) as string;
    expect(surface(cleared)?.ignoring).toBeNull();
    expect(surface(cleared)?.where).toBe("status == s");
    expect(cleared).toBe(SRC);
  });

  it("the requires gate slots in before the where filter", () => {
    const next = setFindGate(SRC, "Orders", "byStatus", "isOwner") as string;
    expect(surface(next)?.requires).toBe("isOwner");
    expect(surface(next)?.where).toBe("status == s");
  });
});
