// Script-top import-block rendering for generated .svelte files.
// Sibling of src/generator/react/walker/import-lines.ts with one
// twist: the shared walker writes api / lib import paths in the
// react-relative `../api/X` / `../lib/X` shape (see the addImport
// calls in src/generator/_walker/primitives/forms.ts).  SvelteKit
// projects resolve those through the `$lib` alias instead — file
// depth never matters, so there's no srcImportPrefix axis here.

import type { ApiHookUse, ImportMap } from "../../_walker/walker-core.js";

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Rewrite a walker-canonical module path to its SvelteKit home.
 *  `../api/X` → `$lib/api/X`; `../lib/X` → `$lib/X`; everything else
 *  (npm packages, `$lib/...` paths the svelte packs declare
 *  directly) passes through. */
export function svelteImportPath(path: string): string {
  if (path.startsWith("../api/")) return `$lib/api/${path.slice("../api/".length)}`;
  if (path.startsWith("../lib/")) return `$lib/${path.slice("../lib/".length)}`;
  return path;
}

function groupedImportLines(
  byPath: Map<string, ReadonlySet<string>>,
  comparePaths: (a: string, b: string) => number,
): string {
  const lines: string[] = [];
  for (const [path, names] of [...byPath.entries()].sort(([a], [b]) => comparePaths(a, b))) {
    lines.push(`  import { ${[...names].sort().join(", ")} } from "${svelteImportPath(path)}";\n`);
  }
  return lines.join("");
}

/** Render the page's import block from the walker's per-source map.
 *  Two-space indented — lines land inside `<script lang="ts">`. */
export function renderSvelteImportLines(imports: ImportMap): string {
  return groupedImportLines(imports, (a, b) => a.localeCompare(b));
}

/** Group api-hook imports by source module (one line per module). */
export function renderSvelteApiHookImports(usedApiHooks: Map<string, ApiHookUse>): string {
  const byPath = new Map<string, Set<string>>();
  for (const h of usedApiHooks.values()) {
    let names = byPath.get(h.importFrom);
    if (!names) {
      names = new Set();
      byPath.set(h.importFrom, names);
    }
    names.add(h.hookName);
  }
  return groupedImportLines(byPath, byCodeUnit);
}
