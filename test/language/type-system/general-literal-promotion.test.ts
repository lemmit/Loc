// General-numeric literal promotion (#508 extended beyond money).
//
// A bare IntLit in a typed long / decimal context is elaborated to
// that primitive's IR literal kind (`lit("long", ...)` /
// `lit("decimal", ...)`) so backends emit the right form — in
// particular .NET's `long` literals MUST carry the `L` suffix when
// the value exceeds Int32.MaxValue, otherwise the C# compiler
// rejects with "Integral constant is too large".
//
// Money's promotion (#508) is covered by money-literal-promotion.test.ts;
// this file focuses on the non-money primitives the same seam now
// handles.

import { describe, expect, it } from "vitest";
import { allAggregates } from "../../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../../_helpers/index.js";
import { parseString } from "../../_helpers/parse.js";

describe("literal promotion — IR carries the elaborated kind", () => {
  it("`derived total: long = 9999999999` lowers to lit('long', ...)", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate Foo {
          derived total: long = 9999999999
        }
        repository Foos for Foo { }
      }
    `);
    const foo = allAggregates(loom).find((a) => a.name === "Foo")!;
    const total = foo.derived.find((d) => d.name === "total")!;
    // Pre-promotion: IR would carry lit("int", "9999999999"); the
    // .NET emitter would write `long total = 9999999999;` which
    // C# rejects (literal overflows int).  Post-promotion: lit
    // carries "long" and .NET appends the `L` suffix.
    expect(total.expr).toEqual({
      kind: "literal",
      lit: "long",
      value: "9999999999",
    });
  });

  it("`derived rate: decimal = 5` lowers to lit('decimal', ...)", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate Foo {
          derived rate: decimal = 5
        }
        repository Foos for Foo { }
      }
    `);
    const foo = allAggregates(loom).find((a) => a.name === "Foo")!;
    const rate = foo.derived.find((d) => d.name === "rate")!;
    // The implicit int→decimal conversion existed already; this
    // pins the IR-side type-honesty so the .NET emitter writes
    // `5m` (canonical decimal literal) rather than `5` (which
    // still works via implicit conversion but is less explicit).
    expect(rate.expr).toEqual({
      kind: "literal",
      lit: "decimal",
      value: "5",
    });
  });

  it("`derived n: int = 5` is unchanged (no anchor, no promotion)", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate Foo {
          derived n: int = 5
        }
        repository Foos for Foo { }
      }
    `);
    const foo = allAggregates(loom).find((a) => a.name === "Foo")!;
    const n = foo.derived.find((d) => d.name === "n")!;
    // `toMatchObject` — the un-promoted literal lowers through the `lowerExpr`
    // wrapper (src/ir/lower/lower-expr.ts), which stamps a real M14 `origin`.
    expect(n.expr).toMatchObject({ kind: "literal", lit: "int", value: "5" });
  });
});

describe("literal promotion in binary expressions — operand-typed anchor", () => {
  it("`count + 5` (long + IntLit) promotes the literal to long", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate Foo {
          count: long
          derived bumped: long = count + 5
        }
        repository Foos for Foo { }
      }
    `);
    const foo = allAggregates(loom).find((a) => a.name === "Foo")!;
    const bumped = foo.derived.find((d) => d.name === "bumped")!;
    const bin = bumped.expr as Extract<typeof bumped.expr, { kind: "binary" }>;
    expect(bin.leftType).toEqual({ kind: "primitive", name: "long" });
    expect(bin.resultType).toEqual({ kind: "primitive", name: "long" });
    // `toMatchObject` — see the M14 origin note above.
    expect(bin.right).toMatchObject({ kind: "literal", lit: "long", value: "5" });
  });

  it("`5 + rate` (IntLit + decimal) promotes the literal to decimal", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate Foo {
          rate: decimal
          derived shifted: decimal = 5 + rate
        }
        repository Foos for Foo { }
      }
    `);
    const foo = allAggregates(loom).find((a) => a.name === "Foo")!;
    const shifted = foo.derived.find((d) => d.name === "shifted")!;
    const bin = shifted.expr as Extract<typeof shifted.expr, { kind: "binary" }>;
    // `toMatchObject` — see the M14 origin note above.
    expect(bin.left).toMatchObject({ kind: "literal", lit: "decimal", value: "5" });
  });

  it("`count + n` (long + int field — both typed values) does NOT promote", async () => {
    // Promotion fires only on AST literals; a typed `int` field
    // opposite a `long` field follows the existing widening chain
    // (int → long inside `arithmeticResult`) and stays as the
    // un-promoted IR shape.  Validator accepts via widening.
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          count: long
          n: int
          derived sum: long = count + n
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });
});

describe("literal promotion — narrowing is NOT admitted", () => {
  it("`derived n: int = 5.0` (DecLit in int context) errors", async () => {
    // A fractional literal in an integer context is almost
    // certainly a typo — the strict gate surfaces it instead of
    // silently truncating.
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          derived n: int = 5.0
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(
      /Derived 'n' has expression of type 'decimal' but declared type is 'int'/,
    );
  });

  it("`derived n: long = 5.0` errors (same reason)", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          derived n: long = 5.0
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(
      /Derived 'n' has expression of type 'decimal' but declared type is 'long'/,
    );
  });
});
