// ---------------------------------------------------------------------------
// Composed git policy helpers — the small amount of policy (not
// primitives) the proposal calls for layering on top of GitStore.
//
//   - commit-on-save : stage everything + commit (the autosave cadence).
//   - regenerate-merge: merge a freshly-generated tree into the working
//                       tree against `refs/loom/generated-base`, so a
//                       regenerate is a 3-way merge, not an overwrite.
//   - diff-for-display: a per-file diff between two refs for the UI.
//
// These keep raw git access inside GitStore; helpers only sequence its
// methods.  The full merge-conflict UX (conflict markers, in-editor
// resolution) is PR 4 — here regenerate-merge returns the structured
// MergeOutcome so a clean run and a conflicting run are both observable
// without exceptions.
// ---------------------------------------------------------------------------

import type {
  CommitInfo,
  FileDiff,
  GitAuthor,
  GitStore,
  MergeOutcome,
} from "./git-store.js";

/** The ref tracking the tree generated last time — the merge base for
 *  regeneration.  Updated to the new generated tree on every successful
 *  generate (PR 4). */
export const GENERATED_BASE_REF = "refs/loom/generated-base";

/** Stage all working-tree changes and commit them.  No-op commit is
 *  avoided by returning `undefined` when nothing was staged. */
export async function commitOnSave(
  store: GitStore,
  message: string,
  author?: GitAuthor,
): Promise<string | undefined> {
  const staged = await store.stageAll();
  if (!staged) return undefined;
  return store.commit(message, author);
}

/** Regenerate-as-merge: merge `theirsRef` (the freshly-generated tree's
 *  ref) into the working tree.  The `refs/loom/generated-base`
 *  relationship that makes this a true 3-way merge is established by the
 *  commit graph the caller maintains (PR 4); this helper is the merge
 *  step itself.  Returns the structured outcome — never throws on
 *  conflict. */
export async function regenerateMerge(
  store: GitStore,
  theirsRef: string,
  opts: { author?: GitAuthor; message?: string } = {},
): Promise<MergeOutcome> {
  return store.merge(theirsRef, {
    author: opts.author,
    message: opts.message ?? "regenerate",
  });
}

/** Per-file diff between two refs/trees, for surfacing in the UI. */
export async function diffForDisplay(
  store: GitStore,
  a: string,
  b: string,
): Promise<FileDiff[]> {
  return store.treeDiff(a, b);
}

export type { CommitInfo, FileDiff, MergeOutcome };
