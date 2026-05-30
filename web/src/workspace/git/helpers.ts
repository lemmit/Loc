// ---------------------------------------------------------------------------
// Composed git policy helpers — the small amount of policy (not
// primitives) the proposal calls for layering on top of GitStore.
//
//   - commit-on-save : stage everything + commit (the autosave cadence).
//
// The `GENERATED_BASE_REF` constant lives here too — it's the ref the
// generated-tree merge stores its last-output snapshot blob behind.
// ---------------------------------------------------------------------------

import type { CommitInfo, GitAuthor, GitStore } from "./git-store.js";

/** The ref the generated-tree merge stores the last generated output
 *  behind (as a JSON blob) — the base for the per-file 3-way merge in
 *  `generated-tree.ts`. */
export const GENERATED_BASE_REF = "refs/loom/generated-base";

/** Stage all working-tree changes and commit them.  Delegates to
 *  `GitStore.commitWorkingTree` so every commit path (autosave +
 *  regenerate) shares one serialised lock and a no-op (nothing staged)
 *  returns `undefined`. */
export async function commitOnSave(
  store: GitStore,
  message: string,
  author?: GitAuthor,
): Promise<string | undefined> {
  return store.commitWorkingTree(message, author);
}

export type { CommitInfo };
