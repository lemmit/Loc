// Direct unit tests for the Python backend's `renderPyExpr` /
// `renderPyType` / `renderPyStatements` — one pin per ExprIR kind plus
// per-kind variants worth locking against regressions.  Mirrors
// `test/generator/typescript/render-expr-kinds.test.ts`.

import { describe, expect, it } from "vitest";
import {
  collectPyExprImports,
  renderPyExpr,
  renderPyType,
} from "../../../src/generator/python/render-expr.js";
import { renderPyStatements } from "../../../src/generator/python/render-stmt.js";
import type { ExprIR, StmtIR, TypeIR } from "../../../src/ir/types/loom-ir.js";

const STRING: TypeIR = { kind: "primitive", name: "string" };
const INT: TypeIR = { kind: "primitive", name: "int" };
const MONEY: TypeIR = { kind: "primitive", name: "money" };
const BOOL: TypeIR = { kind: "primitive", name: "bool" };

const litInt = (v: string): ExprIR => ({ kind: "literal", lit: "int", value: v });
const litStr = (v: string): ExprIR => ({ kind: "literal", lit: "string", value: v });
const litMoney = (v: string): ExprIR => ({ kind: "literal", lit: "money", value: v });
const litBool = (v: "true" | "false"): ExprIR => ({ kind: "literal", lit: "bool", value: v });
const refParam = (name: string): ExprIR => ({ kind: "ref", name, refKind: "param" });
const thisProp = (name: string): ExprIR => ({ kind: "ref", name, refKind: "this-prop" });

describe("py renderPyExpr — literals", () => {
  it("renders string literals JSON-quoted (valid Python)", () => {
    expect(renderPyExpr(litStr("hello"))).toBe('"hello"');
    expect(renderPyExpr(litStr('say "hi"'))).toBe('"say \\"hi\\""');
  });

  it("renders int literals verbatim", () => {
    expect(renderPyExpr(litInt("42"))).toBe("42");
  });

  it("renders `now` as timezone-aware UTC", () => {
    expect(renderPyExpr({ kind: "literal", lit: "now", value: "" })).toBe("datetime.now(UTC)");
  });

  it("renders `null` as None", () => {
    expect(renderPyExpr({ kind: "literal", lit: "null", value: "" })).toBe("None");
  });

  it('renders money literals as Decimal("…")', () => {
    expect(renderPyExpr(litMoney("9.99"))).toBe('Decimal("9.99")');
  });

  it("renders bool literals capitalised", () => {
    expect(renderPyExpr(litBool("true"))).toBe("True");
    expect(renderPyExpr(litBool("false"))).toBe("False");
  });
});

describe("py renderPyExpr — `this` / `id` receiver shapes", () => {
  it("renders `this` as ctx.thisName (self by default)", () => {
    expect(renderPyExpr({ kind: "this" })).toBe("self");
    expect(renderPyExpr({ kind: "this" }, { thisName: "r" })).toBe("r");
  });

  it("renders `id` as `self._id` inside the class, `<row>.id` outside", () => {
    expect(renderPyExpr({ kind: "id" })).toBe("self._id");
    expect(renderPyExpr({ kind: "id" }, { thisName: "r" })).toBe("r.id");
  });
});

describe("py renderPyExpr — refs (snake_case folding)", () => {
  it("renders param / let / lambda refs snake_cased", () => {
    expect(renderPyExpr(refParam("orderNumber"))).toBe("order_number");
    expect(renderPyExpr({ kind: "ref", name: "newTotal", refKind: "let" })).toBe("new_total");
    expect(renderPyExpr({ kind: "ref", name: "i", refKind: "lambda" })).toBe("i");
  });

  it("renders this-prop refs as private backing fields inside the class", () => {
    expect(renderPyExpr(thisProp("customerName"))).toBe("self._customer_name");
  });

  it("renders this-prop refs as public attrs from outside (row scope)", () => {
    expect(renderPyExpr(thisProp("customerName"), { thisName: "r" })).toBe("r.customer_name");
  });

  it("renders derived / vo-prop refs through the property", () => {
    expect(renderPyExpr({ kind: "ref", name: "grandTotal", refKind: "this-derived" })).toBe(
      "self.grand_total",
    );
  });

  it("renders helper-fn refs `_`-prefixed", () => {
    expect(renderPyExpr({ kind: "ref", name: "lineTotal", refKind: "helper-fn" })).toBe(
      "self._line_total",
    );
  });

  it("renders enum values as <Enum>.<Value>", () => {
    expect(
      renderPyExpr({ kind: "ref", name: "Confirmed", refKind: "enum-value", enumName: "Status" }),
    ).toBe("Status.Confirmed");
  });

  it("renders currentUser as current_user", () => {
    expect(renderPyExpr({ kind: "ref", name: "currentUser", refKind: "current-user" })).toBe(
      "current_user",
    );
  });
});

