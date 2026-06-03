// Field-access modifier keywords (`FieldAccess` rule in
// `src/language/ddd.langium`) are admitted as identifiers in
// property / parameter / expression positions via the same
// soft-keyword pattern as `money`.  Without that admission,
// adding these keywords would silently break user code that
// happens to use words like `secret`, `token`, `internal`,
// `managed`, or `immutable` as ordinary identifiers.
//
// Parallel to test/language/money-type-system.test.ts.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const MODIFIERS = ["immutable", "managed", "token", "internal", "secret"] as const;

async function parseValid(src: string): Promise<void> {
  const { errors } = await parseString(src);
  if (errors.length) throw new Error(`expected no errors, got: ${errors.join("; ")}`);
}

describe("field-access modifier keywords — soft-keyword admission", () => {
  // Use each of the five modifier names as a regular identifier in
  // every position where Loom expects an identifier.  All five must
  // parse without errors despite being reserved in the access slot
  // of `Property`.

  for (const name of MODIFIERS) {
    it(`\`${name}\` may name a field of any non-Id type`, async () => {
      await parseValid(`
        context T {
          aggregate A {
            ${name}: int
            derived doubled: int = ${name} + ${name}
          }
          repository As for A { }
        }
      `);
    });

    it(`\`${name}\` may name an operation parameter`, async () => {
      await parseValid(`
        context T {
          aggregate A {
            balance: int
            operation tweak(${name}: int) {
              balance := balance + ${name}
            }
          }
          repository As for A { }
        }
      `);
    });

    it(`\`${name}\` resolves through expression NameRef position`, async () => {
      await parseValid(`
        context T {
          aggregate A {
            ${name}: int
            n: int
            invariant n == ${name}
          }
          repository As for A { }
        }
      `);
    });
  }
});

describe("field-access modifier keywords — hard-keyword position", () => {
  // Conversely: in the access slot of Property, the same words
  // ARE reserved and select the modifier semantics.

  it.each(MODIFIERS)("`%s` is recognised as the field-access modifier", async (modifier) => {
    const { model, errors } = await parseString(`
      context T {
        aggregate A {
          label: string ${modifier === "token" ? "" : ""}
          payload: ${modifier === "token" ? "int" : "string"} ${modifier}
        }
        repository As for A { }
      }
    `);
    expect(errors).toEqual([]);
    // Walk to the Property and confirm access landed.
    const { isAggregate, isBoundedContext, isProperty } = await import(
      "../../../src/language/generated/ast.js"
    );
    const ctx = (model.members ?? []).find(isBoundedContext);
    const agg = (ctx?.members ?? []).find(isAggregate);
    const payload = (agg?.members ?? []).filter(isProperty).find((p) => p.name === "payload");
    expect(payload).toBeDefined();
    expect(payload?.access).toBe(modifier);
  });
});
