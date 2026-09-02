// Direct unit tests for the TypeScript backend's `renderTsExpr` — one
// pin per ExprIR kind plus per-kind variants worth locking against
// regressions.  Mirrors the dispatch table in
// `src/generator/typescript/render-expr.ts:28-88`.
//
// Pattern follows `test/generator/elixir/phoenix-render-expr.test.ts`.
// These tests run in <50ms total; the TS emitter is pure string emission
// with no IO or class instantiation.

import { describe, expect, it } from "vitest";
import { renderTsExpr, renderTsType } from "../../../src/generator/typescript/render-expr.js";
import type { ExprIR, TypeIR } from "../../../src/ir/types/loom-ir.js";

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

describe("ts renderTsExpr — literals", () => {
  it("renders string literals JSON-quoted", () => {
    expect(renderTsExpr(litStr("hello"))).toBe('"hello"');
  });

  it("renders int literals verbatim", () => {
    expect(renderTsExpr(litInt("42"))).toBe("42");
  });

  it("renders `now` as `new Date()`", () => {
    expect(renderTsExpr({ kind: "literal", lit: "now", value: "" })).toBe("new Date()");
  });

  it("renders `null` as the bare null keyword", () => {
    expect(renderTsExpr({ kind: "literal", lit: "null", value: "" })).toBe("null");
  });

  it('renders money literals as `new Decimal("…")`', () => {
    expect(renderTsExpr(litMoney("9.99"))).toBe('new Decimal("9.99")');
  });

  it("renders bool literals verbatim", () => {
    expect(renderTsExpr(litBool("true"))).toBe("true");
    expect(renderTsExpr(litBool("false"))).toBe("false");
  });
});

describe("ts renderTsExpr — `this` / `id` receiver shapes", () => {
  it("renders `this` as ctx.thisName", () => {
    expect(renderTsExpr({ kind: "this" })).toBe("this");
    expect(renderTsExpr({ kind: "this" }, { thisName: "r" })).toBe("r");
  });

  it("renders `id` as `this._id` inside the class", () => {
    expect(renderTsExpr({ kind: "id" })).toBe("this._id");
  });

  it("renders `id` as `<row>.id` from outside the class (view bind / row scope)", () => {
    expect(renderTsExpr({ kind: "id" }, { thisName: "r" })).toBe("r.id");
  });
});

describe("ts renderTsExpr — refs", () => {
  it("renders param / let / lambda refs by bare name", () => {
    expect(renderTsExpr(refParam("orderNumber"))).toBe("orderNumber");
    expect(renderTsExpr({ kind: "ref", name: "x", refKind: "let" })).toBe("x");
    expect(renderTsExpr({ kind: "ref", name: "i", refKind: "lambda" })).toBe("i");
  });

  it("renders this-prop refs as `this._<name>` inside the class", () => {
    expect(renderTsExpr(thisProp("customerName"))).toBe("this._customerName");
  });

  it("renders this-prop refs as `<row>.<name>` from outside (public getter)", () => {
    expect(renderTsExpr(thisProp("customerName"), { thisName: "r" })).toBe("r.customerName");
  });

  it("renders enum-value refs as <enumName>.<name>", () => {
    expect(
      renderTsExpr({
        kind: "ref",
        name: "Active",
        refKind: "enum-value",
        enumName: "Status",
      }),
    ).toBe("Status.Active");
  });

  it("renders `currentUser` ref verbatim", () => {
    expect(renderTsExpr({ kind: "ref", name: "currentUser", refKind: "current-user" })).toBe(
      "currentUser",
    );
  });

  it("renders helper-fn refs with lowerFirst on the name", () => {
    expect(renderTsExpr({ kind: "ref", name: "FormatName", refKind: "helper-fn" })).toBe(
      "this.formatName",
    );
  });
});