describe("py renderPyExpr — member / method-call", () => {
  it("renders member access snake_cased", () => {
    expect(
      renderPyExpr({
        kind: "member",
        receiver: refParam("order"),
        member: "placedAt",
        receiverType: { kind: "entity", name: "Order" },
        memberType: { kind: "primitive", name: "datetime" },
      }),
    ).toBe("order.placed_at");
  });

  it("renders array count and string length via len()", () => {
    expect(
      renderPyExpr({
        kind: "member",
        receiver: thisProp("lines"),
        member: "count",
        receiverType: { kind: "array", element: { kind: "entity", name: "OrderLine" } },
        memberType: INT,
      }),
    ).toBe("len(self._lines)");
    expect(
      renderPyExpr({
        kind: "member",
        receiver: refParam("name"),
        member: "length",
        receiverType: STRING,
        memberType: INT,
      }),
    ).toBe("len(name)");
  });

  it("renders the string.trim intrinsic as .strip(), not .trim() (stdlib A1)", () => {
    expect(
      renderPyExpr({
        kind: "method-call",
        receiver: refParam("name"),
        member: "trim",
        args: [],
        receiverType: STRING,
        memberType: STRING,
        isCollectionOp: false,
      }),
    ).toBe("name.strip()");
  });

  it("renders string.matches via re.search", () => {
    expect(
      renderPyExpr({
        kind: "method-call",
        receiver: refParam("email"),
        member: "matches",
        args: [litStr("^[^@]+@")],
        receiverType: STRING,
        memberType: BOOL,
        isCollectionOp: false,
      }),
    ).toBe('re.search("^[^@]+@", email) is not None');
  });
});

describe("py renderPyExpr — collection ops", () => {
  const lines: ExprIR = thisProp("lines");
  const arr = (member: string, args: ExprIR[] = []): ExprIR => ({
    kind: "method-call",
    receiver: lines,
    member,
    args,
    receiverType: { kind: "array", element: { kind: "entity", name: "OrderLine" } },
    memberType: INT,
    isCollectionOp: true,
  });
  const lam = (body: ExprIR): ExprIR => ({ kind: "lambda", param: "l", body });

  it("count → len()", () => {
    expect(renderPyExpr(arr("count"))).toBe("len(self._lines)");
  });

  it("sum with selector → generator expression", () => {
    expect(
      renderPyExpr(
        arr("sum", [
          lam({
            kind: "member",
            receiver: { kind: "ref", name: "l", refKind: "lambda" },
            member: "quantity",
            receiverType: { kind: "entity", name: "OrderLine" },
            memberType: INT,
          }),
        ]),
      ),
    ).toBe("sum((lambda l: l.quantity)(__x) for __x in self._lines)");
  });

  it("sum without selector → builtin sum", () => {
    expect(renderPyExpr(arr("sum"))).toBe("sum(self._lines)");
  });

  it("all / any → builtin folds", () => {
    expect(renderPyExpr(arr("all", [lam(litBool("true"))]))).toBe(
      "all((lambda l: True)(__x) for __x in self._lines)",
    );
    expect(renderPyExpr(arr("any", [lam(litBool("true"))]))).toBe(
      "any((lambda l: True)(__x) for __x in self._lines)",
    );
    expect(renderPyExpr(arr("any"))).toBe("len(self._lines) > 0");
  });

  it("contains → `in`", () => {
    expect(renderPyExpr(arr("contains", [refParam("line")]))).toBe("line in self._lines");
  });

  it("where → list comprehension; first / firstOrNull → subscripts", () => {
    expect(renderPyExpr(arr("where", [lam(litBool("true"))]))).toBe(
      "[__x for __x in self._lines if (lambda l: True)(__x)]",
    );
    expect(renderPyExpr(arr("first"))).toBe("self._lines[0]");
    expect(renderPyExpr(arr("firstOrNull"))).toBe("(self._lines[0] if self._lines else None)");
  });
});

