// Shared client-side table-sort helper (M-T1.1).  Emitted as
// `src/lib/table-sort.ts` in the frontends whose strict templates can't carry
// the inline `as`-cast comparator (Vue/Svelte/Angular): the dynamic-key
// indexing + casts live here in plain TypeScript, and the page template just
// calls `sortRows(rows, key, dir)`.  React inlines the same logic in its JSX
// instead (see `tsxTarget.renderSortedRows`), so it does not emit this file.

/** Build the `src/lib/table-sort.ts` module source. */
export function buildTableSortHelper(): string {
  return `// Client-side row sort for interactive tables (generated — M-T1.1).
export function sortRows<T>(rows: readonly T[] | undefined, key: string, dir: string): T[] {
  if (!rows) {
    return [];
  }
  if (!key) {
    return [...rows];
  }
  return [...rows].sort((a, b) => {
    const av = sortValue((a as Record<string, unknown>)[key]);
    const bv = sortValue((b as Record<string, unknown>)[key]);
    const c = av === bv ? 0 : (av as number) < (bv as number) ? -1 : 1;
    return dir === "desc" ? -c : c;
  });
}

/** Unwrap a decimal-like cell value to a number before comparing.
 *
 * A \`money\` / \`decimal\` field arrives as a Decimal OBJECT (decimal.js), and its
 * \`valueOf()\` returns a STRING — so a bare \`<\` compares the decimal text and
 * sorts [10, 100, 9].  \`Number()\` goes through that same \`valueOf\`, which is
 * what makes it the correct numeric read.  Anything that is not an object, or
 * whose numeric form is NaN, is returned untouched so string and boolean
 * columns keep their existing ordering.  Arrays are excluded explicitly:
 * \`Number([])\` is 0, which would silently reorder them.
 */
function sortValue(v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return v;
  }
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

// Client-side row filter for interactive tables (generated — M-T1.1).
// Case-insensitive substring match across every value of each row; an empty
// query passes all rows.  Emitted alongside sortRows in the same module for
// the strict-template frontends (Vue/Svelte/Angular); React inlines it.
export function filterRows<T>(rows: readonly T[] | undefined, query: string): T[] {
  if (!rows) {
    return [];
  }
  const q = query.trim().toLowerCase();
  if (q === "") {
    return [...rows];
  }
  return rows.filter((r) =>
    Object.values(r as Record<string, unknown>).some(
      (v) => v != null && String(v).toLowerCase().includes(q),
    ),
  );
}
`;
}
