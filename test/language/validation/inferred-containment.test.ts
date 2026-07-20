// `contains` is optional sugar (see `src/language/containment.ts`).  A value
// field typed as a local `entity` part is a containment, so it may carry only
// what `contains` carries — a name, `[]`, and `?`.  The value-property modifiers
// are meaningless on a child entity and are rejected with a pointer to the
// explicit form (`loom.entity-field-modifier`); `[]?` is rejected the same way
// `contains` itself rejects it.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const agg = (line: string) => `
  context C {
    aggregate Order {
      code: string
      ${line}
      entity OrderLine { sku: string }
    }
  }
`;

describe("validator: `contains`-less entity-typed field", () => {
  it("accepts a bare entity-typed field with no modifiers", async () => {
    const { errors } = await parseString(agg("lines: OrderLine[]"));
    expect(errors, errors.join("\n")).toEqual([]);
  });

  for (const [mod, needle] of [
    ["line: OrderLine provenanced", "'provenanced' does not apply"],
    ["line: OrderLine immutable", "does not apply"],
    ['line: OrderLine = OrderLine { sku: "x" }', "'= default' does not apply"],
    ["line: OrderLine sensitive(pii)", "'sensitive(...)' does not apply"],
    ['line: OrderLine check line.sku != ""', "'check' does not apply"],
  ] as const) {
    it(`rejects value-property modifier on: ${mod}`, async () => {
      const { errors } = await parseString(agg(mod));
      expect(
        errors.some((e) => e.includes(needle)),
        errors.join("\n"),
      ).toBe(true);
    });
  }

  it("rejects `[]?` on an inferred containment", async () => {
    const { errors } = await parseString(agg("lines: OrderLine[]?"));
    expect(
      errors.some((e) => /both a collection and optional/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("does not require an inferred containment at construction", async () => {
    // `Order` is constructed without `lines`; a containment auto-defaults to
    // empty, so no `loom.construction-missing-field` must fire for it.
    const { errors } = await parseString(`
      context C {
        aggregate Order {
          code: string
          lines: OrderLine[]
          entity OrderLine { sku: string }
          create seed() { }
        }
      }
    `);
    expect(
      errors.some((e) => /construction-missing-field/.test(e) && /lines/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });
});
