// Direct unit tests for the Java backend's `renderJavaExpr` — one pin per
// ExprIR kind plus the Java-specific leaf divergences worth locking against
// regressions.  Completes the cross-backend arm-level coverage square with
// the TS / C# / Elixir kind suites.
//
// The notable Java divergences pinned here: BigDecimal method arithmetic
// (`+`→`.add`, comparisons → `.compareTo(…)`), `Objects.equals` for
// reference-type equality, `Instant` ordering via isBefore/isAfter,
// find-anywhere regex via `Pattern…find()`, Streams for collection ops,
// and record-style accessor members (`recv.member()`).

import { describe, expect, it } from "vitest";
import {
  boxedJavaType,
  renderJavaExpr,
  renderJavaType,
} from "../../../src/generator/java/render-expr.js";
import { renderJavaStatements } from "../../../src/generator/java/render-stmt.js";
import type { ExprIR, StmtIR, TypeIR } from "../../../src/ir/types/loom-ir.js";

const STRING: TypeIR = { kind: "primitive", name: "string" };
const INT: TypeIR = { kind: "primitive", name: "int" };
const MONEY: TypeIR = { kind: "primitive", name: "money" };
const DATETIME: TypeIR = { kind: "primitive", name: "datetime" };

const litInt = (v: string): ExprIR => ({ kind: "literal", lit: "int", value: v });
const litLong = (v: string): ExprIR => ({ kind: "literal", lit: "long", value: v });
const litStr = (v: string): ExprIR => ({ kind: "literal", lit: "string", value: v });
const litDecimal = (v: string): ExprIR => ({ kind: "literal", lit: "decimal", value: v });
const litMoney = (v: string): ExprIR => ({ kind: "literal", lit: "money", value: v });
const litBool = (v: "true" | "false"): ExprIR => ({ kind: "literal", lit: "bool", value: v });
const litNull = (): ExprIR => ({ kind: "literal", lit: "null", value: "" });
const refParam = (name: string): ExprIR => ({ kind: "ref", name, refKind: "param" });
const thisProp = (name: string): ExprIR => ({ kind: "ref", name, refKind: "this-prop" });

describe("java renderJavaExpr — literals", () => {
  it("renders string literals JSON-quoted", () => {
    expect(renderJavaExpr(litStr("hello"))).toBe('"hello"');
  });

  it("renders int literals verbatim and long literals with the `L` suffix", () => {
    expect(renderJavaExpr(litInt("42"))).toBe("42");
    expect(renderJavaExpr(litLong("9999999999"))).toBe("9999999999L");
  });

  it("renders decimal / money literals as string-sourced BigDecimal (precision-exact)", () => {
    expect(renderJavaExpr(litDecimal("9.99"))).toBe('new BigDecimal("9.99")');
    expect(renderJavaExpr(litMoney("10.50"))).toBe('new BigDecimal("10.50")');
  });

  it("renders `now` as Instant.now() and `null` bare", () => {
    expect(renderJavaExpr({ kind: "literal", lit: "now", value: "" })).toBe("Instant.now()");
    expect(renderJavaExpr(litNull())).toBe("null");
  });
});

describe("java renderJavaExpr — this / id / refs", () => {
  it("renders `this` as ctx.thisName and `id` as a direct field read", () => {
    expect(renderJavaExpr({ kind: "this" })).toBe("this");
    expect(renderJavaExpr({ kind: "id" })).toBe("this.id");
    expect(renderJavaExpr({ kind: "id" }, { thisName: "x" })).toBe("x.id");
  });

  it("renders param / let / lambda refs by bare name (DSL casing IS Java casing)", () => {
    expect(renderJavaExpr(refParam("orderNumber"))).toBe("orderNumber");
    expect(renderJavaExpr({ kind: "ref", name: "x", refKind: "let" })).toBe("x");
  });

  it("renders this-prop as a direct field read, this-derived as a method call", () => {
    expect(renderJavaExpr(thisProp("customerName"))).toBe("this.customerName");
    expect(renderJavaExpr({ kind: "ref", name: "total", refKind: "this-derived" })).toBe(
      "this.total()",
    );
  });

  it("renders helper-fn refs as method references", () => {
    expect(renderJavaExpr({ kind: "ref", name: "itemTotal", refKind: "helper-fn" })).toBe(
      "this::itemTotal",
    );
  });

  it("renders enum-value and currentUser refs verbatim", () => {
    expect(
      renderJavaExpr({ kind: "ref", name: "active", refKind: "enum-value", enumName: "Status" }),
    ).toBe("Status.active");
    expect(renderJavaExpr({ kind: "ref", name: "currentUser", refKind: "current-user" })).toBe(
      "currentUser",
    );
  });
});

