// ---------------------------------------------------------------------------
// RestorableVfs — the State Bridge contract.
//
// The existing `Vfs` (../vfs/types.ts) already exposes `snapshot()`.
// The tab-suspension fix (P4) needs the inverse: atomically replay a
// snapshot back into a fresh VFS on resume.  Declared here as an
// additive extension so P3 can implement `restore` on MemoryVfs /
// IdbVfs without touching the base interface or its current callers.
//
// P3 makes the whole playground bind to ONE RestorableVfs instance
// (build worker, editor, file-tree, engine all read/write the same
// store) — the doc's "Shared Unified VFS / State Bridge".
// ---------------------------------------------------------------------------

import type { Vfs, VfsPath } from "../vfs/types.js";

export interface RestorableVfs extends Vfs {
  /** Replace the entire contents with `entries`, atomically, then
   *  fire a single notification per affected prefix.  Used on
   *  resume-from-suspension and on worker rehydrate. */
  restore(entries: Iterable<readonly [VfsPath, string]>): void;
}
