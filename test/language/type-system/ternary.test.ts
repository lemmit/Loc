// Validator coverage for ternary expressions (`cond ? a : b`).
//
// Before remediation B2 the ternary was completely unchecked: `typeOf`
// returned the then-branch blindly and there was no validator arm, so
// `s ? 1 : 2` (a string condition) and `f ? 1 : "oops"` (int vs string
// branches) both typechecked silently.  The fix adds:
//   • a `bool` requirement on the condition;
//   • a branch-join requirement (one branch assignable to the other, or a
//     shared numeric / optional / null supertype), reported when absent;
//   • `typeOf(TernaryExpr)` returning the JOIN of the branches (the more
//     general side) rather than the then-branch — so the surrounding
//     assignment check sees the true type.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

describe("validator — ternary condition", () => {
  it("`string ? 1 : 2` (non-bool condition) errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          name: string
          derived pick: int = name ? 1 : 2
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/[Tt]ernary condition must be of type 'bool'/);
  });

  it("`int ? a : b` (non-bool condition) errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          n: int
          derived pick: int = n ? 1 : 2
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/[Tt]ernary condition must be of type 'bool'/);
  });

  it("`bool ? 1 : 2` (bool condition) stays clean", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          flag: bool
          derived pick: int = flag ? 1 : 2
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });
});

describe("validator — ternary branches", () => {
  it("incompatible branches (`int` vs `string`) error", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          flag: bool
          derived pick: int = flag ? 1 : "oops"
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/[Tt]ernary branches have incompatible types/);
  });

  it("compatible numeric branches (`int` / `long` widening) join to `long` and stay clean", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          flag: bool
          a: int
          b: long
          derived pick: long = flag ? a : b
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`T` / `T?` mixed branches join to `T?` and stay clean", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          flag: bool
          name: string
          note: string?
          derived pick: string? = flag ? name : note
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`T` / `null` branches join to `T?` and stay clean", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          flag: bool
          name: string
          derived pick: string? = flag ? name : null
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });
});

describe("validator — ternary result type (join) flows into the assignment target", () => {
  it("branch-to-target mismatch: `int`-joined ternary assigned to a `string` derived errors", async () => {
    // Both branches are int (compatible with each other → no branch error),
    // but the join `int` is not assignable to the declared `string` — the
    // derived-type check catches it now that `typeOf` returns the join.
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          flag: bool
          derived pick: string = flag ? 1 : 2
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/declared type is 'string'|type 'int'/);
  });

  it("join type assigned to a matching target stays clean", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          flag: bool
          a: int
          b: long
          derived pick: long = flag ? a : b
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });
});
