// Implicit `string + X` concatenation — when one operand of `+`
// is `string` and the other is in {int, long, decimal, money, bool,
// enum, X id}, the result is `string` with the non-string side
// auto-converted via the same `convert` IR explicit `string(x)`
// produces.  Universal across modern `+`-for-concat languages
// (JS / Java / C# / Elixir interpolation).
//
// Limited to `+` arithmetic: comparison (`name == age` — JS's
// `"5" == 5` footgun), direct assignment (`label: string = age`),
// and everything else stay strict per #506.

import { describe, expect, it } from "vitest";
import { allAggregates } from "../../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../../_helpers/index.js";
import { parseString } from "../../_helpers/parse.js";

describe("implicit string concat — admitted source primitives", () => {
  it("`'hello' + age` (string + int) validates and lowers with convert wrap", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate User {
          age: int
          derived label: string = "hello " + age
        }
        repository Users for User { }
      }
    `);
    expect(errors).toEqual([]);

    const loom = await buildLoomModel(`
      context X {
        aggregate User {
          age: int
          derived label: string = "hello " + age
        }
        repository Users for User { }
      }
    `);
    const u = allAggregates(loom).find((a) => a.name === "User")!;
    const label = u.derived.find((d) => d.name === "label")!;
    const bin = label.expr as Extract<typeof label.expr, { kind: "binary" }>;
    // Right operand wrapped in convert; the IR is identical to what
    // explicit `string(age)` would produce.
    expect(bin.right).toEqual({
      kind: "convert",
      target: "string",
      from: "int",
      value: expect.objectContaining({ kind: "ref", name: "age" }),
    });
  });

  it("`age + 'hello'` (commutative — left operand wraps)", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate User {
          age: int
          derived label: string = age + " yrs"
        }
        repository Users for User { }
      }
    `);
    const u = allAggregates(loom).find((a) => a.name === "User")!;
    const label = u.derived.find((d) => d.name === "label")!;
    const bin = label.expr as Extract<typeof label.expr, { kind: "binary" }>;
    expect(bin.left).toEqual({
      kind: "convert",
      target: "string",
      from: "int",
      value: expect.objectContaining({ kind: "ref", name: "age" }),
    });
  });

  const cases = [
    ["int", "age: int", "age"],
    ["long", "count: long", "count"],
    ["decimal", "rate: decimal", "rate"],
    ["money", "price: money", "price"],
    ["bool", "active: bool", "active"],
  ] as const;
  for (const [name, decl, refName] of cases) {
    it(`string + ${name} admitted`, async () => {
      const { errors } = await parseString(`
        context X {
          aggregate User {
            ${decl}
            derived label: string = "v: " + ${refName}
          }
          repository Users for User { }
        }
      `);
      expect(errors).toEqual([]);
    });
  }

  it("string + enum admitted", async () => {
    const { errors } = await parseString(`
      context X {
        enum Status { Active, Inactive }
        aggregate User {
          status: Status
          derived label: string = "status: " + status
        }
        repository Users for User { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("string + X id admitted (id wraps a primitive)", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate User {
          owner: Owner id
          derived label: string = "owner: " + owner
        }
        aggregate Owner {
          name: string
        }
        repository Users for User { }
        repository Owners for Owner { }
      }
    `);
    expect(errors).toEqual([]);
  });
});

describe("implicit string concat — domain types still reject", () => {
  // The strict gate stays: VOs / aggregates / arrays / datetime /
  // guid don't have a universal string form.  User must opt in
  // explicitly (`string(value.<displayField>)`) or wait for the
  // `display:`-anchored toString to ship.

  it("string + value object errors", async () => {
    const { errors } = await parseString(`
      context X {
        valueobject Money { amount: decimal currency: string }
        aggregate Order {
          total: Money
          derived label: string = "total: " + total
        }
        repository Orders for Order { }
      }
    `);
    expect(errors.join("\n")).toMatch(/incompatible operand types/);
  });

  it("string + datetime errors (format ambiguity)", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Event {
          at: datetime
          derived label: string = "at: " + at
        }
        repository Events for Event { }
      }
    `);
    expect(errors.join("\n")).toMatch(/incompatible operand types/);
  });
});

describe("implicit string concat — comparisons + assignment stay strict", () => {
  // The `==`, `!=`, `<` etc. operators across cross-type pairs are
  // the JS `"5" == 5` footgun the strict gate exists to close.  They
  // STAY strict — implicit-concat doesn't bleed into comparison.

  it("`name == age` (string == int) still errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate User {
          name: string
          age: int
          derived bad: bool = name == age
        }
        repository Users for User { }
      }
    `);
    expect(errors.join("\n")).toMatch(/cannot compare 'string' with 'int'/);
  });

  it("`derived label: string = age` (direct assignment) still errors", async () => {
    // Different from concat: there's no `+ "..."` operator to anchor
    // the implicit conversion; direct assignment of int to a
    // string-typed declaration could be ambiguous (C# / Java reject;
    // JS / Python accept).  Loom stays strict.
    const { errors } = await parseString(`
      context X {
        aggregate User {
          age: int
          derived label: string = age
        }
        repository Users for User { }
      }
    `);
    expect(errors.join("\n")).toMatch(
      /Derived 'label' has expression of type 'int' but declared type is 'string'/,
    );
  });
});

describe("explicit `string(enum)` and `string(id)` (#513 extended)", () => {
  // The `<target>(value)` form admits enum + id as `string` sources
  // alongside primitives.  Same set as the implicit-concat rule.

  it("`string(status)` (enum) validates", async () => {
    const { errors } = await parseString(`
      context X {
        enum Status { Active, Inactive }
        aggregate User {
          status: Status
          derived label: string = string(status)
        }
        repository Users for User { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`string(owner)` (X id) validates", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate User {
          owner: Owner id
          derived label: string = string(owner)
        }
        aggregate Owner { name: string }
        repository Users for User { }
        repository Owners for Owner { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`string(money_field)` validates (regression — primitive case)", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Invoice {
          price: money
          derived label: string = string(price)
        }
        repository Invoices for Invoice { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`decimal(string_field)` still errors (deferred fallible parse)", async () => {
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
  });
});
