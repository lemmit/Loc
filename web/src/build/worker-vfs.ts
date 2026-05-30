// ---------------------------------------------------------------------------
// Worker-local VFS singleton.
//
// `loader-vfs.ts` reads pack templates through this module's getter.
// Threading the VFS through every preparer + render call would touch
// the entire generator and break the Node loader's contract (no
// `vfs` argument); a worker-scoped singleton sidesteps that.  Workers
// are isolates, so module-level state is per-worker — there's no
// cross-bundle leakage to worry about.
//
// `setWorkerVfs` is called exactly once at the top of `build.worker.ts`
// after the bundled built-in packs are seeded.  Calling `getWorkerVfs`
// before the seed step throws — Phase 1's safety net against test
// runs that import `loader-vfs.ts` without going through the worker
// boot path.
//
// Re-binding (calling with a different instance) is allowed: tests
// swap in stub VFS instances to exercise error paths.  The worker
// itself only ever calls this once, so the looser contract doesn't
// cost it anything.
// ---------------------------------------------------------------------------

import type { ReadableVfs } from "../vfs/types.js";

// The worker reads templates and never mutates, subscribes, or
// snapshots through this singleton, so its declared type is the
// read-only capability.  A full `Vfs` (e.g. the `MemoryVfs` the
// worker boot seeds) is assignable here, so callers are unaffected;
// the narrowing just stops anyone reaching for a mutate method off
// the worker VFS.
let current: ReadableVfs | null = null;

/** Bind the worker's VFS instance.  Last write wins; the worker
 *  itself only calls this once at boot, so re-binding only happens
 *  in tests that need a clean slate. */
export function setWorkerVfs(vfs: ReadableVfs): void {
  current = vfs;
}

/** Read the worker's VFS.  Throws when the singleton hasn't been
 *  seeded — i.e. the consumer is running outside the worker boot
 *  path.  Tests that exercise `loader-vfs.ts` directly need to call
 *  `setWorkerVfs(new MemoryVfs())` themselves. */
export function getWorkerVfs(): ReadableVfs {
  if (!current) {
    throw new Error(
      "worker-vfs: getWorkerVfs called before setWorkerVfs.  In the worker, seed via `seedBuiltinPacks` then `setWorkerVfs`; in tests, construct a MemoryVfs and bind it manually.",
    );
  }
  return current;
}
