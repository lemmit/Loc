// `extends` cycle detection (full-review remediation §B7, audit finding 5b).
// The inheritance validator flagged only direct self-extension; a mutual or
// longer cycle (A extends B extends A) validated clean and silently truncated
// inherited fields.  Rule 1b in `src/language/validators/inheritance.ts` now
// reports the loop with `loom.extends-cycle`.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const parse = (source: string) => parseString(source);

describe("validator: extends cycles", () => {
  it("flags a two-aggregate mutual cycle", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        abstract aggregate A extends B { x: int }
        abstract aggregate B extends A { y: int }
      } } }
    `);
    expect(
      errors.some((e) => /'extends' cycle: A → B → A/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("flags a three-aggregate cycle and names the whole loop", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        abstract aggregate A extends B { x: int }
        abstract aggregate B extends D { y: int }
        abstract aggregate D extends A { z: int }
      } } }
    `);
    expect(
      errors.some((e) => /'extends' cycle: A → B → D → A/.test(e)),
      errors.join("\n"),
    ).toBe(true);
    // The cycle is reported once, not once per entry point.
    const hits = errors.filter((e) => /is part of an 'extends' cycle/.test(e));
    expect(hits.length, errors.join("\n")).toBe(1);
  });

  it("keeps self-extension on its own dedicated code (not the cycle code)", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        abstract aggregate A extends A { x: int }
      } } }
    `);
    // Rule 1 (`loom.extends-self`) owns the length-1 case.
    expect(
      errors.some((e) => /cannot extend itself/.test(e)),
      errors.join("\n"),
    ).toBe(true);
    expect(errors.some((e) => /is part of an 'extends' cycle/.test(e))).toBe(false);
  });

  it("accepts a legal linear inheritance chain", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        abstract aggregate Base { x: int }
        abstract aggregate Mid extends Base { y: int }
        aggregate Leaf extends Mid { z: int }
        repository Leaves for Leaf { }
      } } }
    `);
    expect(
      errors.some((e) => /extends' cycle/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });
});
