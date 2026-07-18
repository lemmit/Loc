// Canonical test-assertion matcher catalogue — a built-in "intrinsic"
// library the compiler knows by name (resolved into the IR, then lowered
// per-backend to Playwright / vitest / xUnit / ExUnit).
//
// `on` records whether the matcher reads a DOM locator (web-first,
// auto-retrying) or a plain value; `arity` is the fixed
// positional-argument count for validation.  Adding a matcher is a table
// entry here plus a per-backend lowering — no renderer special-case.
//
// Pure data: zero language / AST dependencies, so this lives at a leaf
// under src/util/ and every layer (language, ir, generator, system)
// imports from here without back-edges into language/.

export interface MatcherSig {
  name: string;
  arity: number;
  on: "locator" | "value";
  /** When this matcher reads a locator, the negated form is `not.<name>`. */
  negatable: boolean;
}

const INTRINSIC_MATCHER_SIGNATURES: ReadonlyArray<MatcherSig> = [
  { name: "toBe", arity: 1, on: "value", negatable: true },
  { name: "toBeGreaterThan", arity: 1, on: "value", negatable: true },
  { name: "toBeGreaterThanOrEqual", arity: 1, on: "value", negatable: true },
  { name: "toBeLessThan", arity: 1, on: "value", negatable: true },
  { name: "toBeLessThanOrEqual", arity: 1, on: "value", negatable: true },
  // `expect(actual).toBeSameInstant(expected)` — temporal equality that compares
  // two ISO-8601 timestamps as INSTANTS, not strings: it forgives wire-format
  // differences (e.g. .NET's `…00.0000000Z` vs the canonical `…00Z`) while still
  // catching a real difference in the point in time.  Wire-serialization is only
  // observable at the HTTP boundary, so `checkExpectMatcher` restricts it to
  // `test e2e` bodies (a domain unit test compares in-memory values with `toBe`).
  { name: "toBeSameInstant", arity: 1, on: "value", negatable: true },
  { name: "toHaveText", arity: 1, on: "locator", negatable: true },
  { name: "toHaveCount", arity: 1, on: "locator", negatable: true },
  { name: "toBeVisible", arity: 0, on: "locator", negatable: true },
  // `expect(call).toThrow()` / `.toThrow(404)` — the method-based throw
  // assertion (replaces the old `expectThrows` statement keyword).  It is
  // special: the *lowering* recognises it and rewrites the `expect` into the
  // `expect-throws` IR node (so every backend renders it as a throw the way it
  // always has), and the optional single argument pins the HTTP status of a
  // live rejection in an e2e body.  Its arity is therefore variable (0 or 1)
  // and is enforced by `checkToThrowMatcher`, which `checkMatcherArity` skips;
  // the `arity: 0` below is the bare-form default and is never strict-checked.
  { name: "toThrow", arity: 0, on: "value", negatable: false },
];

const INTRINSIC_MATCHERS = new Map(INTRINSIC_MATCHER_SIGNATURES.map((m) => [m.name, m]));

export function isIntrinsicMatcher(name: string): boolean {
  return INTRINSIC_MATCHERS.has(name);
}

export function intrinsicMatcherSig(name: string): MatcherSig | undefined {
  return INTRINSIC_MATCHERS.get(name);
}
