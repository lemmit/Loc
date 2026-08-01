// Import-spec merging for the targets that hoist a component into its own FILE.
//
// A hoisted `DataGrid` child collects imports from two places — the design
// pack's declared `primitive-data-grid` entries (its table chrome) and the
// walk of the computed cells (`DataGridSpec.cellImports`) — and they routinely
// name the SAME module: a flowbite grid imports `Table`/`TableBody` while an
// `EnumBadge` cell imports `Badge`, both from `flowbite-svelte`.  Emitting two
// `import { … } from "flowbite-svelte"` lines in one `<script>` block is a
// duplicate-declaration error, not a style nit, so the two lists merge here.

/** One `import { …named } from "<from>"` line's worth of symbols. */
export interface ImportSpecLike {
  from: string;
  named: readonly string[];
}

/** Merge import specs by source; names deduped and sorted, sources sorted.
 *  Stable output so the emitted component is byte-reproducible. */
export function mergedImports(
  specs: readonly ImportSpecLike[],
): { from: string; named: string[] }[] {
  const byFrom = new Map<string, Set<string>>();
  for (const s of specs) {
    let names = byFrom.get(s.from);
    if (!names) {
      names = new Set();
      byFrom.set(s.from, names);
    }
    for (const n of s.named) names.add(n);
  }
  return [...byFrom]
    .map(([from, names]) => ({ from, named: [...names].sort() }))
    .sort((a, b) => a.from.localeCompare(b.from));
}
