// ---------------------------------------------------------------------------
// Generated-code conflict detection for the Output panel.
//
// When a regenerate can't auto-merge a hand-edited generated file, the
// per-file 3-way merge writes git-style conflict markers into it
// (`generated-tree.ts` → `conflictMarkers`).  Those markers persist in the
// working tree until the user resolves them — and a conflicted file won't
// bundle.  This surfaces them as a live Output stream that self-clears
// when the markers are edited away.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { GENERATED_PREFIX, type GitStore } from "../workspace/git";

/** The opening marker the generated-tree merge writes.  Matching the head
 *  line (rather than a bare `<<<<<<<`) keeps the scan precise. */
export const CONFLICT_MARKER = "<<<<<<< your edits";

/** True iff `content` carries an unresolved generated-merge conflict. */
export function hasConflictMarkers(content: string): boolean {
  return content.includes(CONFLICT_MARKER);
}

/** Live list of workspace-relative `/workspace/generated` paths that
 *  currently carry conflict markers.  Re-scans (debounced) on every
 *  `/workspace` change, so resolving a conflict in the editor clears it. */
export function useGeneratedConflicts(store: GitStore | null): string[] {
  const [conflicts, setConflicts] = useState<string[]>([]);

  useEffect(() => {
    if (!store) {
      setConflicts([]);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scan = (): void => {
      void (async () => {
        const paths = await store.list(GENERATED_PREFIX);
        const hit: string[] = [];
        for (const abs of paths) {
          const content = await store.readFile(abs);
          if (content != null && hasConflictMarkers(content)) {
            hit.push(abs.slice(GENERATED_PREFIX.length));
          }
        }
        if (!cancelled) setConflicts(hit);
      })();
    };
    scan();
    const unsubscribe = store.subscribe("/workspace", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(scan, 400);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [store]);

  return conflicts;
}
