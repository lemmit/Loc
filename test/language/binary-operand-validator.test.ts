// Validator coverage for the GENERIC binary operand-compatibility
// rule.  Companion to money-validator.test.ts: that file covers
// the money-specific rules (`money + decimal` etc.); this one
// covers every other invalid combination the same `checkBinaryOperands`
// pass catches now — string + int, bool + decimal, enum comparison,
// VO-vs-non-VO comparison, logical ops on non-bool.
//
// Pre-flip ("every unknown should be an error"), these all silently
// typechecked because the validator's `actual.kind !== "unknown"`
// suppression in `checkDerived` / `checkAssignOrCall` couldn't
// distinguish "I couldn't figure it out" (legitimate cascade) from
// "this expression IS invalid" (operator-semantics rejection).

import { describe, expect, it } from "vitest";
import { parseString } from "../_helpers/parse.js";

describe("validator — generic invalid arithmetic operands", () => {
  it("`string + int` errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          name: string
          age:  int
          derived label: string = name + age
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/incompatible operand types/);
    expect(errors.join("\n")).toMatch(/'string'/);
    expect(errors.join("\n")).toMatch(/'int'/);
  });

  it("`bool * decimal` errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          flag: bool
          rate: decimal
          derived weird: decimal = flag * rate
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/incompatible operand types/);
  });

  it("`int - string` errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          n:   int
          tag: string
          derived gone: int = n - tag
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/incompatible operand types/);
  });

  it("`int + int` and `string + string` (legal) stay clean", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: int
          b: int
          x: string
          y: string
          derived sum:    int    = a + b
          derived concat: string = x + y
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("numeric widening (`int + decimal`) stays clean", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          n: int
          r: decimal
          derived sum: decimal = n + r
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });
});

describe("validator — generic invalid comparison operands", () => {
  it("`string == int` errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          name: string
          age:  int
          derived bad: bool = name == age
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/cannot compare 'string' with 'int'/);
  });

  it("`bool > int` errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          flag: bool
          n:    int
          derived bad: bool = flag > n
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/cannot compare/);
  });

  it("comparing two different enums errors", async () => {
    const { errors } = await parseString(`
      context X {
        enum Colour { Red, Green, Blue }
        enum Shape  { Square, Circle }
        aggregate Foo {
          c: Colour
          s: Shape
          derived bad: bool = c == s
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/cannot compare/);
  });

  it("`int < long` (numeric widening) stays clean", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: int
          b: long
          derived less: bool = a < b
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("comparing the same enum stays clean", async () => {
    const { errors } = await parseString(`
      context X {
        enum Colour { Red, Green, Blue }
        aggregate Foo {
          c: Colour
          derived isRed: bool = c == Colour.Red
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });
});

describe("validator — invalid logical operands", () => {
  it("`int && bool` errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          n:    int
          flag: bool
          derived bad: bool = n && flag
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/requires boolean operands/);
  });

  it("`bool && bool` stays clean", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: bool
          b: bool
          derived both: bool = a && b
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });
});

describe("validator — cascade prevention", () => {
  it("does NOT duplicate-error when an operand has an upstream resolution failure", async () => {
    // `nonExistent` doesn't resolve — typeOf returns unknown — the
    // ref-resolver already complains.  The binary-operand check
    // should skip (cascade prevention), not emit a second error
    // about "incompatible operand types with unknown".
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          n: int
          derived broken: int = n + nonExistent
        }
        repository Foos for Foo { }
      }
    `);
    // Exactly one error about the unresolved name; nothing about
    // operand types.
    const operandErrors = errors.filter((e) => /incompatible operand types/.test(e));
    expect(operandErrors).toEqual([]);
  });
});