describe("java renderJavaExpr — member + method-call", () => {
  it("renders member access through record-style accessors", () => {
    expect(
      renderJavaExpr({
        kind: "member",
        receiver: thisProp("address"),
        member: "city",
        receiverType: { kind: "valueobject", name: "Address" },
        memberType: STRING,
      }),
    ).toBe("this.address.city()");
  });

  it("maps array `.count`/`.length` to `.size()` and string `.length` to `.length()`", () => {
    for (const member of ["count", "length"]) {
      expect(
        renderJavaExpr({
          kind: "member",
          receiver: thisProp("items"),
          member,
          receiverType: { kind: "array", element: STRING },
          memberType: INT,
        }),
      ).toBe("this.items.size()");
    }
    expect(
      renderJavaExpr({
        kind: "member",
        receiver: thisProp("name"),
        member: "length",
        receiverType: STRING,
        memberType: INT,
      }),
    ).toBe("this.name.length()");
  });

  it("renders `string.matches` as find-anywhere Pattern…find() (NOT String.matches)", () => {
    expect(
      renderJavaExpr({
        kind: "method-call",
        receiver: thisProp("email"),
        member: "matches",
        args: [litStr("^[^@]+@.+$")],
        receiverType: STRING,
        isCollectionOp: false,
      }),
    ).toBe('Pattern.compile("^[^@]+@.+$").matcher(this.email).find()');
  });

  it("renders the `string.trim()` intrinsic via the catalogue snippet", () => {
    expect(
      renderJavaExpr({
        kind: "method-call",
        receiver: thisProp("name"),
        member: "trim",
        args: [],
        receiverType: STRING,
        isCollectionOp: false,
      }),
    ).toBe("this.name.trim()");
  });

  it("renders the A2 string-batch intrinsics via the catalogue snippets", () => {
    const call = (member: string, args: ExprIR[] = []): ExprIR => ({
      kind: "method-call",
      receiver: thisProp("name"),
      member,
      args,
      receiverType: STRING,
      isCollectionOp: false,
    });
    expect(renderJavaExpr(call("toUpper"))).toBe("this.name.toUpperCase(java.util.Locale.ROOT)");
    expect(renderJavaExpr(call("toLower"))).toBe("this.name.toLowerCase(java.util.Locale.ROOT)");
    // string-receiver contains is the INTRINSIC (isCollectionOp=false), not
    // the array-membership arm — both spell `.contains` in Java.
    expect(renderJavaExpr(call("contains", [litStr("x")]))).toBe('this.name.contains("x")');
    expect(renderJavaExpr(call("startsWith", [litStr("a")]))).toBe('this.name.startsWith("a")');
    expect(renderJavaExpr(call("endsWith", [litStr("z")]))).toBe('this.name.endsWith("z")');
    // Literal-find replace-all → String.replace (NOT the regex replaceAll).
    expect(renderJavaExpr(call("replace", [litStr("a"), litStr("b")]))).toBe(
      'this.name.replace("a", "b")',
    );
    // Literal separator, trailing empties kept, wrapped to List (Loom
    // string[] is List<String> on Java).
    expect(renderJavaExpr(call("split", [litStr(",")]))).toBe(
      'java.util.Arrays.asList(this.name.split(java.util.regex.Pattern.quote(","), -1))',
    );
  });

  it("renders substring with 0-based clamping semantics (both arities)", () => {
    const sub = (args: ExprIR[]): ExprIR => ({
      kind: "method-call",
      receiver: thisProp("name"),
      member: "substring",
      args,
      receiverType: STRING,
      isCollectionOp: false,
    });
    expect(renderJavaExpr(sub([litInt("2")]))).toBe(
      '(2 >= this.name.length() ? "" : this.name.substring(2))',
    );
    expect(renderJavaExpr(sub([litInt("2"), litInt("3")]))).toBe(
      '(2 >= this.name.length() ? "" : this.name.substring(2, Math.min((2) + (3), this.name.length())))',
    );
  });

  it("renders collection ops via Streams", () => {
    const items = (member: string, args: ExprIR[] = []): ExprIR => ({
      kind: "method-call",
      receiver: thisProp("items"),
      member,
      args,
      receiverType: { kind: "array", element: STRING },
      isCollectionOp: true,
    });
    expect(renderJavaExpr(items("count"))).toBe("this.items.size()");
    expect(
      renderJavaExpr(items("all", [{ kind: "lambda", param: "x", body: litBool("true") }])),
    ).toBe("this.items.stream().allMatch(x -> true)");
    expect(renderJavaExpr(items("any"))).toBe("!this.items.isEmpty()");
    expect(
      renderJavaExpr(items("where", [{ kind: "lambda", param: "x", body: litBool("true") }])),
    ).toBe("this.items.stream().filter(x -> true).toList()");
    expect(renderJavaExpr(items("first"))).toBe("this.items.get(0)");
    expect(renderJavaExpr(items("firstOrNull"))).toBe(
      "this.items.stream().findFirst().orElse(null)",
    );
    expect(renderJavaExpr(items("contains", [litStr("a")]))).toBe('this.items.contains("a")');
  });

  it("renders money sum as a BigDecimal reduce (type from the lambda body)", () => {
    const sum: ExprIR = {
      kind: "method-call",
      receiver: thisProp("items"),
      member: "sum",
      args: [
        {
          kind: "lambda",
          param: "i",
          body: {
            kind: "member",
            receiver: { kind: "ref", name: "i", refKind: "lambda" },
            member: "price",
            receiverType: { kind: "entity", name: "LineItem" },
            memberType: MONEY,
          },
        },
      ],
      receiverType: { kind: "array", element: { kind: "entity", name: "LineItem" } },
      isCollectionOp: true,
    };
    expect(renderJavaExpr(sum)).toBe(
      "this.items.stream().map(i -> i.price()).reduce(BigDecimal.ZERO, BigDecimal::add)",
    );
  });

  it("renders int sum via mapToInt", () => {
    const sum: ExprIR = {
      kind: "method-call",
      receiver: thisProp("scores"),
      member: "sum",
      args: [],
      receiverType: { kind: "array", element: INT },
      isCollectionOp: true,
    };
    expect(renderJavaExpr(sum)).toBe("this.scores.stream().mapToInt(Integer::intValue).sum()");
  });

  it("renders the A4 collection transformation ops via Streams", () => {
    const arr: TypeIR = { kind: "array", element: STRING };
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
    expect(renderJavaExpr(mc("map", [idLambda]))).toBe("this.items.stream().map(x -> x).toList()");
    expect(renderJavaExpr(mc("sortBy", [idLambda]))).toBe(
      "this.items.stream().sorted(java.util.Comparator.comparing(x -> x)).toList()",
    );
    expect(renderJavaExpr(mc("sortBy", [idLambda, litBool("true")]))).toBe(
      "this.items.stream().sorted(java.util.Comparator.comparing(x -> x).reversed()).toList()",
    );
    // `distinct` is property-style — a member node, not a method-call.
    expect(
      renderJavaExpr({
        kind: "member",
        receiver: thisProp("items"),
        member: "distinct",
        receiverType: arr,
        memberType: arr,
      }),
    ).toBe("this.items.stream().distinct().toList()");
    expect(renderJavaExpr(mc("take", [litInt("2")]))).toBe("this.items.stream().limit(2).toList()");
    expect(renderJavaExpr(mc("skip", [litInt("1")]))).toBe("this.items.stream().skip(1).toList()");
    expect(renderJavaExpr(mc("join", [litStr(", ")]))).toBe('String.join(", ", this.items)');
  });

  it("renders the A4 reductions min(λ)/max(λ) via Stream + naturalOrder, empty → null", () => {
    const arr: TypeIR = { kind: "array", element: STRING };
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
    expect(renderJavaExpr(mc("min", [idLambda]))).toBe(
      "this.items.stream().map(x -> x).min(java.util.Comparator.naturalOrder()).orElse(null)",
    );
    expect(renderJavaExpr(mc("max", [idLambda]))).toBe(
      "this.items.stream().map(x -> x).max(java.util.Comparator.naturalOrder()).orElse(null)",
    );
  });
});