describe("ts renderTsExpr — member + method-call", () => {
  it("renders member access as `<recv>.<member>`", () => {
    expect(
      renderTsExpr({
        kind: "member",
        receiver: thisProp("address"),
        member: "city",
        receiverType: { kind: "valueobject", name: "Address" },
        memberType: STRING,
      }),
    ).toBe("this._address.city");
  });

  it("collapses array.count → `.length`", () => {
    expect(
      renderTsExpr({
        kind: "member",
        receiver: thisProp("items"),
        member: "count",
        receiverType: { kind: "array", element: STRING },
        memberType: INT,
      }),
    ).toBe("this._items.length");
  });

  it("renders `string.matches(literal)` as `/pattern/.test(recv)`", () => {
    expect(
      renderTsExpr({
        kind: "method-call",
        receiver: thisProp("email"),
        member: "matches",
        args: [litStr("^[^@]+@.+$")],
        receiverType: STRING,
        isCollectionOp: false,
      }),
    ).toBe("/^[^@]+@.+$/.test(this._email)");
  });

  it("renders the `string.trim()` intrinsic via the catalogue snippet", () => {
    expect(
      renderTsExpr({
        kind: "method-call",
        receiver: thisProp("name"),
        member: "trim",
        args: [],
        receiverType: STRING,
        isCollectionOp: false,
      }),
    ).toBe("this._name.trim()");
  });

  it("renders the A2 string intrinsics via the catalogue snippets", () => {
    const call = (member: string, args: ReturnType<typeof litStr>[] = []) =>
      renderTsExpr({
        kind: "method-call",
        receiver: thisProp("name"),
        member,
        args,
        receiverType: STRING,
        isCollectionOp: false,
      });
    expect(call("toUpper")).toBe("this._name.toUpperCase()");
    expect(call("toLower")).toBe("this._name.toLowerCase()");
    expect(call("startsWith", [litStr("A")])).toBe('this._name.startsWith("A")');
    expect(call("contains", [litStr("x")])).toBe('this._name.includes("x")');
    expect(call("replace", [litStr("a"), litStr("b")])).toBe('this._name.replaceAll("a", "b")');
    expect(call("split", [litStr(",")])).toBe('this._name.split(",")');
  });

  it("renders substring with both arities (0-based clamping slice)", () => {
    const litInt = (v: string) => ({ kind: "literal", lit: "int", value: v }) as const;
    const sub = (args: ReturnType<typeof litInt>[]) =>
      renderTsExpr({
        kind: "method-call",
        receiver: thisProp("name"),
        member: "substring",
        args: [...args],
        receiverType: STRING,
        isCollectionOp: false,
      });
    expect(sub([litInt("1")])).toBe("this._name.slice(1)");
    expect(sub([litInt("1"), litInt("3")])).toBe("this._name.slice(1, (1) + (3))");
  });

  it("renders collection-op `count` as .length", () => {
    expect(
      renderTsExpr({
        kind: "method-call",
        receiver: thisProp("items"),
        member: "count",
        args: [],
        receiverType: { kind: "array", element: STRING },
        isCollectionOp: true,
      }),
    ).toBe("(this._items).length");
  });

  it("renders collection-op `where(λ)` as `.filter(λ)`", () => {
    expect(
      renderTsExpr({
        kind: "method-call",
        receiver: thisProp("items"),
        member: "where",
        args: [{ kind: "lambda", param: "x", body: litBool("true") }],
        receiverType: { kind: "array", element: STRING },
        isCollectionOp: true,
      }),
    ).toBe("(this._items).filter((x) => true)");
  });

  it("renders collection-op `firstOrNull` as `(recv[0] ?? null)`", () => {
    expect(
      renderTsExpr({
        kind: "method-call",
        receiver: thisProp("items"),
        member: "firstOrNull",
        args: [],
        receiverType: { kind: "array", element: STRING },
        isCollectionOp: true,
      }),
    ).toBe("((this._items)[0] ?? null)");
  });
});

