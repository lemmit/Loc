// ---------------------------------------------------------------------------
// React hook: live list of generated files left with unresolved
// regenerate-merge conflict markers.  Split from the pure detector
// (`generated-conflicts.ts`) so root-level tests can import the detector
// without resolving `react`.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { GENERATED_PREFIX, type GitStore } from "../workspace/git";
import { hasConflictMarkers } from "./generated-conflicts";

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