describe("java renderJavaExpr — call kinds", () => {
  it("renders value-object-ctor as `new <Name>(...)`", () => {
    expect(
      renderJavaExpr({
        kind: "call",
        callKind: "value-object-ctor",
        name: "Money",
        args: [litInt("3"), litStr("USD")],
      }),
    ).toBe('new Money(3, "USD")');
  });

  it("renders function / private-operation calls in DSL casing", () => {
    expect(
      renderJavaExpr({
        kind: "call",
        callKind: "function",
        name: "computeTotal",
        args: [litInt("3")],
      }),
    ).toBe("this.computeTotal(3)");
  });

  it("renders free calls without receiver", () => {
    expect(renderJavaExpr({ kind: "call", callKind: "free", name: "now", args: [] })).toBe("now()");
  });
});

describe("java renderJavaExpr — binary leaf divergences", () => {
  const bin = (op: string, left: ExprIR, right: ExprIR, leftType?: TypeIR): ExprIR =>
    ({ kind: "binary", op, left, right, leftType }) as ExprIR;

  it("int comparison keeps native operators", () => {
    expect(renderJavaExpr(bin("==", litInt("1"), litInt("2"), INT))).toBe("1 == 2");
    expect(renderJavaExpr(bin("<", litInt("1"), litInt("2"), INT))).toBe("1 < 2");
  });

  it("string equality routes through Objects.equals", () => {
    expect(renderJavaExpr(bin("==", thisProp("code"), litStr("A"), STRING))).toBe(
      'Objects.equals(this.code, "A")',
    );
    expect(renderJavaExpr(bin("!=", thisProp("code"), litStr("A"), STRING))).toBe(
      '!Objects.equals(this.code, "A")',
    );
  });

  it("string concatenation keeps native `+`", () => {
    expect(renderJavaExpr(bin("+", thisProp("first"), thisProp("last"), STRING))).toBe(
      "this.first + this.last",
    );
  });

  it("null comparisons keep native ==/!= (reference check)", () => {
    expect(renderJavaExpr(bin("==", thisProp("note"), litNull(), STRING))).toBe(
      "this.note == null",
    );
    expect(renderJavaExpr(bin("!=", thisProp("note"), litNull(), STRING))).toBe(
      "this.note != null",
    );
  });

  it("money arithmetic dispatches through BigDecimal methods", () => {
    expect(renderJavaExpr(bin("+", thisProp("a"), thisProp("b"), MONEY))).toBe(
      "this.a.add(this.b)",
    );
    expect(renderJavaExpr(bin("-", thisProp("a"), thisProp("b"), MONEY))).toBe(
      "this.a.subtract(this.b)",
    );
    expect(renderJavaExpr(bin("*", thisProp("a"), thisProp("b"), MONEY))).toBe(
      "this.a.multiply(this.b)",
    );
    expect(renderJavaExpr(bin("/", thisProp("a"), thisProp("b"), MONEY))).toBe(
      "this.a.divide(this.b, MathContext.DECIMAL128)",
    );
  });

  it("money comparison routes through compareTo (BigDecimal.equals is scale-sensitive)", () => {
    expect(renderJavaExpr(bin("==", thisProp("a"), thisProp("b"), MONEY))).toBe(
      "this.a.compareTo(this.b) == 0",
    );
    expect(renderJavaExpr(bin(">=", thisProp("a"), thisProp("b"), MONEY))).toBe(
      "this.a.compareTo(this.b) >= 0",
    );
  });

  it("datetime ordering renders isBefore / isAfter (negated for <= / >=)", () => {
    expect(renderJavaExpr(bin("<", thisProp("a"), thisProp("b"), DATETIME))).toBe(
      "this.a.isBefore(this.b)",
    );
    expect(renderJavaExpr(bin(">", thisProp("a"), thisProp("b"), DATETIME))).toBe(
      "this.a.isAfter(this.b)",
    );
    expect(renderJavaExpr(bin("<=", thisProp("a"), thisProp("b"), DATETIME))).toBe(
      "!this.a.isAfter(this.b)",
    );
    expect(renderJavaExpr(bin(">=", thisProp("a"), thisProp("b"), DATETIME))).toBe(
      "!this.a.isBefore(this.b)",
    );
  });
});

