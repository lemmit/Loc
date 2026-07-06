// Direct unit tests for the .NET backend's `renderCsExpr` — one pin per
// ExprIR kind plus the C#-specific leaf divergences worth locking against
// regressions.  Completes the cross-backend arm-level coverage triangle:
// `test/generator/typescript/render-expr-kinds.test.ts` and
// `test/generator/elixir/phoenix-render-expr.test.ts` already pin TS and
// Elixir; this is the missing C# leg.
//
// All three backends now dispatch through the shared `ExprTarget`
// (`src/generator/_expr/target.ts`); these per-leaf pins guard the C# target
// table.  The notable C# divergences from TS — money via native `decimal`
// operators, `decimal(money)` as a no-op, uppercased free calls — are
// asserted explicitly.  Pure string emission, no IO; runs in <50ms.

import { describe, expect, it } from "vitest";
import { renderCsExpr, renderCsType } from "../../../src/generator/dotnet/render-expr.js";
import type { ExprIR, TypeIR } from "../../../src/ir/types/loom-ir.js";

const STRING: TypeIR = { kind: "primitive", name: "string" };
const INT: TypeIR = { kind: "primitive", name: "int" };
const MONEY: TypeIR = { kind: "primitive", name: "money" };

const litInt = (v: string): ExprIR => ({ kind: "literal", lit: "int", value: v });
const litLong = (v: string): ExprIR => ({ kind: "literal", lit: "long", value: v });
const litStr = (v: string): ExprIR => ({ kind: "literal", lit: "string", value: v });
const litDecimal = (v: string): ExprIR => ({ kind: "literal", lit: "decimal", value: v });
const litMoney = (v: string): ExprIR => ({ kind: "literal", lit: "money", value: v });
const litBool = (v: "true" | "false"): ExprIR => ({ kind: "literal", lit: "bool", value: v });
const refParam = (name: string): ExprIR => ({ kind: "ref", name, refKind: "param" });
const thisProp = (name: string): ExprIR => ({ kind: "ref", name, refKind: "this-prop" });

describe("dotnet renderCsExpr — literals", () => {
  it("renders string literals JSON-quoted", () => {
    expect(renderCsExpr(litStr("hello"))).toBe('"hello"');
  });

  it("renders int literals verbatim", () => {
    expect(renderCsExpr(litInt("42"))).toBe("42");
  });

  it("renders long literals with the `L` suffix", () => {
    expect(renderCsExpr(litLong("9999999999"))).toBe("9999999999L");
  });

  it("renders decimal and money literals with the `m` suffix", () => {
    expect(renderCsExpr(litDecimal("9.99"))).toBe("9.99m");
    expect(renderCsExpr(litMoney("9.99"))).toBe("9.99m");
  });

  it("renders `now` as `DateTime.UtcNow`", () => {
    expect(renderCsExpr({ kind: "literal", lit: "now", value: "" })).toBe("DateTime.UtcNow");
  });

  it("renders `null` as the bare null keyword", () => {
    expect(renderCsExpr({ kind: "literal", lit: "null", value: "" })).toBe("null");
  });

  it("renders bool literals verbatim", () => {
    expect(renderCsExpr(litBool("true"))).toBe("true");
    expect(renderCsExpr(litBool("false"))).toBe("false");
  });
});

describe("dotnet renderCsExpr — `this` / `id` receiver shapes", () => {
  it("renders `this` as ctx.thisName", () => {
    expect(renderCsExpr({ kind: "this" })).toBe("this");
    expect(renderCsExpr({ kind: "this" }, { thisName: "x" })).toBe("x");
  });

  it("renders `id` as `<recv>.Id`", () => {
    expect(renderCsExpr({ kind: "id" })).toBe("this.Id");
    expect(renderCsExpr({ kind: "id" }, { thisName: "x" })).toBe("x.Id");
  });
});

