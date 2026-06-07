// Order-preserving de-duplication by `name`.
//
// Pure, dependency-free leaf (like the rest of `src/util/`): keeps the
// first occurrence of each distinct `name` and drops later ones, so it's
// safe to import across the `generator` / `platform` layers without a
// back-edge.
//
// Primary use: when a multi-context backend deployable merges several
// `EnrichedBoundedContextIR`s into one synthetic context, the ambient
// root-level enums / value objects that enrichment folds into *every*
// context (see `enrichContext`) appear once per hosted context.  A plain
// `flatMap` would then emit duplicate top-level declarations (e.g. two
// `export const currencyEnum = …`), which the backend bundler rejects.
// Deduping by name collapses them back to one.

export function dedupeByName<T extends { name: string }>(items: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    out.push(item);
  }
  return out;
}