describe("ts renderTsExpr — A4 collection transformation ops", () => {
  const arr: TypeIR = { kind: "array", element: STRING };
  // Identity lambda `x => x` — keeps the arg render trivial so the op wrapper
  // is what the assertion pins.
  const idLambda: ExprIR = {
    kind: "lambda",
    param: "x",
    body: { kind: "ref", name: "x", refKind: "lambda" },
  };
  const mc = (member: string, args: ExprIR[]): ExprIR => ({
    kind: "method-call",
    receiver: thisProp("items"),
    member,
    args,
    receiverType: arr,
    isCollectionOp: true,
  });

  it("renders `map(λ)` as `.map(λ)`", () => {
    expect(renderTsExpr(mc("map", [idLambda]))).toBe("(this._items).map((x) => x)");
  });

  it("renders `sortBy(λ)` as an ascending spread-and-sort", () => {
    expect(renderTsExpr(mc("sortBy", [idLambda]))).toBe(
      "[...(this._items)].sort((__a, __b) => { const ka = ((x) => x)(__a), kb = ((x) => x)(__b); return ka < kb ? -1 : ka > kb ? 1 : 0; })",
    );
  });

  it("renders `sortBy(λ, true)` descending (flips the comparator)", () => {
    expect(renderTsExpr(mc("sortBy", [idLambda, litBool("true")]))).toBe(
      "[...(this._items)].sort((__a, __b) => { const ka = ((x) => x)(__a), kb = ((x) => x)(__b); return kb < ka ? -1 : kb > ka ? 1 : 0; })",
    );
  });

  it("renders `distinct` (property-style member) as a Set round-trip", () => {
    expect(
      renderTsExpr({
        kind: "member",
        receiver: thisProp("items"),
        member: "distinct",
        receiverType: arr,
        memberType: arr,
      }),
    ).toBe("[...new Set(this._items)]");
  });

  it("renders `take(n)` as `.slice(0, n)`", () => {
    expect(renderTsExpr(mc("take", [litInt("2")]))).toBe("(this._items).slice(0, 2)");
  });

  it("renders `skip(n)` as `.slice(n)`", () => {
    expect(renderTsExpr(mc("skip", [litInt("1")]))).toBe("(this._items).slice(1)");
  });

  it("renders `join(sep)` as `.join(sep)`", () => {
    expect(renderTsExpr(mc("join", [litStr(", ")]))).toBe('(this._items).join(", ")');
  });
});

describe("ts renderTsExpr — A4 reductions min(λ)/max(λ)", () => {
  const arr: TypeIR = { kind: "array", element: STRING };
  // Identity lambda `x => x` — untyped body, so the comparator-reduce path
  // (native `<`/`>`) is what the assertion pins.
  const idLambda: ExprIR = {
    kind: "lambda",
    param: "x",
    body: { kind: "ref", name: "x", refKind: "lambda" },
  };
  // A money projection `x => x.price` — decimal.js `Decimal`, so the reduce
  // dispatches to the `.lt`/`.gt` method form (bodyTypeOf reads memberType).
  const moneyLambda: ExprIR = {
    kind: "lambda",
    param: "x",
    body: {
      kind: "member",
      receiver: { kind: "ref", name: "x", refKind: "lambda" },
      member: "price",
      receiverType: { kind: "entity", name: "Line" },
      memberType: MONEY,
    },
  };
  const mc = (member: string, args: ExprIR[]): ExprIR => ({
    kind: "method-call",
    receiver: thisProp("items"),
    member,
    args,
    receiverType: arr,
    isCollectionOp: true,
  });

  it("renders `min(λ)` as a length-guarded comparator-reduce (< ) → null on empty", () => {
    expect(renderTsExpr(mc("min", [idLambda]))).toBe(
      "((this._items).length ? (this._items).map((x) => x).reduce((__a, __b) => (__b < __a ? __b : __a)) : null)",
    );
  });

  it("renders `max(λ)` as a length-guarded comparator-reduce (> ) → null on empty", () => {
    expect(renderTsExpr(mc("max", [idLambda]))).toBe(
      "((this._items).length ? (this._items).map((x) => x).reduce((__a, __b) => (__b > __a ? __b : __a)) : null)",
    );
  });

  it("renders a money `min(λ)` via decimal.js `.lt` (native `<` doesn't compare Decimals)", () => {
    expect(renderTsExpr(mc("min", [moneyLambda]))).toBe(
      "((this._items).length ? (this._items).map((x) => x.price).reduce((__a, __b) => (__b.lt(__a) ? __b : __a)) : null)",
    );
  });

  it("renders a money `max(λ)` via decimal.js `.gt`", () => {
    expect(renderTsExpr(mc("max", [moneyLambda]))).toBe(
      "((this._items).length ? (this._items).map((x) => x.price).reduce((__a, __b) => (__b.gt(__a) ? __b : __a)) : null)",
    );
  });

  // sortBy over a money projection: decimal.js `Decimal`'s `<`/`>` coerce via
  // valueOf() → lexicographic order, so the comparator must use `.lt`/`.gt`
  // (same money special-case as min/max).  A non-money projection stays native.
  it("renders a money `sortBy(λ)` via decimal.js `.lt`/`.gt` (native `<` mis-sorts Decimals)", () => {
    expect(renderTsExpr(mc("sortBy", [moneyLambda]))).toBe(
      "[...(this._items)].sort((__a, __b) => { const ka = ((x) => x.price)(__a), kb = ((x) => x.price)(__b); return ka.lt(kb) ? -1 : ka.gt(kb) ? 1 : 0; })",
    );
  });

  it("renders a descending money `sortBy(λ, true)` via `.lt`/`.gt`", () => {
    expect(renderTsExpr(mc("sortBy", [moneyLambda, litBool("true")]))).toBe(
      "[...(this._items)].sort((__a, __b) => { const ka = ((x) => x.price)(__a), kb = ((x) => x.price)(__b); return kb.lt(ka) ? -1 : kb.gt(ka) ? 1 : 0; })",
    );
  });
});