describe("dotnet renderCsExpr — refs", () => {
  it("renders param / let / lambda refs by bare name", () => {
    expect(renderCsExpr(refParam("orderNumber"))).toBe("orderNumber");
    expect(renderCsExpr({ kind: "ref", name: "x", refKind: "let" })).toBe("x");
    expect(renderCsExpr({ kind: "ref", name: "i", refKind: "lambda" })).toBe("i");
  });

  it("renders this-prop refs as `<recv>.<UpperName>`", () => {
    expect(renderCsExpr(thisProp("customerName"))).toBe("this.CustomerName");
    expect(renderCsExpr(thisProp("customerName"), { thisName: "x" })).toBe("x.CustomerName");
  });

  it("renders enum-value refs as <enumName>.<name>", () => {
    expect(
      renderCsExpr({ kind: "ref", name: "Active", refKind: "enum-value", enumName: "Status" }),
    ).toBe("Status.Active");
  });

  it("renders `currentUser` ref verbatim", () => {
    expect(renderCsExpr({ kind: "ref", name: "currentUser", refKind: "current-user" })).toBe(
      "currentUser",
    );
  });

  it("renders helper-fn refs with upperFirst on the name", () => {
    expect(renderCsExpr({ kind: "ref", name: "formatName", refKind: "helper-fn" })).toBe(
      "this.FormatName",
    );
  });
});

describe("dotnet renderCsExpr — member + method-call", () => {
  it("renders member access as `<recv>.<UpperMember>`", () => {
    expect(
      renderCsExpr({
        kind: "member",
        receiver: thisProp("address"),
        member: "city",
        receiverType: { kind: "valueobject", name: "Address" },
        memberType: STRING,
      }),
    ).toBe("this.Address.City");
  });

  it("maps array `.count`/`.length` to `.Count`", () => {
    for (const member of ["count", "length"]) {
      expect(
        renderCsExpr({
          kind: "member",
          receiver: thisProp("items"),
          member,
          receiverType: { kind: "array", element: STRING },
          memberType: INT,
        }),
      ).toBe("this.Items.Count");
    }
  });

  it("maps string `.length` to `.Length`", () => {
    expect(
      renderCsExpr({
        kind: "member",
        receiver: thisProp("name"),
        member: "length",
        receiverType: STRING,
        memberType: INT,
      }),
    ).toBe("this.Name.Length");
  });

  it("renders `string.matches(literal)` as `Regex.IsMatch(recv, pattern)`", () => {
    expect(
      renderCsExpr({
        kind: "method-call",
        receiver: thisProp("email"),
        member: "matches",
        args: [litStr("^[^@]+@.+$")],
        receiverType: STRING,
        isCollectionOp: false,
      }),
    ).toBe('Regex.IsMatch(this.Email, "^[^@]+@.+$")');
  });

  it("renders the `string.trim()` intrinsic as `.Trim()`", () => {
    expect(
      renderCsExpr({
        kind: "method-call",
        receiver: thisProp("name"),
        member: "trim",
        args: [],
        receiverType: STRING,
        isCollectionOp: false,
      }),
    ).toBe("this.Name.Trim()");
  });

  it("renders the `string.toUpper()` intrinsic as `.ToUpperInvariant()`", () => {
    expect(
      renderCsExpr({
        kind: "method-call",
        receiver: thisProp("name"),
        member: "toUpper",
        args: [],
        receiverType: STRING,
        isCollectionOp: false,
      }),
    ).toBe("this.Name.ToUpperInvariant()");
  });

  it("renders 2-arg `string.substring(start, len)` with clamping (JS-slice semantics)", () => {
    expect(
      renderCsExpr({
        kind: "method-call",
        receiver: thisProp("name"),
        member: "substring",
        args: [litInt("0"), litInt("3")],
        receiverType: STRING,
        isCollectionOp: false,
      }),
    ).toBe(
      '(0 >= this.Name.Length ? "" : this.Name.Substring(0, Math.Min(3, this.Name.Length - 0)))',
    );
  });

  it("renders 1-arg `string.substring(start)` with the out-of-range guard", () => {
    expect(
      renderCsExpr({
        kind: "method-call",
        receiver: thisProp("name"),
        member: "substring",
        args: [litInt("2")],
        receiverType: STRING,
        isCollectionOp: false,
      }),
    ).toBe('(2 >= this.Name.Length ? "" : this.Name.Substring(2))');
  });

  it("renders the `string.contains(s)` INTRINSIC ordinally (not the collection op)", () => {
    expect(
      renderCsExpr({
        kind: "method-call",
        receiver: thisProp("name"),
        member: "contains",
        args: [litStr("x")],
        receiverType: STRING,
        isCollectionOp: false,
      }),
    ).toBe('this.Name.Contains("x", StringComparison.Ordinal)');
  });

  it("renders `string.replace(find, repl)` as `.Replace(...)` (all occurrences, literal)", () => {
    expect(
      renderCsExpr({
        kind: "method-call",
        receiver: thisProp("name"),
        member: "replace",
        args: [litStr("a"), litStr("b")],
        receiverType: STRING,
        isCollectionOp: false,
      }),
    ).toBe('this.Name.Replace("a", "b")');
  });

  it("renders `string.split(sep)` as `.Split(sep).ToList()` (keeps empty segments, List API)", () => {
    expect(
      renderCsExpr({
        kind: "method-call",
        receiver: thisProp("name"),
        member: "split",
        args: [litStr(",")],
        receiverType: STRING,
        isCollectionOp: false,
      }),
    ).toBe('this.Name.Split(",").ToList()');
  });

  it("renders collection-op `count` as `.Count()`", () => {
    expect(
      renderCsExpr({
        kind: "method-call",
        receiver: thisProp("items"),
        member: "count",
        args: [],
        receiverType: { kind: "array", element: STRING },
        isCollectionOp: true,
      }),
    ).toBe("(this.Items).Count()");
  });

  it("renders collection-op `where(λ)` as `.Where(λ).ToList()`", () => {
    expect(
      renderCsExpr({
        kind: "method-call",
        receiver: thisProp("items"),
        member: "where",
        args: [{ kind: "lambda", param: "x", body: litBool("true") }],
        receiverType: { kind: "array", element: STRING },
        isCollectionOp: true,
      }),
    ).toBe("(this.Items).Where(x => true).ToList()");
  });

  it("renders collection-op `firstOrNull` as `.FirstOrDefault()`", () => {
    expect(
      renderCsExpr({
        kind: "method-call",
        receiver: thisProp("items"),
        member: "firstOrNull",
        args: [],
        receiverType: { kind: "array", element: STRING },
        isCollectionOp: true,
      }),
    ).toBe("(this.Items).FirstOrDefault()");
  });
});

