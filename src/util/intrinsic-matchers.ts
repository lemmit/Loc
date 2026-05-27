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
  { name: "toHaveText", arity: 1, on: "locator", negatable: true },
  { name: "toHaveCount", arity: 1, on: "locator", negatable: true },
  { name: "toBeVisible", arity: 0, on: "locator", negatable: true },
];

const INTRINSIC_MATCHERS = new Map(INTRINSIC_MATCHER_SIGNATURES.map((m) => [m.name, m]));

export function isIntrinsicMatcher(name: string): boolean {
  return INTRINSIC_MATCHERS.has(name);
}

export function intrinsicMatcherSig(name: string): MatcherSig | undefined {
  return INTRINSIC_MATCHERS.get(name);
}