describe("ts renderTsExpr — money `contains` value-equality", () => {
  const moneyArr: TypeIR = { kind: "array", element: MONEY };
  const strArr: TypeIR = { kind: "array", element: STRING };
  const mc = (receiverType: TypeIR, arg: ExprIR): ExprIR => ({
    kind: "method-call",
    receiver: thisProp("prices"),
    member: "contains",
    args: [arg],
    receiverType,
    isCollectionOp: true,
  });

  it("renders `money[].contains(x)` as a `.some(x => x.eq(v))` value-equality scan", () => {
    // `.includes` uses reference identity on decimal.js Decimals → always false.
    expect(renderTsExpr(mc(moneyArr, thisProp("target")))).toBe(
      "(this._prices).some((__x) => __x.eq(this._target))",
    );
  });

  it("keeps a non-money `contains` on `.includes` (byte-identical)", () => {
    expect(renderTsExpr(mc(strArr, litStr("x")))).toBe('(this._prices).includes("x")');
  });
});

describe("ts renderTsExpr — sum type-awareness (money folds decimal.js)", () => {
  const DECIMAL: TypeIR = { kind: "primitive", name: "decimal" };
  // λ-body projections typed via `member.memberType` (bodyTypeOf reads it).
  const proj = (member: string, memberType: TypeIR): ExprIR => ({
    kind: "lambda",
    param: "x",
    body: {
      kind: "member",
      receiver: { kind: "ref", name: "x", refKind: "lambda" },
      member,
      receiverType: { kind: "entity", name: "Line" },
      memberType,
    },
  });
  const sumMc = (elem: TypeIR, args: ExprIR[]): ExprIR => ({
    kind: "method-call",
    receiver: thisProp("items"),
    member: "sum",
    args,
    receiverType: { kind: "array", element: elem },
    isCollectionOp: true,
  });

  // MONEY → decimal.js `Decimal`: fold with `.plus` from a `new Decimal(0)`
  // seed (a native `0 + Decimal` coerces to a string).
  it("folds a money `sum(λ)` via `.plus` from a `new Decimal(0)` seed", () => {
    expect(renderTsExpr(sumMc(MONEY, [proj("price", MONEY)]))).toBe(
      "(this._items).reduce((acc, x) => acc.plus(((x) => x.price)(x)), new Decimal(0))",
    );
  });

  it("folds a no-arg money `sum` (money[] receiver) via `.plus` / `new Decimal(0)`", () => {
    expect(renderTsExpr(sumMc(MONEY, []))).toBe(
      "(this._items).reduce((acc, x) => acc.plus(x), new Decimal(0))",
    );
  });

  // int/long/decimal are plain `number` on this backend → native `+`/`0` seed.
  it("keeps an int `sum(λ)` on the native `+`/`0`-seed reduce", () => {
    expect(renderTsExpr(sumMc(INT, [proj("qty", INT)]))).toBe(
      "(this._items).reduce((acc, x) => acc + ((x) => x.qty)(x), 0)",
    );
  });

  it("keeps a decimal `sum(λ)` on the native `+`/`0`-seed reduce (decimal is `number` here)", () => {
    expect(renderTsExpr(sumMc(DECIMAL, [proj("d", DECIMAL)]))).toBe(
      "(this._items).reduce((acc, x) => acc + ((x) => x.d)(x), 0)",
    );
  });

  // A5 — the canonical order total.  Before `bodyTypeOf` grew its `binary`
  // arm this typed as `undefined` and fell through to the native `+`/`0`
  // reduce, which tsc rejects (`number + Decimal`).
  it("folds an ARITHMETIC money `sum(l => l.price * l.qty)` via `.plus` / `new Decimal(0)`", () => {
    const arith: ExprIR = {
      kind: "lambda",
      param: "l",
      body: {
        kind: "binary",
        op: "*",
        left: {
          kind: "member",
          receiver: { kind: "ref", name: "l", refKind: "lambda" },
          member: "price",
          receiverType: { kind: "entity", name: "Line" },
          memberType: MONEY,
        },
        right: {
          kind: "member",
          receiver: { kind: "ref", name: "l", refKind: "lambda" },
          member: "qty",
          receiverType: { kind: "entity", name: "Line" },
          memberType: INT,
        },
        leftType: MONEY,
        rightType: INT,
        resultType: MONEY,
      },
    };
    expect(renderTsExpr(sumMc({ kind: "entity", name: "Line" }, [arith]))).toBe(
      "(this._items).reduce((acc, x) => acc.plus(((l) => l.price.times(l.qty))(x)), new Decimal(0))",
    );
  });
});

