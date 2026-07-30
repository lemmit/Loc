// ---------------------------------------------------------------------------
// Composed git policy helpers — the small amount of policy (not
// primitives) the proposal calls for layering on top of GitStore.
//
//   - commit-on-save : stage everything + commit (the autosave cadence).
//
// `GENERATED_BASE_REF` is re-exported here (it now lives in the
// dependency-free `refs.ts`, which `git-store.ts` also reads) so this
// module's public surface is unchanged.
// ---------------------------------------------------------------------------

import type { CommitInfo, GitAuthor, GitStore } from "./git-store.js";

export { GENERATED_BASE_REF } from "./refs.js";

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
