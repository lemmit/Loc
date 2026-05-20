// THROWAWAY SPIKE (#9 semver hardening).  tsx.  Not wired into the app.
//
// Verifies satisfies()/maxSatisfying() against the full range grammar
// real dependency trees use — caret/tilde, comparator ranges,
// hyphen, ||, and x-ranges — so the install planner can't pick a
// version outside a transitive dep's stated range.

import { satisfies, maxSatisfying } from "../src/engine/npm/semver.ts";

let ok = true;
const eq = (label, got, want) => {
  const pass = got === want;
  if (!pass) ok = false;
  console.log(`  ${pass ? "OK  " : "FAIL"} ${label}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
};

// [version, range, expected]
const cases = [
  // caret
  ["1.2.3", "^1.2.0", true],
  ["1.9.9", "^1.2.0", true],
  ["2.0.0", "^1.2.0", false],
  ["0.2.5", "^0.2.0", true],
  ["0.3.0", "^0.2.0", false],
  ["0.0.4", "^0.0.3", false],
  ["1.2.0", "^1.2", true],
  ["2.0.0", "^1.2", false],
  // tilde
  ["1.2.9", "~1.2.3", true],
  ["1.3.0", "~1.2.3", false],
  ["1.2.0", "~1.2", true],
  ["1.3.0", "~1.2", false],
  ["1.5.0", "~1", true],
  ["2.0.0", "~1", false],
  // comparators (AND)
  ["1.5.0", ">=1.2.3 <2.0.0", true],
  ["2.0.0", ">=1.2.3 <2.0.0", false],
  ["1.2.2", ">=1.2.3 <2.0.0", false],
  ["1.3.0", ">1.2.3", true],
  ["1.2.3", ">1.2.3", false],
  ["1.2.3", "<=1.2.3", true],
  ["1.2.4", "<=1.2.3", false],
  ["1.4.0", ">1.2", true],  // >1.2 → >=1.3.0
  ["1.2.9", ">1.2", false],
  // exact / partial / x-range
  ["1.2.3", "1.2.3", true],
  ["1.2.4", "1.2.3", false],
  ["1.2.9", "1.2", true],   // 1.2 → >=1.2.0 <1.3.0
  ["1.3.0", "1.2", false],
  ["1.9.9", "1.x", true],
  ["2.0.0", "1.x", false],
  ["1.2.9", "1.2.x", true],
  ["9.9.9", "*", true],
  ["9.9.9", "", true],
  // hyphen
  ["1.5.0", "1.2.0 - 2.3.4", true],
  ["2.3.4", "1.2.0 - 2.3.4", true],
  ["2.3.5", "1.2.0 - 2.3.4", false],
  ["2.3.9", "1.2.0 - 2.3", true],   // - 2.3 → <2.4.0
  ["2.4.0", "1.2.0 - 2.3", false],
  // OR
  ["3.0.0", "^1.0.0 || ^3.0.0", true],
  ["2.0.0", "^1.0.0 || ^3.0.0", false],
  // real-world transitive shapes
  ["18.3.1", ">=16.8.0", true],
  ["17.0.2", ">=16.8 <19", true],
  ["19.0.0", ">=16.8 <19", false],
];

console.log("# satisfies()");
for (const [v, r, want] of cases) eq(`satisfies(${v}, "${r}")`, satisfies(v, r), want);

console.log("# maxSatisfying()");
const pool = ["1.0.0", "1.2.0", "1.2.3", "1.9.9", "2.0.0", "2.1.0", "3.0.0", "3.0.1-beta.1"];
eq('max ^1.2.0', maxSatisfying(pool, "^1.2.0"), "1.9.9");
eq('max >=1.2.3 <2.0.0', maxSatisfying(pool, ">=1.2.3 <2.0.0"), "1.9.9");
eq('max ^1 || ^3', maxSatisfying(pool, "^1.0.0 || ^3.0.0"), "3.0.0"); // skips 3.0.1-beta
eq('max <1.0.0 (none)', maxSatisfying(pool, "<1.0.0"), null);
eq('max *', maxSatisfying(pool, "*"), "3.0.0");

console.log("");
console.log(ok ? "PASS — semver range grammar handled correctly." : "FAIL — see cases above.");
process.exit(ok ? 0 : 1);
