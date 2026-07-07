// A5 temporal (docs/plans/stdlib.md) — duration constructors
// (`days`/`hours`/`minutes`) + the closed temporal arithmetic rules in the
// type system, and the AST gates:
//   loom.duration-arity / loom.duration-arg-type
// A user declaration named like a constructor SHADOWS the builtin.
// `months` was removed as a duration unit/builtin entirely — it is now
// just an undeclared name wherever it appears.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const wrap = (body: string): string => `
  context C {
    aggregate Invoice ids guid {
      name: string
      createdAt: datetime
      dueDate: datetime
      deliveredAt: datetime
      orderedAt: datetime
      gracePeriod: int
      ${body}
    }
  }
`;

describe("validation — A5 duration constructors + temporal arithmetic", () => {
  it("accepts datetime ± duration, dt−dt, duration algebra, int-field amounts", async () => {
    const { errors } = await parseString(
      wrap(`
        derived due: datetime = createdAt + days(30)
        derived early: datetime = dueDate - hours(6)
        derived overdue: bool = now() > dueDate + days(1)
        operation slack(): bool {
          let span = deliveredAt - orderedAt
          let window = days(gracePeriod) + minutes(30)
          let doubled = days(1) * 2
          return span < window + doubled
        }
      `),
    );
    expect(errors).toEqual([]);
  });

  it("duration + datetime commutes (constructor on the left)", async () => {
    const { errors } = await parseString(wrap(`derived due: datetime = days(30) + createdAt`));
    expect(errors).toEqual([]);
  });

  it("a user function named days SHADOWS the builtin (no duration typing, no gates)", async () => {
    const { errors } = await parseString(
      wrap(`
        function days(x: int): int = x * 2
        derived n: int = days(3)
      `),
    );
    expect(errors).toEqual([]);
  });

  it("months(...) is no longer a duration builtin (unknown reference)", async () => {
    const { errors } = await parseString(wrap(`derived renewal: datetime = createdAt + months(1)`));
    expect(errors.length).toBeGreaterThan(0); // `months` is now an undeclared name
  });

  it('rejects a non-int amount (days("x"))', async () => {
    const { errors } = await parseString(wrap(`operation f() { let d = days("x") }`));
    expect(errors.some((e) => e.includes("'days' takes an 'int' amount"))).toBe(true);
  });

  it("rejects a decimal amount (days(1.5)) with the finer-unit hint", async () => {
    const { errors } = await parseString(wrap(`operation f() { let d = days(1.5) }`));
    expect(errors.some((e) => e.includes("finer unit"))).toBe(true);
  });

  it("rejects wrong arity — days() and days(1, 2)", async () => {
    const zero = await parseString(wrap(`operation f() { let d = days() }`));
    expect(zero.errors.some((e) => e.includes("exactly 1 argument"))).toBe(true);
    const two = await parseString(wrap(`operation f() { let d = days(1, 2) }`));
    expect(two.errors.some((e) => e.includes("exactly 1 argument"))).toBe(true);
  });

  it("rejects string + duration (existing binary-operand check fires on 'duration')", async () => {
    const { errors } = await parseString(wrap(`operation f() { let w = name + days(3) }`));
    expect(errors.some((e) => e.includes("'duration'"))).toBe(true);
  });

  it("rejects datetime + datetime and duration / int", async () => {
    const add = await parseString(wrap(`derived x: datetime = createdAt + dueDate`));
    expect(add.errors.length).toBeGreaterThan(0);
    const div = await parseString(wrap(`operation f() { let d = days(4) / 2 }`));
    expect(div.errors.length).toBeGreaterThan(0);
  });

  it("datetime relational comparison still works (comparable unaffected)", async () => {
    const { errors } = await parseString(wrap(`derived late: bool = deliveredAt > dueDate`));
    expect(errors).toEqual([]);
  });
});
