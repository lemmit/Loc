// Page-top import-block rendering. All three renderers group names by
// source path, sort, and emit `import { … } from "…";` lines through a
// shared core. They differ only in how the path→names map is built, the
// path-sort comparator, and whether the scaffold-depth prefix rewrite
// applies — so each is a thin adapter over groupedImportLines.

import type { ApiHookUse, ImportMap } from "../body-walker.js";

/** Code-unit (default `Array.prototype.sort`) string ordering. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Render `import { … } from "<path>";` lines from a path→names map.
 *  Names are sorted within each line; sources are sorted by
 *  `comparePaths`.  When `srcImportPrefix` is non-default, paths
 *  written with the default `../` shape are rewritten to it
 *  (scaffold-expanded pages live deeper under `src/`).  An empty map
 *  renders as `""` so callers can splice without a guard. */
function groupedImportLines(
  byPath: Map<string, ReadonlySet<string>>,
  comparePaths: (a: string, b: string) => number,
  srcImportPrefix: string,
): string {
  const lines: string[] = [];
  for (const [path, names] of [...byPath.entries()].sort(([a], [b]) => comparePaths(a, b))) {
    const rewritten =
      srcImportPrefix !== "../" && path.startsWith("../") ? srcImportPrefix + path.slice(3) : path;
    lines.push(`import { ${[...names].sort().join(", ")} } from "${rewritten}";\n`);
  }
  return lines.join("");
}

/** Render the page's import block from the per-source map.  One
 *  `import { … } from "<from>";` line per source, alphabetically
 *  sorted within each line and sources sorted by `from`.  Empty
 *  map renders as an empty string so callers can splice the
 *  result without a guard. */
export function renderImportLines(
  imports: ImportMap,
  /** Page-relative prefix for paths the pack writes
   *  with the default `../` shape (which assumes pages live one
   *  hop under `src/`).  Scaffold-expanded pages live two hops
   *  under `src/`, so they pass `"../../"` and we rewrite each
   *  pack-supplied `../X` → `../../X`. */
  srcImportPrefix: string = "../",
): string {
  return groupedImportLines(imports, (a, b) => a.localeCompare(b), srcImportPrefix);
}

/** Group api-hook imports by source file so multiple ops on one
 *  aggregate (e.g. `useAllCustomers` + `useCreateCustomer`) collapse
 *  to a single import line — matches the existing scaffold output
 *  shape (one api/<aggregate>.ts per aggregate, exporting all
 *  hooks). */
export function renderApiHookImports(
  usedApiHooks: Map<string, ApiHookUse>,
  /** See `renderImportLines` for prefix semantics. */
  srcImportPrefix: string = "../",
): string {
  const byPath = new Map<string, Set<string>>();
  for (const h of usedApiHooks.values()) {
    let names = byPath.get(h.importFrom);
    if (!names) {
      names = new Set();
      byPath.set(h.importFrom, names);
    }
    names.add(h.hookName);
  }
  return groupedImportLines(byPath, byCodeUnit, srcImportPrefix);
}