describe("dotnet renderCsExpr — call kinds", () => {
  it("renders value-object-ctor as `new <Name>(...)`", () => {
    expect(
      renderCsExpr({
        kind: "call",
        callKind: "value-object-ctor",
        name: "Money",
        args: [litInt("3"), litStr("USD")],
      }),
    ).toBe('new Money(3, "USD")');
  });

  it("renders function call as `<recv>.<UpperName>(args)`", () => {
    expect(
      renderCsExpr({
        kind: "call",
        callKind: "function",
        name: "ComputeTotal",
        args: [litInt("3")],
      }),
    ).toBe("this.ComputeTotal(3)");
  });

  it("renders free function call upperFirst-cased, without receiver", () => {
    expect(renderCsExpr({ kind: "call", callKind: "free", name: "now", args: [] })).toBe("Now()");
  });
});

describe("dotnet renderCsExpr — binary, unary, paren, ternary", () => {
  it("renders int comparison with native operators (no === rewrite)", () => {
    expect(
      renderCsExpr({
        kind: "binary",
        op: "==",
        left: litInt("1"),
        right: litInt("2"),
        leftType: INT,
      }),
    ).toBe("1 == 2");
    expect(
      renderCsExpr({
        kind: "binary",
        op: "!=",
        left: litInt("1"),
        right: litInt("2"),
        leftType: INT,
      }),
    ).toBe("1 != 2");
  });

  it("renders money arithmetic with native `decimal` operators (C# decimal is precise)", () => {
    expect(
      renderCsExpr({
        kind: "binary",
        op: "+",
        left: litMoney("1"),
        right: litMoney("2"),
        leftType: MONEY,
      }),
    ).toBe("1m + 2m");
    expect(
      renderCsExpr({
        kind: "binary",
        op: "==",
        left: litMoney("1"),
        right: litMoney("2"),
        leftType: MONEY,
      }),
    ).toBe("1m == 2m");
  });

  it("renders unary minus and `!` as prefix operators", () => {
    expect(renderCsExpr({ kind: "unary", op: "-", operand: litInt("3") })).toBe("-3");
    expect(renderCsExpr({ kind: "unary", op: "!", operand: thisProp("active") })).toBe(
      "!this.Active",
    );
  });

  it("renders paren as `(inner)`", () => {
    expect(renderCsExpr({ kind: "paren", inner: litBool("true") })).toBe("(true)");
  });

  it("renders ternary as `cond ? then : else`", () => {
    expect(
      renderCsExpr({
        kind: "ternary",
        cond: litBool("true"),
        // biome-ignore lint/suspicious/noThenProperty: the ternary IR node's branch field is named `then`
        then: litInt("1"),
        otherwise: litInt("2"),
      }),
    ).toBe("true ? 1 : 2");
  });
});