describe("py renderPyExpr — calls / new / object / list", () => {
  it("value-object ctor renders as a class call", () => {
    expect(
      renderPyExpr({
        kind: "call",
        callKind: "value-object-ctor",
        name: "Money",
        args: [litInt("5"), litStr("USD")],
      }),
    ).toBe('Money(5, "USD")');
  });

  it("function calls render `_`-prefixed; op calls follow the target's privacy", () => {
    // A `function` is always a private method (`def _line_total`).
    expect(
      renderPyExpr({ kind: "call", callKind: "function", name: "lineTotal", args: [litInt("1")] }),
    ).toBe("self._line_total(1)");
    // A public operation self-call has no underscore (`def reserve` ⇒ `self.reserve()`).
    expect(
      renderPyExpr({ kind: "call", callKind: "private-operation", name: "recalc", args: [] }),
    ).toBe("self.recalc()");
    // A `private operation` self-call keeps the underscore.
    expect(
      renderPyExpr({
        kind: "call",
        callKind: "private-operation",
        name: "recalc",
        args: [],
        targetPrivate: true,
      }),
    ).toBe("self._recalc()");
  });

  it("new part renders the _create classmethod with id + parent_id kwargs", () => {
    expect(
      renderPyExpr({
        kind: "new",
        partName: "OrderLine",
        fields: [{ name: "quantity", value: litInt("2") }],
      }),
    ).toBe("OrderLine._create(id=new_order_line_id(), parent_id=self._id, quantity=2)");
  });

  it("object literals render as dicts; lists as list literals", () => {
    expect(renderPyExpr({ kind: "object", fields: [{ name: "a", value: litInt("1") }] })).toBe(
      '{"a": 1}',
    );
    expect(renderPyExpr({ kind: "list", elements: [litInt("1"), litInt("2")] })).toBe("[1, 2]");
  });
});

describe("py renderPyExpr — operators / ternary / match / convert", () => {
  const bin = (op: "&&" | "||" | "==" | "!=" | "+", left: ExprIR, right: ExprIR): ExprIR => ({
    kind: "binary",
    op,
    left,
    right,
    leftType: undefined,
  });

  it("renders && / || as and / or", () => {
    expect(renderPyExpr(bin("&&", litBool("true"), litBool("false")))).toBe("True and False");
    expect(renderPyExpr(bin("||", litBool("true"), litBool("false")))).toBe("True or False");
  });

  it("renders ! as not; unary minus natively", () => {
    expect(renderPyExpr({ kind: "unary", op: "!", operand: refParam("active") })).toBe(
      "not active",
    );
    expect(renderPyExpr({ kind: "unary", op: "-", operand: litInt("5") })).toBe("-5");
  });

  it("money arithmetic stays native (Decimal overloads operators)", () => {
    expect(
      renderPyExpr({
        kind: "binary",
        op: "+",
        left: thisProp("total"),
        right: litMoney("1.50"),
        leftType: MONEY,
      }),
    ).toBe('self._total + Decimal("1.50")');
  });

  it("renders ternary as a conditional expression", () => {
    expect(
      renderPyExpr({
        kind: "ternary",
        cond: refParam("ok"),
        // biome-ignore lint/suspicious/noThenProperty: the ternary IR node's branch field is named `then`
        then: litInt("1"),
        otherwise: litInt("2"),
      }),
    ).toBe("(1 if ok else 2)");
  });

  it("renders match as right-folded conditional expressions", () => {
    expect(
      renderPyExpr({
        kind: "match",
        arms: [
          { cond: refParam("a"), value: litInt("1") },
          { cond: refParam("b"), value: litInt("2") },
        ],
        otherwise: litInt("0"),
      }),
    ).toBe("(1 if a else (2 if b else 0))");
  });

  it("renders converts per (from, target) pair", () => {
    const conv = (target: string, from: string | undefined, v: ExprIR): ExprIR => ({
      kind: "convert",
      target: target as never,
      from: from as never,
      value: v,
    });
    expect(renderPyExpr(conv("string", "int", litInt("4")))).toBe("str(4)");
    expect(renderPyExpr(conv("string", "datetime", refParam("placedAt")))).toBe(
      "placed_at.isoformat()",
    );
    expect(renderPyExpr(conv("money", "int", litInt("4")))).toBe("Decimal(str(4))");
    expect(renderPyExpr(conv("money", "money", refParam("total")))).toBe("total");
    expect(renderPyExpr(conv("decimal", "money", refParam("total")))).toBe("float(total)");
    expect(renderPyExpr(conv("long", "int", litInt("4")))).toBe("int(4)");
  });
});

