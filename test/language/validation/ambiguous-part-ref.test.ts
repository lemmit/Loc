// Cross-aggregate entity-part reference ambiguity (full-review remediation
// §B8).  Entity parts are exported to the document's global scope by bare
// name (ddd-scope.ts); when two aggregates each declare an `entity Line`, an
// `X id` link written `l: Line id` resolved to an arbitrary one with no
// diagnostic.  `checkAmbiguousPartRefs` in `src/language/validators/
// structural.ts` reports the ambiguity at the reference site.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const parse = (source: string) => parseString(source);

describe("validator: ambiguous entity-part `X id` reference", () => {
  it("flags a bare `Line id` when two aggregates declare an `entity Line`", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        aggregate A { x: int  entity Line { a: int } }
        aggregate B { y: int  entity Line { b: int } }
        aggregate D { l: Line id }
      } } }
    `);
    expect(
      errors.some(
        (e) => /Ambiguous entity-part reference 'Line id'/.test(e) && /'A' and 'B'/.test(e),
      ),
      errors.join("\n"),
    ).toBe(true);
  });

  it("does not flag a unique entity-part name (single owner)", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        aggregate A { x: int  entity Line { a: int } }
        aggregate D { l: Line id }
      } } }
    `);
    expect(
      errors.some((e) => /Ambiguous entity-part reference/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("does not flag a same-aggregate containment of a locally-named part", async () => {
    // Both aggregates own an `entity Row`, but the reference is a `contains`
    // (scoped to local parts), never a global `X id` link — so it is
    // unambiguous and must not trip the check.
    const { errors } = await parse(`
      system S { subdomain M { context C {
        aggregate A { x: int  entity Row { a: int }  contains rows: Row[] }
        aggregate B { y: int  entity Row { b: int }  contains rows: Row[] }
      } } }
    `);
    expect(
      errors.some((e) => /Ambiguous entity-part reference/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });
});