describe("dotnet renderCsExpr — convert", () => {
  it("string(money) → `<expr>.ToString(InvariantCulture)`", () => {
    expect(
      renderCsExpr({ kind: "convert", target: "string", from: "money", value: thisProp("price") }),
    ).toBe("this.Price.ToString(System.Globalization.CultureInfo.InvariantCulture)");
  });

  it("string(int) → `<expr>.ToString(InvariantCulture)` (CA1305-clean)", () => {
    expect(
      renderCsExpr({ kind: "convert", target: "string", from: "int", value: litInt("3") }),
    ).toBe("3.ToString(System.Globalization.CultureInfo.InvariantCulture)");
  });

  it("money(int) → `(decimal)<expr>`", () => {
    expect(
      renderCsExpr({ kind: "convert", target: "money", from: "int", value: litInt("5") }),
    ).toBe("(decimal)5");
  });

  it("money(money) → no-op (pass-through)", () => {
    expect(
      renderCsExpr({ kind: "convert", target: "money", from: "money", value: thisProp("amount") }),
    ).toBe("this.Amount");
  });

  it("decimal(money) → no-op in C# (money IS decimal — unlike the lossy TS narrowing)", () => {
    expect(
      renderCsExpr({
        kind: "convert",
        target: "decimal",
        from: "money",
        value: thisProp("amount"),
      }),
    ).toBe("this.Amount");
  });
});

describe("dotnet renderCsExpr — match → right-folded ternary", () => {
  it("lowers a single-arm match to `(cond ? value : tail)` with `null` tail", () => {
    expect(
      renderCsExpr({ kind: "match", arms: [{ cond: thisProp("active"), value: litStr("yes") }] }),
    ).toBe('(this.Active ? "yes" : null)');
  });

  it("includes the `otherwise` branch as the tail", () => {
    expect(
      renderCsExpr({
        kind: "match",
        arms: [{ cond: thisProp("active"), value: litStr("yes") }],
        otherwise: litStr("no"),
      }),
    ).toBe('(this.Active ? "yes" : "no")');
  });

  it("right-folds multiple arms with the later arms nested deeper", () => {
    expect(
      renderCsExpr({
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

describe("dotnet renderCsExpr — lambda, new, list, object", () => {
  it("renders single-expression lambda as `x => expr`", () => {
    expect(renderCsExpr({ kind: "lambda", param: "item", body: thisProp("active") })).toBe(
      "item => this.Active",
    );
  });

  it("renders block-body lambda as a TODO arrow (not C#-renderable)", () => {
    expect(renderCsExpr({ kind: "lambda", param: "x", block: [] })).toMatch(
      /x => \{ \/\* block-body lambda/,
    );
  });

  it("renders entity-part constructor with Id + ParentId boilerplate", () => {
    expect(
      renderCsExpr({
        kind: "new",
        partName: "LineItem",
        fields: [{ name: "sku", value: litStr("ABC") }],
      }),
    ).toBe(
      'LineItem._Create(new LineItem.State { Id = LineItemId.New(), ParentId = this.Id, Sku = "ABC" })',
    );
  });

  it("renders list literal as a C# array initializer", () => {
    expect(renderCsExpr({ kind: "list", elements: [litInt("1"), litInt("2"), litInt("3")] })).toBe(
      "new[] { 1, 2, 3 }",
    );
  });

  it("renders object literal as an anonymous object with PascalCase members", () => {
    expect(
      renderCsExpr({
        kind: "object",
        fields: [
          { name: "name", value: litStr("Ada") },
          { name: "age", value: litInt("36") },
        ],
      }),
    ).toBe('new { Name = "Ada", Age = 36 }');
  });
});

describe("dotnet renderCsType — generic carriers (P3b)", () => {
  it("renders `paged` as the generic Paged<T> record over the domain type", () => {
    const t: TypeIR = {
      kind: "genericInstance",
      ctor: "paged",
      arg: { kind: "entity", name: "Order" },
    };
    expect(renderCsType(t)).toBe("Paged<Order>");
  });

  it("renders `envelope` as Envelope<T>", () => {
    const t: TypeIR = {
      kind: "genericInstance",
      ctor: "envelope",
      arg: { kind: "primitive", name: "string" },
    };
    expect(renderCsType(t)).toBe("Envelope<string>");
  });
});
