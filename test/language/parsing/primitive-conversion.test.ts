// Explicit primitive-conversion vocabulary — `<target>(value)`.
//
// Source-level form: `string(age)` (int → string for concat),
// `money(decimalField)` (typed bridge), `decimal(moneyValue)`
// (lossy projection), etc.  Distinct from MoneyLit's `money("…")`
// literal form: this is for converting a TYPED VALUE, not a
// source-text literal.
//
// The validator admits only infallible (source, target) pairs:
//   string  ← {int, long, decimal, money, bool}
//   long    ← int
//   decimal ← {int, long, money}
//   money   ← {int, long, decimal}
// Fallible parses (string → numeric / datetime / bool) and
// narrowing (long → int, decimal → long) are deferred pending a
// `T?`-vs-throw failure-model decision.

import { describe, expect, it } from "vitest";
import { allAggregates } from "../../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../../_helpers/index.js";
import { parseString } from "../../_helpers/parse.js";

describe("conversion vocabulary — admitted pairs validate", () => {
  it("`string(age)` (int → string) — covers string-concat after the strict validator", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate User {
          name: string
          age: int
          derived label: string = "Hello " + string(age)
        }
        repository Users for User { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`string(price)` (money → string) uses the precise to-string", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Invoice {
          price: money
          derived label: string = "price: " + string(price)
        }
        repository Invoices for Invoice { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`money(taxRate)` (decimal → money) — typed value bridge", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Invoice {
          taxRate: decimal
          derived asAmount: money = money(taxRate)
        }
        repository Invoices for Invoice { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`decimal(subtotal)` (money → decimal) — explicit lossy projection", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Invoice {
          subtotal: money
          derived rough: decimal = decimal(subtotal)
        }
        repository Invoices for Invoice { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`long(count)` (int → long) — explicit widening", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          count: int
          derived big: long = long(count)
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`string(flag)` (bool → string)", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          flag: bool
          derived label: string = string(flag)
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });
});

describe("conversion vocabulary — non-admitted pairs error", () => {
  it("`int(price)` (money → int — narrowing) errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          price: money
          derived oops: int = int(price)
        }
        repository Foos for Foo { }
      }
    `);
    // `int(...)` isn't an admitted grammar form yet — the parser
    // can't recognise `int` as a PrimitiveConversion target so the
    // call parses as something else and the surrounding context
    // surfaces a type / parse error.
    expect(errors.join("\n")).not.toBe("");
  });

  it("`int(someString)` (fallible parse) errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          name: string
          derived oops: int = int(name)
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).not.toBe("");
  });

  it("`decimal(someString)` (fallible parse) errors with a specific message", async () => {
    // `decimal` IS an admitted PrimitiveConversion target; the
    // string-source rejection comes from `checkPrimitiveConversions`
    // and names the supported source set.
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          name: string
          derived oops: decimal = decimal(name)
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/Cannot convert 'string' to 'decimal'/);
    expect(errors.join("\n")).toMatch(/Fallible parses/);
  });

  it("`long(price)` (money → long — narrowing) errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          price: money
          derived oops: long = long(price)
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/Cannot convert 'money' to 'long'/);
  });
});

describe("conversion vocabulary — IR carries (from, target)", () => {
  it("`string(age)` lowers as { kind: 'convert', target: 'string', from: 'int' }", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate User {
          age: int
          derived label: string = string(age)
        }
        repository Users for User { }
      }
    `);
    const u = allAggregates(loom).find((a) => a.name === "User")!;
    const label = u.derived.find((d) => d.name === "label")!;
    expect(label.expr.kind).toBe("convert");
    const conv = label.expr as Extract<typeof label.expr, { kind: "convert" }>;
    expect(conv.target).toBe("string");
    expect(conv.from).toBe("int");
  });

  it("`money(taxRate)` lowers as { kind: 'convert', target: 'money', from: 'decimal' }", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate Foo {
          taxRate: decimal
          derived asMoney: money = money(taxRate)
        }
        repository Foos for Foo { }
      }
    `);
    const foo = allAggregates(loom).find((a) => a.name === "Foo")!;
    const asMoney = foo.derived.find((d) => d.name === "asMoney")!;
    const conv = asMoney.expr as Extract<typeof asMoney.expr, { kind: "convert" }>;
    expect(conv.target).toBe("money");
    expect(conv.from).toBe("decimal");
  });
});

describe('conversion vocabulary — disambiguation from `money("…")` literal', () => {
  // `money("10.50")` is a MoneyLit (string-arg → compile-time literal).
  // `money(decimalField)` is a PrimitiveConversion.  MoneyLit comes
  // first in PrimaryExpr so the string-arg form wins the parse;
  // PrimitiveConversion picks up the typed-value case.

  it("`money(\"10.50\")` stays a MoneyLit (lowers to lit('money', '10.50'))", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate Foo {
          derived total: money = money("10.50")
        }
        repository Foos for Foo { }
      }
    `);
    const foo = allAggregates(loom).find((a) => a.name === "Foo")!;
    const total = foo.derived.find((d) => d.name === "total")!;
    // `toMatchObject` — this literal lowers through the `lowerExpr` wrapper
    // (src/ir/lower/lower-expr.ts), which stamps a real M14 `origin`.
    expect(total.expr).toMatchObject({ kind: "literal", lit: "money", value: "10.50" });
  });

  it("`money(decimalField)` is a PrimitiveConversion, not a MoneyLit", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate Foo {
          rate: decimal
          derived asMoney: money = money(rate)
        }
        repository Foos for Foo { }
      }
    `);
    const foo = allAggregates(loom).find((a) => a.name === "Foo")!;
    const asMoney = foo.derived.find((d) => d.name === "asMoney")!;
    expect(asMoney.expr.kind).toBe("convert");
  });
});
