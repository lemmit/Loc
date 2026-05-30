// ---------------------------------------------------------------------------
// Debounced commit-on-save for the workspace.
//
// `controller.write` / pack imports / generated-tree merges all persist to
// the git working tree, but persistence alone leaves history empty — the
// proposal's "versioned workspace" only becomes real once edits are
// committed.  This subscribes to `/workspace` changes and commits the
// working tree after a quiet period (debounced), so a burst of keystrokes
// collapses into one commit rather than one-per-edit.
//
// Commits go through `GitStore.commitWorkingTree`, which is serialised, so
// the debounced autosave can't interleave with an intentional regenerate
// commit; a no-op (nothing changed) is dropped by `commitWorkingTree`
// itself.  Returns a disposer that cancels any pending commit and
// unsubscribes.
// ---------------------------------------------------------------------------

import type { GitStore } from "./git-store.js";

export interface AutoCommitOptions {
  /** Quiet period before a commit fires.  Long enough to coalesce a burst
   *  of edits, short enough that a reload mid-session keeps recent work. */
  debounceMs?: number;
  /** Commit message for autosave commits. */
  message?: string;
}

const WORKSPACE_PREFIX = "/workspace/";

export function startAutoCommit(store: GitStore, opts: AutoCommitOptions = {}): () => void {
  const debounceMs = opts.debounceMs ?? 1500;
  const message = opts.message ?? "autosave workspace";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flush = (): void => {
    timer = null;
    if (disposed) return;
    void store.commitWorkingTree(message).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("auto-commit failed:", err);
    });
  };

  const unsubscribe = store.subscribe(WORKSPACE_PREFIX, () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}
