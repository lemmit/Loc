import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  intrinsicMatcherSig,
  isIntrinsicMatcher,
  type MatcherSig,
} from "../../src/util/intrinsic-matchers.js";

// `src/util/intrinsic-matchers.ts` is a pure table plus two lookups over it.
// The table itself is module-private, so the ⟺ property below is asserted over
// the names SCANNED OUT OF THE SOURCE rather than a list re-typed here: a
// hand-copied list would drift the moment someone adds a matcher, and the whole
// point is that the two exported lookups can never disagree about the table
// they share.  `isIntrinsicMatcher` gates the validator (`checkExpectMatcher`)
// while `intrinsicMatcherSig` feeds arity checking and the per-backend
// lowering — a matcher visible to one and not the other is a crash at emit.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE = path.join(repoRoot, "src/util/intrinsic-matchers.ts");

/** Every `name:` in the `INTRINSIC_MATCHER_SIGNATURES` table literal. */
function tableNames(): string[] {
  const src = fs.readFileSync(MODULE, "utf8");
  const start = src.indexOf("const INTRINSIC_MATCHER_SIGNATURES");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n];", start);
  expect(end).toBeGreaterThan(start);
  const body = src.slice(start, end);
  return [...body.matchAll(/\{\s*name:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

const NAMES = tableNames();

// Names that are NOT matchers.  Includes `Object.prototype` keys, because the
// lookups must not answer "yes" for an inherited property name.
const NON_MATCHERS = [
  "toEqual",
  "toMatch",
  "toBeTruthy",
  "toBeSameinstant", // case-variant of a real one
  "tobe",
  "",
  "expect",
  "constructor",
  "toString",
  "hasOwnProperty",
  "__proto__",
  "valueOf",
];

describe("intrinsic matchers — the table is non-empty and unique", () => {
  it("scans a non-trivial table out of the module source", () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(9);
  });

  it("has no duplicate names (a duplicate would be silently shadowed by the Map)", () => {
    expect([...new Set(NAMES)]).toEqual(NAMES);
  });
});

describe("intrinsic matchers — isIntrinsicMatcher ⟺ intrinsicMatcherSig !== undefined", () => {
  it("agrees for every name in the table", () => {
    for (const name of NAMES) {
      expect(isIntrinsicMatcher(name)).toBe(true);
      expect(intrinsicMatcherSig(name)).toBeDefined();
      // The equivalence, stated as the biconditional itself.
      expect(isIntrinsicMatcher(name)).toBe(intrinsicMatcherSig(name) !== undefined);
    }
  });

  it("agrees for names that are not matchers, inherited object keys included", () => {
    for (const name of NON_MATCHERS) {
      expect(isIntrinsicMatcher(name)).toBe(false);
      expect(intrinsicMatcherSig(name)).toBeUndefined();
      expect(isIntrinsicMatcher(name)).toBe(intrinsicMatcherSig(name) !== undefined);
    }
  });
});

describe("intrinsic matchers — every signature is well-formed", () => {
  it("carries its own name, a non-negative integer arity, a valid `on`, a boolean `negatable`", () => {
    for (const name of NAMES) {
      const sig = intrinsicMatcherSig(name) as MatcherSig;
      expect(sig.name).toBe(name); // the Map key and the record agree
      expect(Number.isInteger(sig.arity)).toBe(true);
      expect(sig.arity).toBeGreaterThanOrEqual(0);
      expect(["locator", "value"]).toContain(sig.on);
      expect(typeof sig.negatable).toBe("boolean");
    }
  });

  it("returns the SAME record object on repeated lookups (a shared table, not a copy)", () => {
    for (const name of NAMES) {
      expect(intrinsicMatcherSig(name)).toBe(intrinsicMatcherSig(name));
    }
  });
});

describe("intrinsic matchers — the documented special cases", () => {
  it("`toBeVisible` is the zero-arg locator matcher", () => {
    const sig = intrinsicMatcherSig("toBeVisible");
    expect(sig).toMatchObject({ arity: 0, on: "locator", negatable: true });
  });

  it("the locator matchers are exactly the DOM-reading ones", () => {
    // `on: "locator"` is what routes a matcher to Playwright's auto-retrying
    // assertion; a value matcher lowers to a plain vitest/xUnit/ExUnit compare.
    const locators = NAMES.filter((n) => intrinsicMatcherSig(n)!.on === "locator").sort();
    expect(locators).toEqual(["toBeVisible", "toHaveCount", "toHaveText"]);
  });

  it("`toThrow` is the one non-negatable matcher (there is no `not.toThrow`)", () => {
    expect(intrinsicMatcherSig("toThrow")).toMatchObject({ on: "value", negatable: false });
    const nonNegatable = NAMES.filter((n) => !intrinsicMatcherSig(n)!.negatable);
    expect(nonNegatable).toEqual(["toThrow"]);
  });

  it("`toThrow`'s tabled arity is the bare-form 0 (its real arity is 0-or-1, checked elsewhere)", () => {
    // `checkMatcherArity` SKIPS toThrow and `checkToThrowMatcher` owns it, so
    // this 0 must never be read as a strict arity — pinned so a "fix" to 1
    // shows up as a deliberate change here.
    expect(intrinsicMatcherSig("toThrow")!.arity).toBe(0);
  });

  it("`toBeSameInstant` is a unary value matcher (temporal equality at the wire boundary)", () => {
    expect(intrinsicMatcherSig("toBeSameInstant")).toMatchObject({
      arity: 1,
      on: "value",
      negatable: true,
    });
  });

  it("every matcher other than the zero-arg `toBeVisible` / `toThrow` is unary", () => {
    for (const name of NAMES) {
      const sig = intrinsicMatcherSig(name)!;
      if (name === "toBeVisible" || name === "toThrow") continue;
      expect(sig.arity).toBe(1);
    }
  });
});
