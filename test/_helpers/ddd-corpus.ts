// The tracked `.ddd` population — one definition, shared by every census.
//
// Extracted when the clause census joined the file census: two sweeps over
// "every `.ddd` in the repo" that each computed the population themselves would
// drift the moment one grew an exclusion, and a census whose denominator is
// wrong is worse than no census (`experience_gathered.md` §84's coverage-claim
// class — a wrong denominator makes a coverage argument unfalsifiable).

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/** Every `.ddd` git tracks — the whole population, by construction rather than
 *  by a list someone maintains. */
export function trackedDddFiles(): string[] {
  return execSync("git ls-files '*.ddd'", { cwd: REPO_ROOT, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
}

/** `__PLATFORM__`-tokenized corpus fixtures are templates, not sources — the
 *  runners substitute a backend before parsing, and so does every census. */
export function dddSourceOf(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), "utf8").replaceAll("__PLATFORM__", "node");
}

/** The one tracked `.ddd` that cannot parse: a design document carrying a
 *  `.ddd` extension, which says so in its own header. Pinned (with the full
 *  reasoning) by `ddd-source-census.test.ts`; every other sweep skips it
 *  because a partial AST would silently under-count. */
export const UNPARSEABLE_DDD = "examples/sales-ui.ddd";
