// Phase B — top-level (ambient) helper `function` (docs/old/plans/stdlib.md).
// A pure, expression-form function declared at file root / inside `system {}`,
// visible workspace-wide, that INLINES at every call site during lowering.
// Gates:
//   loom.function-recursive        — direct or mutual recursion (inline can't terminate)
//   loom.function-toplevel-block   — block-form has no emission home yet

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const wrap = (top: string, member: string): string => `
  ${top}
  context C {
    aggregate Order {
      quantity: int
      customerName: string
      ${member}
    }
    repository Orders for Order { }
  }
`;

describe("validation — Phase B top-level function", () => {
  it("accepts a pure expression-form function called from a derived / invariant", async () => {
    const { errors } = await parseString(
      wrap(
        `function isBlank(s: string): bool = s.trim().length == 0
         function dbl(n: int): int = n * 2`,
        `invariant !isBlank(customerName)
         derived twice: int = dbl(quantity)`,
      ),
    );
    expect(errors).toEqual([]);
  });

  it("type-checks the call's return type (wrong declared type errors)", async () => {
    const { errors } = await parseString(
      wrap(`function dbl(n: int): int = n * 2`, `derived bad: string = dbl(quantity)`),
    );
    expect(errors.some((e) => e.includes("int") && e.includes("string"))).toBe(true);
  });

  it("rejects a body that doesn't match the declared return type", async () => {
    const { errors } = await parseString(
      wrap(`function bad(): int = "hello"`, `derived d: int = bad()`),
    );
    expect(errors.some((e) => e.includes("returns 'string'") && e.includes("'int'"))).toBe(true);
  });

  it("rejects direct recursion — loom.function-recursive", async () => {
    const { diagnostics } = await parseString(
      wrap(`function loop(n: int): int = loop(n - 1)`, `derived d: int = loop(quantity)`),
    );
    expect(diagnostics.some((d) => d.code === "loom.function-recursive")).toBe(true);
  });

  it("rejects mutual recursion — loom.function-recursive", async () => {
    const { diagnostics } = await parseString(
      wrap(
        `function even(n: int): bool = n == 0 || odd(n - 1)
         function odd(n: int): bool = n == 1 || even(n - 1)`,
        `derived e: bool = even(quantity)`,
      ),
    );
    expect(diagnostics.some((d) => d.code === "loom.function-recursive")).toBe(true);
  });

  it("rejects a block-form top-level function — loom.function-toplevel-block", async () => {
    const { diagnostics } = await parseString(
      wrap(`function f(n: int): int { let x = n + 1  return x }`, `derived d: int = f(quantity)`),
    );
    expect(diagnostics.some((d) => d.code === "loom.function-toplevel-block")).toBe(true);
  });

  it("a LOCAL aggregate function shadows a top-level one of the same name", async () => {
    // Both named `dbl`; the local member wins (resolveCallKind precedence), so
    // no top-level recursion/typing surprise. Should validate cleanly.
    const { errors } = await parseString(
      wrap(
        `function dbl(n: int): int = n * 2`,
        `function dbl(): int = quantity + quantity
         derived d: int = dbl()`,
      ),
    );
    expect(errors).toEqual([]);
  });
});