describe("java renderJavaExpr — convert / match / list / lambda / object", () => {
  it("converts per Java idiom", () => {
    expect(
      renderJavaExpr({ kind: "convert", target: "string", from: "int", value: litInt("3") }),
    ).toBe("String.valueOf(3)");
    expect(
      renderJavaExpr({ kind: "convert", target: "string", from: "money", value: thisProp("p") }),
    ).toBe("this.p.toPlainString()");
    expect(
      renderJavaExpr({ kind: "convert", target: "money", from: "int", value: litInt("5") }),
    ).toBe("BigDecimal.valueOf(5)");
    expect(
      renderJavaExpr({ kind: "convert", target: "decimal", from: "money", value: thisProp("p") }),
    ).toBe("this.p");
    expect(
      renderJavaExpr({ kind: "convert", target: "long", from: "int", value: litInt("7") }),
    ).toBe("(long) 7");
  });

  it("lowers match to a right-folded ternary chain", () => {
    expect(
      renderJavaExpr({
        kind: "match",
        arms: [
          { cond: litBool("true"), value: litStr("first") },
          { cond: litBool("false"), value: litStr("second") },
        ],
        otherwise: litStr("else"),
      }),
    ).toBe('(true ? "first" : (false ? "second" : "else"))');
  });

  it("renders list literals as List.of and ternary / paren / unary natively", () => {
    expect(renderJavaExpr({ kind: "list", elements: [litInt("1"), litInt("2")] })).toBe(
      "List.of(1, 2)",
    );
    expect(
      renderJavaExpr({
        kind: "ternary",
        cond: litBool("true"),
        // biome-ignore lint/suspicious/noThenProperty: the ternary IR node's branch field is named `then`
        then: litInt("1"),
        otherwise: litInt("2"),
      }),
    ).toBe("true ? 1 : 2");
    expect(renderJavaExpr({ kind: "paren", inner: litBool("true") })).toBe("(true)");
    expect(renderJavaExpr({ kind: "unary", op: "!", operand: thisProp("active") })).toBe(
      "!this.active",
    );
  });

  it("renders single-expression lambdas with the Java arrow", () => {
    expect(renderJavaExpr({ kind: "lambda", param: "item", body: thisProp("active") })).toBe(
      "item -> this.active",
    );
  });

  it("orders part-constructor args by the part's declared fields", () => {
    const agg = {
      name: "Order",
      parts: [
        {
          name: "LineItem",
          fields: [{ name: "sku" }, { name: "qty" }],
        },
      ],
    } as never;
    expect(
      renderJavaExpr(
        {
          kind: "new",
          partName: "LineItem",
          fields: [
            { name: "qty", value: litInt("2") },
            { name: "sku", value: litStr("ABC") },
          ],
        },
        { thisName: "this", agg },
      ),
    ).toBe('LineItem._create(this.id, "ABC", 2)');
  });
});

