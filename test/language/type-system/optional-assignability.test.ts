// Optional-to-optional assignability must check the INNER types.
//
// Regression: `isAssignable` previously treated ANY `T?` as assignable
// to ANY `U?` (a bare `value.kind === "optional"` disjunct), so
// `int? := string?` validated clean and every backend then emitted
// ill-typed code.  The fix requires the optional value's own inner type
// to be assignable to the target's inner type, while preserving:
//   - `never → T?`   (the `null` literal)
//   - `T → T?`       (bare-value wrapping)
//   - `int? → long?` (numeric widening composing through the optional)

import { describe, expect, it } from "vitest";
import { isAssignable, T } from "../../../src/language/type-system.js";
import { parseString } from "../../_helpers/parse.js";

describe("optional assignability — unit (isAssignable)", () => {
  const intT = T.prim("int");
  const longT = T.prim("long");
  const stringT = T.prim("string");

  it("int? := string? is NOT assignable (inner mismatch)", () => {
    expect(isAssignable(T.opt(stringT), T.opt(intT))).toBe(false);
  });

  it("int? := int? is assignable (same inner)", () => {
    expect(isAssignable(T.opt(intT), T.opt(intT))).toBe(true);
  });

  it("null (never) → int? is assignable", () => {
    expect(isAssignable(T.never, T.opt(intT))).toBe(true);
  });

  it("int → int? is assignable (bare-value wrapping)", () => {
    expect(isAssignable(intT, T.opt(intT))).toBe(true);
  });

  it("int? → long? is assignable (numeric widening through optional)", () => {
    expect(isAssignable(T.opt(intT), T.opt(longT))).toBe(true);
  });

  it("long? → int? is NOT assignable (no narrowing through optional)", () => {
    expect(isAssignable(T.opt(longT), T.opt(intT))).toBe(false);
  });

  it("string? → int? is NOT assignable in either direction", () => {
    expect(isAssignable(T.opt(stringT), T.opt(intT))).toBe(false);
    expect(isAssignable(T.opt(intT), T.opt(stringT))).toBe(false);
  });
});

describe("optional assignability — validation (assignment statements)", () => {
  it("rejects `int? := string?` in an operation body", async () => {
    const { errors } = await parseString(`
      context T {
        aggregate A {
          a: int?
          b: string?
          operation op() { a := b }
        }
        repository As for A { }
      }
    `);
    expect(errors.some((e) => /Cannot assign/.test(e) && /int/.test(e))).toBe(true);
  });

  it("accepts `int? := int?`", async () => {
    const { errors } = await parseString(`
      context T {
        aggregate A {
          a: int?
          b: int?
          operation op() { a := b }
        }
        repository As for A { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("accepts `int? := null` (null literal wraps)", async () => {
    const { errors } = await parseString(`
      context T {
        aggregate A {
          a: int?
          operation op() { a := null }
        }
        repository As for A { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("accepts `int? := <int>` (bare value wraps)", async () => {
    const { errors } = await parseString(`
      context T {
        aggregate A {
          a: int?
          b: int
          operation op() { a := b }
        }
        repository As for A { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("accepts `long? := int?` (numeric widening through optional)", async () => {
    const { errors } = await parseString(`
      context T {
        aggregate A {
          a: long?
          b: int?
          operation op() { a := b }
        }
        repository As for A { }
      }
    `);
    expect(errors).toEqual([]);
  });
});

describe("optional assignability — validation (emit field shape)", () => {
  it("rejects an `int?` emit field fed a `string?` value", async () => {
    const { errors } = await parseString(`
      context T {
        event Done { n: int? }
        aggregate A {
          s: string?
          operation finish() {
            emit Done { n: s }
          }
        }
        repository As for A { }
      }
    `);
    expect(errors.some((e) => /Done|int|string/.test(e))).toBe(true);
  });
});
