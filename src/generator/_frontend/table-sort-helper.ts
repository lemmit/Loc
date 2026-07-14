// Shared client-side table-sort helper (M-T1.1).  Emitted as
// `src/lib/table-sort.ts` in the frontends whose strict templates can't carry
// the inline `as`-cast comparator (Vue/Svelte/Angular): the dynamic-key
// indexing + casts live here in plain TypeScript, and the page template just
// calls `sortRows(rows, key, dir)`.  React inlines the same logic in its JSX
// instead (see `tsxTarget.renderSortedRows`), so it does not emit this file.

/** Build the `src/lib/table-sort.ts` module source. */
export function buildTableSortHelper(): string {
  return `// Client-side row sort for interactive tables (generated — M-T1.1).
export function sortRows<T>(rows: readonly T[], key: string, dir: string): T[] {
  if (!key) {
    return [...rows];
  }
  return [...rows].sort((a, b) => {
    const av = (a as Record<string, unknown>)[key];
    const bv = (b as Record<string, unknown>)[key];
    const c = av === bv ? 0 : (av as number) < (bv as number) ? -1 : 1;
    return dir === "desc" ? -c : c;
  });
}
`;
}
