import { describe, expect, it, vi } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// A4.1 — end-to-end proof that the DISPATCHER wraps each themed family in the
// guard (not just that the guard helper works in isolation).
//
// We mock ONE real check family (`checkCriteria`) to throw, then run full
// validation over a file that also carries an unrelated, well-understood
// error (a non-hex theme colour).  The guard must convert the throw into a
// single `loom.validator-check-crashed` diagnostic AND the theme error must
// still surface — one family's crash costs one check, not the document.
//
// The module mock is hoisted for the whole file, so this lives in its own
// suite (separate from the fuzz gate, which needs the real checks).
// ---------------------------------------------------------------------------

vi.mock("../../../src/language/validators/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/language/validators/index.js")>();
  return {
    ...actual,
    checkCriteria: () => {
      throw new Error("simulated criteria-check crash");
    },
  };
});

describe("validator dispatcher wraps each themed family in the guard", () => {
  it("isolates a throwing family and keeps every other family's diagnostics", async () => {
    // Silence the guard's stack log.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { errors } = await parseString(`
      system S {
        theme { primary: "not-a-hex-color" }
        subdomain M {
          context C {
            aggregate A { name: string  derived display: string = name }
            repository As for A { }
          }
        }
      }
    `);

    // The crashing family produced exactly one guard diagnostic naming it.
    const guardErrors = errors.filter((e) => /Validator check 'criteria' crashed/.test(e));
    expect(guardErrors, errors.join("\n")).toHaveLength(1);
    expect(guardErrors[0]).toMatch(/simulated criteria-check crash/);

    // The unrelated theme error still surfaced — isolation, not suppression.
    expect(
      errors.some((e) => /hex color/.test(e) && /primary/.test(e)),
      errors.join("\n"),
    ).toBe(true);

    vi.restoreAllMocks();
  });
});