describe("java renderJavaExpr — A1 int-division widening + divTrunc", () => {
  const DECIMAL: TypeIR = { kind: "primitive", name: "decimal" };

  // `int / int` widens to `decimal`.  int/long are primitives whose `/` is
  // truncating integer division, so both operands are boxed into BigDecimal
  // and divided with the money-precision context.
  it("renders int/int→decimal division via BigDecimal.valueOf(...).divide(...)", () => {
    expect(
      renderJavaExpr({
        kind: "binary",
        op: "/",
        left: litInt("5"),
        right: litInt("2"),
        leftType: INT,
        rightType: INT,
        resultType: DECIMAL,
      }),
    ).toBe(
      "java.math.BigDecimal.valueOf(5).divide(java.math.BigDecimal.valueOf(2), java.math.MathContext.DECIMAL128)",
    );
  });

  // `a.divTrunc(b)` — Java int `/` already truncates toward zero.
  it("renders the `divTrunc` intrinsic as native `recv / arg` (int `/` truncates)", () => {
    expect(
      renderJavaExpr({
        kind: "method-call",
        receiver: thisProp("a"),
        member: "divTrunc",
        args: [litInt("2")],
        receiverType: INT,
        isCollectionOp: false,
      }),
    ).toBe("this.a / 2");
  });
});

describe("java renderJavaType", () => {
  it("maps primitives to Java types", () => {
    expect(renderJavaType(INT)).toBe("int");
    expect(renderJavaType(MONEY)).toBe("BigDecimal");
    expect(renderJavaType(STRING)).toBe("String");
    expect(renderJavaType(DATETIME)).toBe("Instant");
    expect(renderJavaType({ kind: "primitive", name: "guid" })).toBe("UUID");
  });

  it("boxes primitives in generic / optional positions", () => {
    expect(renderJavaType({ kind: "array", element: INT })).toBe("List<Integer>");
    expect(renderJavaType({ kind: "optional", inner: INT })).toBe("Integer");
    expect(boxedJavaType({ kind: "primitive", name: "bool" })).toBe("Boolean");
  });

  it("renders ids, carriers, and entities", () => {
    expect(renderJavaType({ kind: "id", targetName: "Order" })).toBe("OrderId");
    expect(
      renderJavaType({
        kind: "genericInstance",
        ctor: "paged",
        arg: { kind: "entity", name: "Order" },
      }),
    ).toBe("Paged<Order>");
  });
});

