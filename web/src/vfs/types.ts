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
//   - **Sync.**  `compilePack` (`src/generator/_packs/loader.ts`)
//     is sync; the entire generator depends on it.  Going async would
//     propagate through every preparer and break the Node loader's
//     contract.  All VFS reads stay sync; pre-populate eagerly.
//   - **POSIX paths.**  Always absolute, leading `/`, `/`-separated.
//     The Node loader uses `path.join` server-side; VFS adapters
//     normalise via `posix.resolve` so behaviour matches.
//   - **String contents only in Phase 1.**  Templates, manifests, and
//     `.ddd` source are all text.  Phase 3 may add `Uint8Array` for
//     binary assets if/when packs ship images or fonts.
//
// Directories are explicit entries — created via `mkdir`, removed
// via `rmdir`.  Writing a file at `/a/b/c` does NOT create dir
// entries for `/a` or `/a/b`; intermediate folders are inferred by
// tree-rendering consumers from path strings.  The dir-entry
// concept exists only so an *empty* folder can be represented;
// populated folders need no dir entry.  See `mkdir` below.
// ---------------------------------------------------------------------------

/** Absolute POSIX path inside the VFS.  Leading `/`, no trailing
 *  slash on files; directory listings accept trailing slash on the
 *  prefix and treat it as a directory boundary. */
export type VfsPath = string;

/** Discriminator for VFS entries — files carry content, directories
 *  exist purely to make an empty folder representable.  See the
 *  top-of-file doc paragraph on intermediate folders. */
export type VfsEntryKind = "file" | "dir";

/** Tagged file entry.  The string content is read/written verbatim;
 *  binary blobs are out of scope until Phase 3. */
export interface VfsFileEntry {
  kind: "file";
  path: VfsPath;
  content: string;
}

/** Tagged directory entry.  No content field — a dir is just an
 *  existence record so the workspace UI can show empty folders. */
export interface VfsDirEntry {
  kind: "dir";
  path: VfsPath;
}

/** Either kind of VFS entry.  Used by `hydrate`, `snapshot`,
 *  `restore`, and the build-worker RPC wire shape. */
export type VfsEntry = VfsFileEntry | VfsDirEntry;

/** Listener fired whenever a write or delete touches a path under
 *  the subscribed prefix.  `changed` lists the affected absolute
 *  paths in sorted order so consumers can diff cheaply.  Listeners
 *  re-read kind via `Vfs.kindOf` if they care — the path-only
 *  signature stays so existing subscribers don't have to thread
 *  per-event metadata they don't use. */
export type VfsListener = (changed: ReadonlyArray<VfsPath>) => void;

// ---------------------------------------------------------------------------
// Capability interfaces.  The full `Vfs` is the composition of four
// role interfaces so a consumer can depend on exactly the surface it
// uses — the build-worker loader is read-only (`ReadableVfs`),
// mutating UI/controller code wants `MutableVfs`, reactive consumers
// want `ObservableVfs`, and the seed / snapshot / rehydrate paths want
// `BulkVfs`.  `Vfs` itself keeps the exact same shape it had before
// the split, so every existing implementation and consumer is
// unaffected; only the *minimum* a given site can ask for has changed.
//
// This is the "interface segregation" step of the git-backed VFS
// migration (see `docs/old/plans/playground-git-vfs-implementation.md`):
// narrowing the worker loader to `ReadableVfs` makes its read-only
// nature a type-level fact and unlocks the later removal of the
// mutate/observe methods the worker never calls.
// ---------------------------------------------------------------------------

/** Read-only view of the VFS — the only surface the build worker's
 *  pack loader needs.  Depending on this rather than the full `Vfs`
 *  makes a consumer's read-only nature a type-level fact. */
export interface ReadableVfs {
  /** Read a file's contents.  Returns `undefined` when the path
   *  isn't present OR is a directory — directories have no content
   *  to return.  Callers that need a hard guarantee should use
   *  `readRequired` so the missing-path error fires at the read
   *  site, not later when an `undefined` content blows up
   *  downstream. */
  read(path: VfsPath): string | undefined;

  /** Like `read`, but throws a clear "no entry at <path>" error when
   *  the path is missing or is a directory.  Used by the loader
   *  where every entry named in `pack.json`'s `emits` map must exist
   *  as a file. */
  readRequired(path: VfsPath): string;

  /** True iff the path has been written and not subsequently
   *  deleted — for either kind. */
  exists(path: VfsPath): boolean;

  /** True iff `path` exists AND is a file. */
  isFile(path: VfsPath): boolean;

  /** True iff `path` exists AND is a directory. */
  isDirectory(path: VfsPath): boolean;

  /** Discriminator accessor — `"file"`, `"dir"`, or `undefined`
   *  when the path doesn't exist.  Lets a subscriber inspect a
   *  notified path without two separate `isFile` / `isDirectory`
   *  calls. */
  kindOf(path: VfsPath): VfsEntryKind | undefined;

