// ---------------------------------------------------------------------------
// Example-import file diff.
//
// Picking an example from the picker IMPORTS it into the active workspace:
// `main.ddd` plus the example's companion `.ddd` files are overwritten, and
// every other source file in the workspace is deleted so the workspace matches
// the example exactly.  That last part is destructive — files the user added
// by hand disappear — so App.tsx confirms first, but only when this diff says
// something would actually be lost (a no-op switch must not nag).
//
// Pure and store-free: it is a set difference over paths, which is what makes
// it unit-testable away from React and IndexedDB.
// ---------------------------------------------------------------------------

/** Absolute workspace paths an example owns: `/workspace/main.ddd` plus each
 *  of its companion `.ddd` files (relative keys, with or without a leading
 *  slash — the picker's example table is hand-written). */
export function exampleKeepPaths(files?: Record<string, string>): Set<string> {
  const keep = new Set<string>(["/workspace/main.ddd"]);
  for (const rel of Object.keys(files ?? {})) {
    const clean = rel.replace(/^\/+/, "");
    if (clean.endsWith(".ddd")) keep.add(`/workspace/${clean}`);
  }
  return keep;
}

/** The workspace source files importing this example would DELETE — every
 *  existing path the example doesn't own — sorted for a stable prompt. */
export function filesDroppedByExample(
  existing: Iterable<string>,
  files?: Record<string, string>,
): string[] {
  const keep = exampleKeepPaths(files);
  return [...existing].filter((p) => !keep.has(p)).sort();
}
