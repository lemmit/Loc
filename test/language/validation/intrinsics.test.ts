// Scalar-intrinsic call-shape validation (src/util/intrinsics.ts +
// checkIntrinsicCalls) — arity, positional-only args, argument types, and
// the bare-access rejection.  The catalogue is receiver-keyed, so none of
// these gates may fire on same-named USER members (a function named
// `replace` on a value object is not an intrinsic).

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { toLoomModel } from "../../_helpers/ir.js";
import { parseString } from "../../_helpers/parse.js";

const wrap = (body: string): string => `
  context C {
    aggregate Product ids guid {
      name: string
      ${body}
    }
  }
`;

describe("validation — scalar intrinsic calls", () => {
  it("accepts well-formed calls (chained, optional arity, arg types)", async () => {
    const { errors } = await parseString(
      wrap(`
        derived a: string = name.trim().toLower()
        derived b: string = name.substring(1)
        derived c: string = name.substring(1, 3)
        derived d: bool = name.startsWith("A") && name.contains("x")
        derived e: string = name.replace("a", "b")
        derived f: int = name.split(",").count
      `),
    );
    expect(errors).toEqual([]);
  });

  it("rejects wrong arity with the signature in the message", async () => {
    const { errors } = await parseString(wrap(`derived a: string = name.substring()`));
    expect(errors.some((e) => e.includes("substring(start: int, len?: int): string"))).toBe(true);
  });

  it("rejects too many arguments", async () => {
    const { errors } = await parseString(wrap(`derived a: string = name.trim("x")`));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a wrongly-typed argument", async () => {
    const { errors } = await parseString(wrap(`derived a: string = name.substring("nope")`));
    expect(errors.some((e) => e.includes("argument 1"))).toBe(true);
  });

  it("rejects named arguments", async () => {
    const { errors } = await parseString(
      wrap(`derived a: string = name.replace(of: "a", by: "b")`),
    );
    expect(errors.some((e) => e.includes("positional"))).toBe(true);
  });

  it("rejects a bare (uncalled) intrinsic access", async () => {
    const { errors } = await parseString(wrap(`derived a: string = name.trim`));
    expect(errors.some((e) => e.includes("needs a call"))).toBe(true);
  });

  it("string.contains types as bool (intrinsic), collection contains still works", async () => {
    const { errors } = await parseString(
      wrap(`
        tags: string[]
        derived a: bool = name.contains("x")
        derived b: bool = tags.contains("y")
      `),
    );
    expect(errors).toEqual([]);
  });

  it("a non-queryable intrinsic in a find where is rejected with its name (IR gate)", async () => {
    const src = `
      context C {
        aggregate Product ids guid { name: string }
        repository Products for Product {
          find bad(q: string): Product[] where this.name.substring(0, 3) == q
        }
      }
    `;
    const { model, errors } = await parseString(src);
    expect(errors).toEqual([]);
    const diags = validateLoomModel(toLoomModel(model));
    expect(
      diags.some(
        (d) => d.severity === "error" && d.message.includes("non-queryable intrinsic '.substring'"),
      ),
      JSON.stringify(diags.map((d) => d.message)),
    ).toBe(true);
  });

  it("queryable intrinsics chain in a find where (trim + toLower)", async () => {
    const src = `
      context C {
        aggregate Product ids guid { name: string }
        repository Products for Product {
          find byName(q: string): Product[] where this.name.trim().toLower() == q
        }
      }
    `;
    const { errors } = await parseString(src);
    expect(errors).toEqual([]);
  });
});
