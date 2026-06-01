// ---------------------------------------------------------------------------
// Generated-code conflict detection — the PURE half (no React, no web-only
// deps), so root-level `test/playground` tests can import it without
// pulling `react` into a workspace where only root deps are installed.
// The React hook that consumes this lives in `use-generated-conflicts.ts`.
//
// When a regenerate's per-file 3-way merge can't auto-merge a hand-edited
// generated file, `generated-tree.ts` writes git-style conflict markers
// into it.  Those markers persist in the working tree until resolved — and
// a conflicted file won't bundle.
// ---------------------------------------------------------------------------

/** The opening marker the generated-tree merge writes.  Matching the head
 *  line (rather than a bare `<<<<<<<`) keeps the scan precise. */
export const CONFLICT_MARKER = "<<<<<<< your edits";

/** True iff `content` carries an unresolved generated-merge conflict. */
export function hasConflictMarkers(content: string): boolean {
  return content.includes(CONFLICT_MARKER);
}
