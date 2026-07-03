// Coverage for remediation B3 — let-bound locals get their real initializer
// type in `envForNode`.
//
// Previously `collectLetBindings` bound every `let` to `T.unknown`, so any
// expression-level operand check that read a `let` operand via `envForNode`
// was silently disengaged (the `unknown` cascade-suppression path).  The fix
// unifies the two env builders: `envForNode` now threads each let's precise
// type (the same one `checkStatement` computes when it walks the body), so an
// ill-typed comparison against a `let` operand is caught like a field operand.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

describe("let-binding operand typing", () => {
  it('`let s = "hello"  requires s > 5` errors (string vs int comparison)', async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          n: int
          operation compute() {
            let s = "hello"
            requires s > 5
          }
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/cannot compare 'string' with 'int'/);
  });

  it("a well-typed let comparison stays clean", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          n: int
          operation compute() {
            let total = 3
            requires total > 5
          }
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("a let bound to a field carries the field's type (`string` let vs int errors)", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          name: string
          operation compute() {
            let alias = name
            requires alias > 5
          }
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/cannot compare 'string' with 'int'/);
  });

  it("a later let reading an earlier let is typed correctly (int chain stays clean)", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          n: int
          operation compute() {
            let base = 2
            let doubled = base + base
            requires doubled > 1
          }
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("a later let mixing an earlier string let with an int errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          n: int
          operation compute() {
            let label = "x"
            requires label > n
          }
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/cannot compare 'string' with 'int'/);
  });
});
