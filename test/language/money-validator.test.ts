// Validator-pass coverage for the money primitive's operand
// compatibility rule.  The type-system's `arithmeticResult` already
// returns `T.unknown` for invalid money mixing, but every
// validator gate that consumes a typed expression (`checkDerived`,
// `checkAssignOrCall`, etc.) suppresses errors when `actual.kind ===
// "unknown"` to avoid cascading from upstream resolution failures.
// That suppression silently swallows the money/decimal mismatch
// the primitive exists to catch.
//
// `checkBinaryMoneyOperands` walks every binary node in the model and
// fires an explicit diagnostic when the operands violate money's
// closed-arithmetic rules.  Comparison operators get a separate same-
// money-ness check.

import { describe, expect, it } from "vitest";
import { parseString } from "../_helpers/parse.js";

describe("money — invalid arithmetic is a validation error", () => {
  // money is closed; mixing with decimal/int/long for ± is rejected.

  it("`money + decimal` errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: money
          b: decimal
          derived sum: money = a + b
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/incompatible operand types/);
    expect(errors.join("\n")).toMatch(/Allowed/);
  });

  it("`money - int` errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: money
          b: int
          derived diff: money = a - b
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/incompatible operand types/);
  });

  it("`money * money` errors (only scaling × scalar is allowed)", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: money
          b: money
          derived prod: money = a * b
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/incompatible operand types/);
  });

  it("`money / money` errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: money
          b: money
          derived q: money = a / b
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/incompatible operand types/);
  });

  it("`decimal / money` errors (closed: only money / scalar allowed)", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: money
          b: decimal
          derived q: money = b / a
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/incompatible operand types/);
  });
});

describe("money — invalid comparisons are validation errors", () => {
  // money == decimal is meaningless even though typeOf returns bool;
  // we want a clear error rather than emitting `Decimal.compare(d,
  // scalar)` on Phoenix / `m.eq(num)` on TS.

  it("`money == decimal` errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: money
          b: decimal
          derived eq: bool = a == b
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/cannot compare 'money'/);
  });

  it("`money > int` errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: money
          b: int
          derived gt: bool = a > b
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/cannot compare 'money'/);
  });

  it("`money < money` is OK", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: money
          b: money
          derived lt: bool = a < b
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).not.toMatch(/money/);
  });

  it("`money == money` is OK", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: money
          b: money
          derived eq: bool = a == b
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).not.toMatch(/money/);
  });
});

describe("money — valid arithmetic passes validation", () => {
  // Sanity checks: the legal money operations don't trip the new
  // validator gate.  Catches an over-zealous error rule that flags
  // any money binary unconditionally.

  it("`money + money` is OK", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: money
          b: money
          derived sum: money = a + b
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`money * decimal` is OK (scaling)", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: money
          b: decimal
          derived scaled: money = a * b
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`money / int` is OK (scaling)", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: money
          b: int
          derived scaled: money = a / b
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`decimal * money` is OK (commutative scaling)", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          a: money
          b: decimal
          derived scaled: money = b * a
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`money` operations don't trip non-money expressions", async () => {
    // Mixed expression containing both money arithmetic and ordinary
    // numeric widening — only money operands should be scrutinised.
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          price: money
          qty: int
          weight: decimal
          derived total: money = price * qty
          derived size: decimal = weight + qty
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });
});

describe("money — invariants and preconditions are gated too", () => {
  // The pass walks every binary in the model, not just derived.
  // Catches the regression where an invariant could express
  // `subtotal >= taxRate` (money vs decimal) and silently pass.

  it("`subtotal >= taxRate` in an invariant errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Invoice {
          subtotal: money
          taxRate: decimal
          invariant subtotal >= taxRate
        }
        repository Invoices for Invoice { }
      }
    `);
    expect(errors.join("\n")).toMatch(/cannot compare 'money'/);
  });

  it("`amount > rate` in a precondition errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Invoice {
          subtotal: money
          rate: decimal
          operation apply(amount: money) {
            precondition amount > rate
            subtotal := subtotal - amount
          }
        }
        repository Invoices for Invoice { }
      }
    `);
    expect(errors.join("\n")).toMatch(/cannot compare 'money'/);
  });
});