describe("ts renderTsExpr — unary `-` on money (A11)", () => {
  it("renders `-money` via decimal.js `.neg()` (native `-` coerces through valueOf)", () => {
    expect(
      renderTsExpr({ kind: "unary", op: "-", operand: { ...thisProp("total"), type: MONEY } }),
    ).toBe("this._total.neg()");
  });

  it("keeps `-int` on the native operator (int/decimal are plain `number` here)", () => {
    expect(
      renderTsExpr({ kind: "unary", op: "-", operand: { ...thisProp("qty"), type: INT } }),
    ).toBe("-this._qty");
  });

  it("sees through a binary operand — `-(price * qty)` is still money", () => {
    const arith: ExprIR = {
      kind: "binary",
      op: "*",
      left: { ...thisProp("price"), type: MONEY },
      right: { ...thisProp("qty"), type: INT },
      leftType: MONEY,
      rightType: INT,
      resultType: MONEY,
    };
    expect(renderTsExpr({ kind: "unary", op: "-", operand: { kind: "paren", inner: arith } })).toBe(
      "(this._price.times(this._qty)).neg()",
    );
  });

  it("keeps `!bool` on the native operator", () => {
    expect(
      renderTsExpr({ kind: "unary", op: "!", operand: { ...thisProp("ok"), type: BOOL } }),
    ).toBe("!this._ok");
  });
});