  /** List every **file** path that starts with `prefix`, sorted
   *  lexicographically.  Files-only is the load-bearing back-compat
   *  decision: every existing consumer does
   *  `for (const p of list(prefix)) { content = read(p); … }`,
   *  which would silently drop dir entries if `list` returned both
   *  kinds.  New code that needs dir entries uses `listDirs` or
   *  `listAll`.
   *
   *  A prefix without a trailing `/` matches paths starting with
   *  the literal string; a trailing `/` enforces a directory
   *  boundary (so `/designs/m` vs `/designs/m/`).  Returns absolute
   *  paths. */
  list(prefix: VfsPath): ReadonlyArray<VfsPath>;

  /** Like `list` but returns directory paths only.  Used by the
   *  workspace-sources controller to derive the set of empty
   *  folders. */
  listDirs(prefix: VfsPath): ReadonlyArray<VfsPath>;

  /** Like `list` but returns both file and directory paths.  Used
   *  where the caller wants the full picture (e.g. the build
   *  worker's `vfs.snapshot` RPC handler). */
  listAll(prefix: VfsPath): ReadonlyArray<VfsPath>;
}

/** Single-path mutation surface — write/delete a file, create/remove
 *  a directory entry. */
export interface MutableVfs {
  /** Write a single file path, creating or replacing.  Throws when
   *  the path is already a directory (use `rmdir` first if you want
   *  to repurpose).  Notifies every subscriber whose prefix is a
   *  parent of `path` (or equal). */
  write(path: VfsPath, content: string): void;

  /** Delete a single file path.  No-op when the path is absent or
   *  is a directory — callers want `rmdir` for directories; the
   *  asymmetry keeps "delete a file" call sites from accidentally
   *  taking down a folder under enumeration. */
  delete(path: VfsPath): void;

  /** Create a directory entry at `path`, idempotent — no-op when
   *  the path is already a directory.  Throws when the path is
   *  already a file (incompatible kind).  Auto-creates missing
   *  parent directories (mkdirp semantics): `mkdir("/a/b/c")` when
   *  `/a` doesn't exist creates `/a`, `/a/b`, and `/a/b/c`. */
  mkdir(path: VfsPath): void;

  /** Remove an empty directory entry at `path`.  Throws when the
   *  directory still has children (use a manual delete loop or
   *  per-entry sweep if you want recursive behaviour).  No-op when
   *  the path is absent or is a file. */
  rmdir(path: VfsPath): void;
}

/** Change-notification surface.  Split out because the build worker
 *  (read-only) and the bulk seeder never subscribe. */
export interface ObservableVfs {
  /** Subscribe to writes/deletes touching paths under `prefix`.
   *  Returns an unsubscribe function.  Used by the build worker to
   *  invalidate cached compile results when relevant files change. */
  subscribe(prefix: VfsPath, listener: VfsListener): () => void;
}

/** Bulk seed / snapshot surface — used by `seedBuiltinPacks` at
 *  worker init and by the worker-rehydrate flow. */
export interface BulkVfs {
  /** Bulk-seed entries — used by `seedBuiltinPacks` at worker init.
   *  Equivalent to a write-loop but skips per-write listener fan-out;
   *  fires a single notification per affected prefix at the end.
   *  Accepts a mix of file and directory entries; a `VfsFileEntry`
   *  carries content, a `VfsDirEntry` only its path.  Backwards-
   *  compatible legacy form `[path, content]` tuples is accepted
   *  by the implementations for ease-of-migration; new callers
   *  should pass `VfsEntry[]`. */
  hydrate(entries: Iterable<VfsEntry | readonly [VfsPath, string]>): void;

  /** Read-only snapshot of the entire VFS, primarily for tests and
   *  for the worker-rehydrate flow (Phase 2: when a worker restarts,
   *  main-thread takes a snapshot of the workspace VFS and replays
   *  it into the fresh worker).  Returns a Map so callers preserve
   *  O(1) lookup; the worker handler projects to a `VfsEntry[]`
   *  for the wire shape. */
  snapshot(): ReadonlyMap<VfsPath, VfsEntry>;
}

/** The full VFS surface — the composition of every capability.  Kept
 *  identical in shape to the pre-segregation interface so existing
 *  implementations (`MemoryVfs`, `IdbVfs`) and consumers are
 *  unaffected. */
export interface Vfs
  extends ReadableVfs,
    MutableVfs,
    ObservableVfs,
    BulkVfs {}

/** Vfs that can atomically replace its entire contents from a prior
 *  snapshot — the inverse of `snapshot()`.  Used by the tab-
 *  suspension fix (P4): on resume, replay the persisted snapshot
 *  instead of cold-rebooting.  Unlike `hydrate` (additive merge),
 *  `restore` removes entries not present in the snapshot and fires a
 *  single notification covering every affected path (added, changed,
 *  AND removed) so subscribers re-sync exactly.  Accepts the same
 *  mixed entry-or-tuple iterable shape as `hydrate`. */
export interface RestorableVfs extends Vfs {
  restore(entries: Iterable<VfsEntry | readonly [VfsPath, string]>): void;
}