describe("java renderJavaStatements", () => {
  it("renders precondition / requires / let / assign / expression", () => {
    const stmts: StmtIR[] = [
      { kind: "precondition", expr: litBool("true"), source: "must hold" },
      { kind: "requires", expr: litBool("true"), source: "role check" },
      { kind: "let", name: "x", expr: litInt("1"), type: INT },
      { kind: "assign", target: { segments: ["code"] }, value: litStr("A"), targetType: STRING },
      { kind: "expression", expr: litInt("9") },
    ];
    expect(renderJavaStatements(stmts)).toBe(
      [
        `        if (!(true)) throw new DomainException("Precondition failed: must hold");`,
        `        if (!(true)) throw new ForbiddenException("Forbidden: role check");`,
        `        var x = 1;`,
        `        this.code = "A";`,
        `        9;`,
      ].join("\n"),
    );
  });

  it("renders add / remove against the field directly", () => {
    const stmts: StmtIR[] = [
      { kind: "add", target: { segments: ["tags"] }, value: litStr("a"), elementType: STRING },
      { kind: "remove", target: { segments: ["tags"] }, value: litStr("a"), elementType: STRING },
    ];
    expect(renderJavaStatements(stmts)).toBe(
      [`        this.tags.add("a");`, `        this.tags.remove("a");`].join("\n"),
    );
  });

  it("orders emit args by the event's declared field order", () => {
    const stmts: StmtIR[] = [
      {
        kind: "emit",
        eventName: "OrderPlaced",
        fields: [
          { name: "total", value: litInt("9") },
          { name: "orderId", value: thisProp("id") },
        ],
      },
    ];
    expect(
      renderJavaStatements(stmts, {
        thisName: "this",
        eventFields: new Map([["OrderPlaced", ["orderId", "total"]]]),
      }),
    ).toBe(`        this._domainEvents.add(new OrderPlaced(this.id, 9));`);
  });

  it("folds emitted events immediately on event-sourced aggregates", () => {
    const stmts: StmtIR[] = [{ kind: "emit", eventName: "Opened", fields: [] }];
    expect(
      renderJavaStatements(stmts, undefined, {
        emitTrace: false,
        aggregate: "Account",
        op: "open",
        eventSourced: true,
      }),
    ).toBe(`        { var __ev = new Opened(); this._domainEvents.add(__ev); this._apply(__ev); }`);
  });
});

describe("java renderJavaExpr — variant-match switch", () => {
  // `match outcome { Project p => …, ProjectNotFound => "not found" }` lowers to
  // a Java 21 sealed-union switch expression.  A bound arm keeps its binder; an
  // UNBOUND arm must still name a throwaway pattern variable — a bare `_`
  // (unnamed variable) is a Java 21 *preview* feature and fails plain
  // `javac`/`gradle bootJar` ("unnamed variables are a preview feature").
  const variantMatch: ExprIR = {
    kind: "match",
    arms: [],
    subject: { kind: "ref", name: "outcome", refKind: "let" },
    subjectType: {
      kind: "union",
      variants: [
        { kind: "entity", name: "Project" },
        { kind: "entity", name: "ProjectNotFound" },
      ],
    },
    variantArms: [
      {
        varType: { kind: "entity", name: "Project" },
        binding: "p",
        value: { kind: "ref", name: "p", refKind: "match-binding" },
      },
      {
        varType: { kind: "entity", name: "ProjectNotFound" },
        value: litStr("not found"),
      },
    ],
    otherwise: litNull(),
  };

  it("binds a NAMED throwaway (not a bare `_`) for an unbound arm", () => {
    const out = renderJavaExpr(variantMatch);
    // The unbound `ProjectNotFound` arm must bind a real identifier, never `_`.
    expect(out).toContain('case ProjectOrProjectNotFound_ProjectNotFound __unused -> "not found";');
    // No bare unnamed pattern variable anywhere (` _ ->` is the preview form).
    expect(out).not.toMatch(/case\s+\S+\s+_\s*->/);
    // The bound arm keeps its declared binder.
    expect(out).toContain("case ProjectOrProjectNotFound_Project p -> p;");
  });
});