describe("ts renderTsExpr — `distinct` value-dedupe on money (A14)", () => {
  const distinctOf = (elem: TypeIR): ExprIR => ({
    kind: "member",
    receiver: thisProp("prices"),
    member: "distinct",
    receiverType: { kind: "array", element: elem },
    memberType: { kind: "array", element: elem },
  });

  it("dedupes a `money[]` by VALUE — `new Set` compares Decimal references", () => {
    expect(renderTsExpr(distinctOf(MONEY))).toBe(
      "this._prices.filter((__x, __i, __a) => __a.findIndex((__y) => __y.eq(__x)) === __i)",
    );
  });

  it("keeps a non-money `distinct` on `[...new Set(…)]` (byte-identical)", () => {
    expect(renderTsExpr(distinctOf(STRING))).toBe("[...new Set(this._prices)]");
  });

  // F2-EXPR-4.  A VALUE-OBJECT element is an object too, so `new Set` /
  // `.includes` compare references and silently answer wrong — a dedupe that
  // returns duplicates and a membership test that is always false.  The
  // validator ADMITS this element type (`loom.distinct-non-scalar`: "requires a
  // scalar or value-object element") and every generated VO carries the
  // field-wise `equals` these arms call, so node was alone in getting it wrong.
  const TAG: TypeIR = { kind: "valueobject", name: "Tag" };
  const containsOf = (elem: TypeIR, arg: ExprIR): ExprIR => ({
    kind: "method-call",
    receiver: thisProp("prices"),
    member: "contains",
    args: [arg],
    receiverType: { kind: "array", element: elem },
    memberType: BOOL,
    isCollectionOp: true,
  });
  const newTag = (label: string): ExprIR => ({
    kind: "call",
    callKind: "value-object-ctor",
    name: "Tag",
    args: [litStr(label)],
  });

  it("dedupes a value-object collection through the VO's own `equals`", () => {
    expect(renderTsExpr(distinctOf(TAG))).toBe(
      "this._prices.filter((__x, __i, __a) => __a.findIndex((__y) => __y.equals(__x)) === __i)",
    );
  });

  it("tests value-object membership through `equals`, not `.includes`", () => {
    expect(renderTsExpr(containsOf(TAG, newTag("x")))).toBe(
      '(this._prices).some((__x) => __x.equals(new Tag("x")))',
    );
    // Money keeps its `.eq` spelling; a scalar element keeps `.includes`.
    expect(renderTsExpr(containsOf(MONEY, litMoney("3")))).toBe(
      '(this._prices).some((__x) => __x.eq(new Decimal("3")))',
    );
    expect(renderTsExpr(containsOf(STRING, litStr("x")))).toBe('(this._prices).includes("x")');
  });

  // The defect was a WRONG ANSWER, not a compile break, so evaluate the two
  // rendered expressions against a stand-in for the generated VO class (which
  // carries exactly this `equals`) and assert what they compute.
  it("computes the right answers at runtime", () => {
    class Tag {
      constructor(public label: string) {}
      equals(other: Tag): boolean {
        return this.label === other.label;
      }
    }
    const self = { _prices: [new Tag("x"), new Tag("x"), new Tag("y")] };
    const evalIn = (expr: string): unknown =>
      new Function("Tag", `return ${expr};`).call(self, Tag);
    expect((evalIn(renderTsExpr(distinctOf(TAG))) as Tag[]).length).toBe(2);
    expect(evalIn(renderTsExpr(containsOf(TAG, newTag("x"))))).toBe(true);
    expect(evalIn(renderTsExpr(containsOf(TAG, newTag("zz"))))).toBe(false);
  });
});

describe("ts renderTsExpr — call kinds", () => {
  it("renders value-object-ctor as `new <Name>(...)`", () => {
    expect(
      renderTsExpr({
        kind: "call",
        callKind: "value-object-ctor",
        name: "Money",
        args: [litInt("3"), litStr("USD")],
      }),
    ).toBe('new Money(3, "USD")');
  });

  it("renders function call as this.<lowerFirst(name)>(args)", () => {
    expect(
      renderTsExpr({
        kind: "call",
        callKind: "function",
        name: "ComputeTotal",
        args: [litInt("3")],
      }),
    ).toBe("this.computeTotal(3)");
  });

  it("renders free function call without receiver", () => {
    expect(renderTsExpr({ kind: "call", callKind: "free", name: "now", args: [] })).toBe("now()");
  });
});

describe("ts renderTsExpr — binary, unary, paren, ternary", () => {
  it("renders int `==` as `===`", () => {
    expect(
      renderTsExpr({
        kind: "binary",
        op: "==",
        left: litInt("1"),
        right: litInt("2"),
        leftType: INT,
      }),
    ).toBe("1 === 2");
  });

  it("renders int `!=` as `!==`", () => {
    expect(
      renderTsExpr({
        kind: "binary",
        op: "!=",
        left: litInt("1"),
        right: litInt("2"),
        leftType: INT,
      }),
    ).toBe("1 !== 2");
  });

  it("renders money `+` as `.plus(...)` method call", () => {
    expect(
      renderTsExpr({
        kind: "binary",
        op: "+",
        left: litMoney("1"),
        right: litMoney("2"),
        leftType: MONEY,
      }),
    ).toBe('new Decimal("1").plus(new Decimal("2"))');
  });

  it("renders money `==` as `.eq(...)` and money `!=` as `!(...)` of eq", () => {
    expect(
      renderTsExpr({
        kind: "binary",
        op: "==",
        left: litMoney("1"),
        right: litMoney("2"),
        leftType: MONEY,
      }),
    ).toBe('new Decimal("1").eq(new Decimal("2"))');
    expect(
      renderTsExpr({
        kind: "binary",
        op: "!=",
        left: litMoney("1"),
        right: litMoney("2"),
        leftType: MONEY,
      }),
    ).toBe('!(new Decimal("1").eq(new Decimal("2")))');
  });

  it("renders unary minus as a prefix operator", () => {
    expect(renderTsExpr({ kind: "unary", op: "-", operand: litInt("3") })).toBe("-3");
  });

  it("renders unary `!` as a prefix operator (not `!!`)", () => {
    expect(renderTsExpr({ kind: "unary", op: "!", operand: thisProp("active") })).toBe(
      "!this._active",
    );
  });

  it("renders paren as `(inner)`", () => {
    expect(renderTsExpr({ kind: "paren", inner: litBool("true") })).toBe("(true)");
  });

  it("renders ternary as JS `cond ? then : else`", () => {
    expect(
      renderTsExpr({
        kind: "ternary",
        cond: litBool("true"),
        // biome-ignore lint/suspicious/noThenProperty: the ternary IR node's branch field is named `then`
        then: litInt("1"),
        otherwise: litInt("2"),
      }),
    ).toBe("true ? 1 : 2");
  });
});

