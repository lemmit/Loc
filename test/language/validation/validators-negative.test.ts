// Negative-case tests for validators whose error branches are not
// otherwise covered by `validation.test.ts`.
//
// Scope (only the genuine gaps after a sweep of validation.test.ts):
//   - traceability.ts : duplicate prop, non-int priority
//   - ui.ts           : checkTheme (all branches), checkUiHelperImports
//   - match.ts        : `matches()` wrong arg count + named arg
//
// All other branches are already exercised in validation.test.ts —
// see that file for the canonical pattern this suite mirrors.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const parse = (source: string) => parseString(source);

describe("validators (negative) — traceability", () => {
  it("flags duplicate property within a single requirement", async () => {
    const { errors } = await parse(`
      requirement R1 {
        type: UserStory
        title: "first"
        title: "second"
      }
    `);
    expect(errors.some((e) => /Duplicate requirement property 'title'/.test(e))).toBe(true);
  });

  it("flags non-integer priority", async () => {
    const { errors } = await parse(`
      requirement R1 {
        type: UserStory
        title: "x"
        priority: "high"
      }
    `);
    expect(errors.some((e) => /priority must be an integer/.test(e))).toBe(true);
  });
});

describe("validators (negative) — theme block", () => {
  it("rejects unknown theme property", async () => {
    const { errors } = await parse(`
      system S {
        theme {
          mystery: "#112233"
        }
      }
    `);
    expect(errors.some((e) => /unknown theme property 'mystery'/.test(e))).toBe(true);
  });

  it("rejects duplicate theme property", async () => {
    const { errors } = await parse(`
      system S {
        theme {
          primary: "#112233"
          primary: "#334455"
        }
      }
    `);
    expect(errors.some((e) => /theme property 'primary' declared more than once/.test(e))).toBe(
      true,
    );
  });

  it("rejects non-hex color value on a color token", async () => {
    const { errors } = await parse(`
      system S {
        theme {
          primary: "red"
        }
      }
    `);
    expect(errors.some((e) => /theme 'primary' must be a CSS hex color/.test(e))).toBe(true);
  });

  it("rejects invalid radius enum value", async () => {
    const { errors } = await parse(`
      system S {
        theme {
          radius: "huge"
        }
      }
    `);
    expect(errors.some((e) => /theme 'radius' must be one of/.test(e))).toBe(true);
  });

  it("rejects invalid colorScheme enum value", async () => {
    const { errors } = await parse(`
      system S {
        theme {
          colorScheme: "neon"
        }
      }
    `);
    expect(errors.some((e) => /theme 'colorScheme' must be one of/.test(e))).toBe(true);
  });

  it("accepts a well-formed theme block (sanity)", async () => {
    const { errors } = await parse(`
      system S {
        theme {
          primary: "#3366ff"
          neutral: "#888"
          radius: "md"
          colorScheme: "auto"
          fontFamily: "Inter, sans-serif"
        }
      }
    `);
    expect(errors).toEqual([]);
  });
});

describe("validators (negative) — match / matches()", () => {
  it("rejects a `matches` call with zero arguments", async () => {
    const { errors } = await parse(`
      context T {
        aggregate A {
          email: string
          invariant email.matches()
        }
      }
    `);
    expect(errors.some((e) => /'matches' takes exactly one argument/.test(e))).toBe(true);
  });

  it("rejects a `matches` call with two arguments", async () => {
    const { errors } = await parse(`
      context T {
        aggregate A {
          email: string
          invariant email.matches("^a$", "extra")
        }
      }
    `);
    expect(errors.some((e) => /'matches' takes exactly one argument/.test(e))).toBe(true);
  });

  // Regression (B5): Langium's STRING terminal STRIPS the delimiters, so a
  // `matches` pattern beginning with an (escaped) quote arrives as a literal
  // `"` — a regex char, not a JSON delimiter.  The old code ran `JSON.parse`
  // on any raw starting with `"`, which (a) threw an uncaught SyntaxError on a
  // quote-leading pattern and (b) silently JSON-unescaped, regex-checking the
  // WRONG string.  Since validation is one document-level function, that throw
  // wiped every diagnostic for the file.
  const wrap = (invariant: string) =>
    `context T {\n  aggregate A {\n    email: string\n    ${invariant}\n  }\n}`;

  it("validates a quote-leading pattern without crashing (no uncaught SyntaxError)", async () => {
    // Pattern text is `"[A-Z]` — a literal quote then a char class: a VALID
    // regex.  The old JSON.parse('"[A-Z]') threw and killed all diagnostics.
    const { errors } = await parse(wrap(String.raw`invariant email.matches("\"[A-Z]")`));
    expect(errors.some((e) => /An error occurred during validation/.test(e))).toBe(false);
    expect(errors.some((e) => /not a valid regular expression/.test(e))).toBe(false);
    expect(errors).toEqual([]);
  });

  it("still errors on an actually-invalid regex", async () => {
    // `[A-Z` — unterminated character class.
    const { errors } = await parse(wrap(`invariant email.matches("[A-Z")`));
    expect(errors.some((e) => /An error occurred during validation/.test(e))).toBe(false);
    expect(errors.some((e) => /'matches' pattern is not a valid regular expression/.test(e))).toBe(
      true,
    );
  });

  it("checks an escaped-quote pattern as-written, not JSON-unescaped", async () => {
    // Pattern text is `"\d"` — a valid regex (literal quote, digit class,
    // literal quote).  The old code would JSON.parse('"\\d"') → but `\d` is an
    // INVALID JSON escape, so it threw; checking the raw string (as-written)
    // is the correct behaviour and validates cleanly.
    const { errors } = await parse(wrap(String.raw`invariant email.matches("\"\\d\"")`));
    expect(errors.some((e) => /An error occurred during validation/.test(e))).toBe(false);
    expect(errors).toEqual([]);
  });
});