describe("py renderPyType", () => {
  it("maps primitives", () => {
    expect(renderPyType(INT)).toBe("int");
    expect(renderPyType({ kind: "primitive", name: "long" })).toBe("int");
    expect(renderPyType({ kind: "primitive", name: "decimal" })).toBe("float");
    expect(renderPyType(MONEY)).toBe("Decimal");
    expect(renderPyType(STRING)).toBe("str");
    expect(renderPyType({ kind: "primitive", name: "guid" })).toBe("str");
    expect(renderPyType(BOOL)).toBe("bool");
    expect(renderPyType({ kind: "primitive", name: "datetime" })).toBe("datetime");
    expect(renderPyType({ kind: "primitive", name: "json" })).toBe("object");
  });

  it("maps ids, enums, VOs, arrays, optionals", () => {
    expect(renderPyType({ kind: "id", targetName: "Order" })).toBe("OrderId");
    expect(renderPyType({ kind: "enum", name: "Status" })).toBe("Status");
    expect(renderPyType({ kind: "valueobject", name: "Money" })).toBe("Money");
    expect(renderPyType({ kind: "array", element: STRING })).toBe("list[str]");
    expect(renderPyType({ kind: "optional", inner: INT })).toBe("int | None");
  });
});

describe("py renderPyStatements", () => {
  const I = "        ";

  it("renders preconditions as raise-guards", () => {
    const s: StmtIR = {
      kind: "precondition",
      expr: refParam("ok"),
      source: "ok",
    };
    expect(renderPyStatements([s])).toBe(
      `${I}if not (ok):\n${I}    raise DomainError("Precondition failed: ok")`,
    );
  });

  it("renders let / assign / add snake_cased", () => {
    expect(
      renderPyStatements([{ kind: "let", name: "newTotal", expr: litInt("1") } as StmtIR]),
    ).toBe(`${I}new_total = 1`);
    expect(
      renderPyStatements([
        { kind: "assign", target: { segments: ["unitPrice"] }, value: litInt("2") } as StmtIR,
      ]),
    ).toBe(`${I}self._unit_price = 2`);
    expect(
      renderPyStatements([
        { kind: "add", target: { segments: ["lines"] }, value: refParam("line") } as StmtIR,
      ]),
    ).toBe(`${I}self._lines.append(line)`);
  });

  it("renders remove via a guarded list.remove", () => {
    const out = renderPyStatements([
      { kind: "remove", target: { segments: ["lines"] }, value: refParam("line") } as StmtIR,
    ]);
    expect(out).toBe(
      `${I}__rm = line\n${I}if __rm in self._lines:\n${I}    self._lines.remove(__rm)`,
    );
  });

  it("renders emit as an event dataclass append (kwargs snake_cased)", () => {
    const out = renderPyStatements([
      {
        kind: "emit",
        eventName: "OrderConfirmed",
        fields: [{ name: "orderId", value: { kind: "id" } }],
      } as StmtIR,
    ]);
    expect(out).toBe(`${I}self._events.append(OrderConfirmed(order_id=self._id))`);
  });

  it("event-sourced emit records AND folds", () => {
    const out = renderPyStatements(
      [{ kind: "emit", eventName: "Opened", fields: [] } as StmtIR],
      undefined,
      { eventSourced: true },
    );
    expect(out).toBe(`${I}__ev = Opened()\n${I}self._events.append(__ev)\n${I}self._apply(__ev)`);
  });

  it("renders op self-calls (public bare, private underscored) and returns", () => {
    // A public operation self-call has no underscore (`def reserve` ⇒ `self.reserve()`).
    expect(
      renderPyStatements([
        { kind: "call", target: "private-operation", name: "recalcTotals", args: [] } as StmtIR,
      ]),
    ).toBe(`${I}self.recalc_totals()`);
    // A `private operation` self-call keeps the underscore (`def _recalc` ⇒ `self._recalc()`).
    expect(
      renderPyStatements([
        {
          kind: "call",
          target: "private-operation",
          name: "recalcTotals",
          args: [],
          targetPrivate: true,
        } as StmtIR,
      ]),
    ).toBe(`${I}self._recalc_totals()`);
    expect(renderPyStatements([{ kind: "return", value: litInt("1") } as StmtIR])).toBe(
      `${I}return 1`,
    );
  });
});

describe("py collectPyExprImports", () => {
  it("collects decimal / datetime / re triggers", () => {
    expect([...collectPyExprImports(litMoney("1"))]).toEqual(["decimal"]);
    expect([...collectPyExprImports({ kind: "literal", lit: "now", value: "" })]).toEqual([
      "datetime",
    ]);
    const matches: ExprIR = {
      kind: "method-call",
      receiver: refParam("email"),
      member: "matches",
      args: [litStr("@")],
      receiverType: STRING,
      memberType: BOOL,
      isCollectionOp: false,
    };
    expect([...collectPyExprImports(matches)]).toEqual(["re"]);
  });
});