describe("ts renderTsExpr — convert", () => {
  it("string(money) → `<expr>.toString()`", () => {
    expect(
      renderTsExpr({ kind: "convert", target: "string", from: "money", value: thisProp("price") }),
    ).toBe("this._price.toString()");
  });

  it("string(int) → `String(<expr>)`", () => {
    expect(
      renderTsExpr({ kind: "convert", target: "string", from: "int", value: litInt("3") }),
    ).toBe("String(3)");
  });

  it("money(int) → `new Decimal(<expr>)`", () => {
    expect(
      renderTsExpr({ kind: "convert", target: "money", from: "int", value: litInt("5") }),
    ).toBe("new Decimal(5)");
  });

  it("money(money) → no-op (pass-through)", () => {
    expect(
      renderTsExpr({ kind: "convert", target: "money", from: "money", value: thisProp("amount") }),
    ).toBe("this._amount");
  });

  it("decimal(money) → `<expr>.toNumber()` (lossy)", () => {
    expect(
      renderTsExpr({
        kind: "convert",
        target: "decimal",
        from: "money",
        value: thisProp("amount"),
      }),
    ).toBe("this._amount.toNumber()");
  });
});

describe("ts renderTsExpr — match → right-folded ternary", () => {
  it("lowers a single-arm match to `(cond ? value : tail)` with `undefined` tail", () => {
    expect(
      renderTsExpr({
        kind: "match",
        arms: [{ cond: thisProp("active"), value: litStr("yes") }],
      }),
    ).toBe('(this._active ? "yes" : undefined)');
  });

  it("includes the `otherwise` branch as the tail", () => {
    expect(
      renderTsExpr({
        kind: "match",
        arms: [{ cond: thisProp("active"), value: litStr("yes") }],
        otherwise: litStr("no"),
      }),
    ).toBe('(this._active ? "yes" : "no")');
  });

  it("right-folds multiple arms with the later arms nested deeper", () => {
    expect(
      renderTsExpr({
        kind: "match",
        arms: [
          { cond: litBool("true"), value: litStr("first") },
          { cond: litBool("false"), value: litStr("second") },
        ],
        otherwise: litStr("else"),
      }),
    ).toBe('(true ? "first" : (false ? "second" : "else"))');
  });
});

