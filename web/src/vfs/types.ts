// ---------------------------------------------------------------------------
// Virtual filesystem (VFS) types — the playground's IO primitive.
//
// Phase 1 of the IDE-grade refactor.  The VFS is a small, sync,
// in-memory key-value store that the playground worker uses as its
// only IO surface for templates and (later) workspace files.
//
// Built-in design packs are seeded into a worker-local VFS at
// startup from the same Vite eager-glob that used to *be* the
// loader (`template-bundled.ts`).  User packs flow in at runtime
// via the worker's mutate-RPC (Phase 2) and IDB hydration (Phase 3).
// Both sources land in the same `Map`, so the loader never sees a
// difference between bundled and user-supplied content.
//
// Design constraints:
//   - **Sync.**  `compilePack` (`src/generator/react/templating/loader.ts`)
//     is sync; the entire generator depends on it.  Going async would
//     propagate through every preparer and break the Node loader's
//     contract.  All VFS reads stay sync; pre-populate eagerly.
//   - **POSIX paths.**  Always absolute, leading `/`, `/`-separated.
//     The Node loader uses `path.join` server-side; VFS adapters
//     normalise via `posix.resolve` so behaviour matches.
//   - **String contents only in Phase 1.**  Templates, manifests, and
//     `.ddd` source are all text.  Phase 3 may add `Uint8Array` for
//     binary assets if/when packs ship images or fonts.
// ---------------------------------------------------------------------------

/** Absolute POSIX path inside the VFS.  Leading `/`, no trailing
 *  slash on files; directory listings accept trailing slash on the
 *  prefix and treat it as a directory boundary. */
export type VfsPath = string;

/** Listener fired whenever a write or delete touches a path under
 *  the subscribed prefix.  `changed` lists the affected absolute
 *  paths in sorted order so consumers can diff cheaply. */
export type VfsListener = (changed: ReadonlyArray<VfsPath>) => void;

export interface Vfs {
  /** Read a path's contents.  Returns `undefined` when the path
   *  isn't present — callers that need a hard guarantee should use
   *  `readRequired` instead so the missing-path error fires at the
   *  read site, not later when an `undefined` content blows up
   *  downstream. */
  read(path: VfsPath): string | undefined;

  /** Like `read`, but throws a clear "no entry at <path>" error when
   *  the path is missing.  Used by the loader where every entry
   *  named in `pack.json`'s `emits` map must exist. */
  readRequired(path: VfsPath): string;

  /** Write a single path, creating or replacing.  Notifies every
   *  subscriber whose prefix is a parent of `path` (or equal). */
  write(path: VfsPath, content: string): void;

  /** Delete a single path.  No-op when the path is absent.  Notifies
   *  subscribers the same way `write` does. */
  delete(path: VfsPath): void;

  /** True iff the path has been written and not subsequently deleted. */
  exists(path: VfsPath): boolean;

  /** List every path that starts with `prefix`, sorted lexicographically.
   *  A prefix without a trailing `/` matches paths starting with the
   *  literal string; a trailing `/` enforces a directory boundary
   *  (so `/themes/m` vs `/themes/m/`).  Returns absolute paths. */
  list(prefix: VfsPath): ReadonlyArray<VfsPath>;

  /** Subscribe to writes/deletes touching paths under `prefix`.
   *  Returns an unsubscribe function.  Used by the build worker to
   *  invalidate cached compile results when relevant files change. */
  subscribe(prefix: VfsPath, listener: VfsListener): () => void;

  /** Bulk-seed entries — used by `seedBuiltinPacks` at worker init.
   *  Equivalent to a write-loop but skips per-write listener fan-out;
   *  fires a single notification per affected prefix at the end. */
  hydrate(entries: Iterable<readonly [VfsPath, string]>): void;

  /** Read-only snapshot of the entire VFS, primarily for tests and
   *  for the worker-rehydrate flow (Phase 2: when a worker restarts,
   *  main-thread takes a snapshot of the workspace VFS and replays
   *  it into the fresh worker). */
  snapshot(): ReadonlyMap<VfsPath, string>;
}
