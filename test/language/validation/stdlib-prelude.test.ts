// Loom stdlib Phase C — the ambient prelude.  Std top-level functions
// (`isBlank`/`isPresent`/`truncate`) are callable in every `.ddd` with NOTHING
// imported (like a language builtin), a user declaration of the same name WINS,
// and a call is return-typed against the std signature.

import { describe, expect, it } from "vitest";
import { stdFunctions } from "../../../src/language/stdlib.js";
import { STD_SOURCES } from "../../../src/language/stdlib-source.js";
import { parseString } from "../../_helpers/parse.js";

const wrap = (top: string, member: string): string => `
  ${top}
  context C {
    aggregate Order {
      name: string
      ${member}
    }
    repository Orders for Order { }
  }
`;

describe("stdlib prelude — parse-time", () => {
  it("every prelude module parses + validates with zero errors", async () => {
    for (const [name, source] of Object.entries(STD_SOURCES)) {
      const { errors } = await parseString(source);
      expect(errors, `std module '${name}'`).toEqual([]);
    }
  });

  it("exposes the expected prelude functions", () => {
    const names = [...stdFunctions().keys()];
    // strings
    expect(names).toContain("isBlank");
    expect(names).toContain("isPresent");
    expect(names).toContain("truncate");
    // math
    expect(names).toContain("clamp");
    expect(names).toContain("percentOf");
    expect(names).toContain("roundTo");
    // temporal
    expect(names).toContain("isOverdue");
    expect(names).toContain("isFuture");
    expect(names).toContain("isPast");
  });
});

describe("stdlib prelude — ambient use (no import)", () => {
  it("resolves and type-checks a prelude call with nothing imported", async () => {
    const { errors } = await parseString(
      wrap("", `invariant isPresent(name)\n         derived blank: bool = isBlank(name)`),
    );
    expect(errors).toEqual([]);
  });

  it("resolves ambient math + temporal prelude calls", async () => {
    const src = `
      context C {
        aggregate A {
          q: int
          amt: decimal
          due: datetime
          derived cl: int = clamp(q, 0, 10)
          derived pc: decimal = percentOf(amt, amt)
          derived rt: decimal = roundTo(amt, 2)
          derived od: bool = isOverdue(due)
          derived fut: bool = isFuture(due)
          derived pst: bool = isPast(due)
        }
        repository As for A { }
      }
    `;
    const { errors } = await parseString(src);
    expect(errors).toEqual([]);
  });

  it("type-checks the prelude call's return type (wrong declared type errors)", async () => {
    const { errors } = await parseString(wrap("", `derived bad: string = isBlank(name)`));
    expect(errors.some((e) => e.includes("bool") && e.includes("string"))).toBe(true);
  });

  it("a user top-level function of the same name shadows the prelude", async () => {
    // A user `isBlank` that returns a DIFFERENT type would surface here only if
    // the user's decl is the one type-checked. Give it an int return and assign
    // to an int derived — clean iff the USER decl (not the bool std one) wins.
    const { errors } = await parseString(
      wrap(`function isBlank(s: string): int = s.length`, `derived n: int = isBlank(name)`),
    );
    expect(errors).toEqual([]);
  });
});