describe("ts renderTsExpr — lambda, new, list, object", () => {
  it("renders single-expression lambda as `(x) => expr`", () => {
    expect(renderTsExpr({ kind: "lambda", param: "item", body: thisProp("active") })).toBe(
      "(item) => this._active",
    );
  });

  it("renders block-body lambda as a TODO arrow (not TS-renderable)", () => {
    expect(renderTsExpr({ kind: "lambda", param: "x", block: [] })).toMatch(
      /\(x\) => \{ \/\* block-body lambda/,
    );
  });

  it("renders entity-part constructor with id + parentId boilerplate", () => {
    expect(
      renderTsExpr({
        kind: "new",
        partName: "LineItem",
        fields: [{ name: "sku", value: litStr("ABC") }],
      }),
    ).toBe('LineItem._create({ id: Ids.newLineItemId(), parentId: this._id, sku: "ABC" })');
  });

  it("renders list literal as TS array", () => {
    expect(renderTsExpr({ kind: "list", elements: [litInt("1"), litInt("2"), litInt("3")] })).toBe(
      "[1, 2, 3]",
    );
  });

  it("renders object literal as parenthesised TS object", () => {
    expect(
      renderTsExpr({
        kind: "object",
        fields: [
          { name: "name", value: litStr("Ada") },
          { name: "age", value: litInt("36") },
        ],
      }),
    ).toBe('({ name: "Ada", age: 36 })');
  });
});

describe("ts renderTsExpr — A1 int-division widening + divTrunc", () => {
  const DECIMAL: TypeIR = { kind: "primitive", name: "decimal" };

  // `int / int` widens to `decimal`.  On TS `decimal` is `number` (already
  // fractional), so the division stays the native `/` — no cast/box.
  it("renders int/int→decimal division as native `/` (number is already fractional)", () => {
    expect(
      renderTsExpr({
        kind: "binary",
        op: "/",
        left: litInt("5"),
        right: litInt("2"),
        leftType: INT,
        rightType: INT,
        resultType: DECIMAL,
      }),
    ).toBe("5 / 2");
  });

  // `a.divTrunc(b)` — truncating integer division toward zero.
  it("renders the `divTrunc` intrinsic as `Math.trunc(recv / arg)`", () => {
    expect(
      renderTsExpr({
        kind: "method-call",
        receiver: thisProp("a"),
        member: "divTrunc",
        args: [litInt("2")],
        receiverType: INT,
        isCollectionOp: false,
      }),
    ).toBe("Math.trunc(this._a / 2)");
  });
});

describe("ts renderTsType — generic carriers (P3b)", () => {
  it("renders `paged` as its monomorphized inline record shape", () => {
    const t: TypeIR = {
      kind: "genericInstance",
      ctor: "paged",
      arg: { kind: "entity", name: "Order" },
    };
    expect(renderTsType(t)).toBe(
      "{ items: Order[]; page: number; pageSize: number; total: number; totalPages: number }",
    );
  });

  it("renders `envelope` as { id; ts; body }", () => {
    const t: TypeIR = { kind: "genericInstance", ctor: "envelope", arg: STRING };
    expect(renderTsType(t)).toBe("{ id: string; ts: Date; body: string }");
  });
});

void BOOL;

// ---------------------------------------------------------------------------
// M-T6.44 (numeric-types audit F7) — the MIRROR money arm.  `moneyArithmetic`
// admits `money × scalar` commutatively, so money arrives on the RIGHT with an
// integral/decimal left; the gate used to read `leftType` alone, and
// `qty * price` fell to native `*` on a decimal.js Decimal — TS2363, an
// uncompilable generated project.  The numeric left is wrapped so the method
// receiver is a Decimal.
// ---------------------------------------------------------------------------
describe("ts renderTsExpr — money on the RIGHT of a binary (M-T6.44 mirror arm)", () => {
  const DECIMAL: TypeIR = { kind: "primitive", name: "decimal" };
  const LONG: TypeIR = { kind: "primitive", name: "long" };
  const mul = (lt: TypeIR, l: ExprIR): ExprIR => ({
    kind: "binary",
    op: "*",
    left: l,
    right: { ...thisProp("price"), type: MONEY },
    leftType: lt,
    rightType: MONEY,
    resultType: MONEY,
  });

  it("int * money dispatches through the Decimal method API with a wrapped left", () => {
    expect(renderTsExpr(mul(INT, { ...thisProp("qty"), type: INT }))).toBe(
      "new Decimal(this._qty).times(this._price)",
    );
  });

  it("long * money takes the same arm", () => {
    expect(renderTsExpr(mul(LONG, { ...thisProp("qty"), type: LONG }))).toBe(
      "new Decimal(this._qty).times(this._price)",
    );
  });

  it("decimal * money takes the same arm (plain decimal is a native number here)", () => {
    expect(renderTsExpr(mul(DECIMAL, { ...thisProp("rate"), type: DECIMAL }))).toBe(
      "new Decimal(this._rate).times(this._price)",
    );
  });

  it("string + string is untouched by the mirror arm (concat stays native)", () => {
    expect(
      renderTsExpr({
        kind: "binary",
        op: "+",
        left: { ...thisProp("first"), type: STRING },
        right: { ...thisProp("last"), type: STRING },
        leftType: STRING,
        rightType: STRING,
        resultType: STRING,
      }),
    ).toBe("this._first + this._last");
  });
});
