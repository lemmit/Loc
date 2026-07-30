// ---------------------------------------------------------------------------
// LightningFS instance + git repo bootstrap.
//
// First step of the playground's git-backed VFS migration (see
// `docs/old/plans/playground-git-vfs-implementation.md`).  This module owns
// the single durable store: a LightningFS filesystem (IndexedDB-backed)
// with an isomorphic-git repo on top.  `/workspace/**` is the tracked
// user content and `/.git/**` is the repo — both ordinary files in the
// same LightningFS instance, as the proposal's architecture diagram
// describes.
//
// The store is async by design (proposal decisions #1/#2): git is the
// single source of truth on the main thread, with no `MemoryVfs` cache
// in front of it.  We use the libraries directly (decision #3) rather
// than building a parallel VFS abstraction over them — `GitStore`
// (git-store.ts) is the only wrapper, and it is a new surface, not an
// implementation of the sync `Vfs` interface.
// ---------------------------------------------------------------------------

import FS from "@isomorphic-git/lightning-fs";
import * as git from "isomorphic-git";

/** Production IndexedDB database name for the durable store.
 *  Deliberately distinct from the legacy `loom-workspace` IDB used by
 *  `IdbVfs` so the two coexist during the PR 3 one-time import. */
export const DEFAULT_GIT_DB = "loom-workspace-git";

/** Repo working-tree root.  Tracked content lives under `/workspace`;
 *  the gitdir is `/.git`.  Keeping the repo at `/` (rather than at
 *  `/workspace`) preserves the absolute `/workspace/...` VFS path
 *  convention every existing consumer already speaks. */
export const REPO_DIR = "/";

/** Gitdir, relative to the LightningFS root. */
export const GITDIR = "/.git";

/** Workspace root — the tracked user-content tree. */
export const WORKSPACE_ROOT = "/workspace";

/** A bootstrapped store: the LightningFS instance, the repo dir, and
 *  the IDB name it was opened under.  `fs` doubles as the isomorphic-git
 *  `FsClient` — LightningFS implements the callback fs API git expects;
 *  the single structural cast lives in `asFsClient` below. */
export interface GitFs {
  readonly fs: FS;
  readonly dir: string;
  readonly name: string;
}

/** LightningFS's `FS` exposes the callback fs surface isomorphic-git
 *  consumes, but the two libraries' hand-written `.d.ts`s don't unify
 *  structurally (optional-vs-required option args).  One cast, here,
 *  keeps the rest of the module fully typed. */
export function asFsClient(fs: FS): git.FsClient {
  return fs as unknown as git.FsClient;
}

/** Open (or create) the durable store under IDB database `name`,
 *  initialising an empty git repo on first use.  Idempotent: a second
 *  `openGitFs` against the same name reattaches to the existing repo. */
export async function openGitFs(name: string = DEFAULT_GIT_DB): Promise<GitFs> {
  const fs = new FS(name);
  const gfs: GitFs = { fs, dir: REPO_DIR, name };
  if (!(await isInitialised(fs))) {
    await git.init({ fs: asFsClient(fs), dir: REPO_DIR, defaultBranch: "main" });
  }
  // Ensure the workspace root exists so it's never lazily materialised
  // mid-operation (keeps mkdir fan-out and listings predictable). Git
  // doesn't track empty dirs, so this is purely a working-tree concern.
  await ensureDir(fs, WORKSPACE_ROOT);
  return gfs;
}

/** Close the IndexedDB connection behind a `GitFs`.
 *
 *  LightningFS has no public `close()` — it drains and deactivates its
 *  backend 500 ms after the last operation — so this drives the same
 *  internal pair (`_gracefulShutdown` waits for in-flight ops, then
 *  `_deactivate` flushes the superblock and closes the IDB connection)
 *  through one narrow structural cast, in the spirit of `asFsClient`'s
 *  single-cast rule.  Best-effort and idempotent: a library build
 *  without those internals simply no-ops, and any later fs op
 *  transparently re-activates the connection.
 *
 *  Callers use it before `deleteGitDb` — `indexedDB.deleteDatabase`
 *  against a still-open connection fires `blocked` and never completes. */
export async function closeGitFs(gfs: GitFs): Promise<void> {
  await deactivateGitFs(gfs);
}

/** Drop the LightningFS **activation window** so the next read re-reads the
 *  `!root` superblock from IndexedDB.
 *
 *  Same mechanism as `closeGitFs`, different intent — hence the second name.
 *  `DefaultBackend.activate()` loads the superblock only when the cache is not
 *  already activated, and `PromisifiedFS` keeps it activated until 500 ms after
 *  the last fs call.  So a PASSIVE tab told (over the broadcast channel) that
 *  another tab just wrote can still be inside its own activation window and
 *  read its STALE metadata cache — the "file added, then gone" defect.  Force a
 *  deactivate first and the very next read is guaranteed fresh.
 *
 *  Safe from a passive tab: `deactivate()` only writes the superblock back
 *  while it holds LightningFS's own mutex, so it cannot clobber a concurrent
 *  writer's flush. */
export async function invalidateGitFsCache(gfs: GitFs): Promise<void> {
  await deactivateGitFs(gfs);
}

async function deactivateGitFs(gfs: GitFs): Promise<void> {
  const p = gfs.fs.promises as unknown as {
    _gracefulShutdown?: () => Promise<void>;
    _deactivate?: () => Promise<void>;
  };
  try {
    await p._gracefulShutdown?.();
    await p._deactivate?.();
  } catch {
    /* best-effort teardown; the delete below reports what actually happened */
  }
}

/** Outcome of a `deleteGitDb` attempt.  `blocked` means another
 *  connection (typically a second tab) still holds the database — the
 *  delete stays pending in the browser and completes once that closes. */
export type DeleteDbResult = "deleted" | "blocked" | "error" | "unsupported";

/** Drop an IndexedDB database and AWAIT the outcome, handling the
 *  `blocked` event explicitly.  The bare `indexedDB.deleteDatabase(name)`
 *  is fire-and-forget: when a connection is still open it silently fires
 *  `blocked` and the DB lingers forever with nobody the wiser. */
export function deleteGitDb(name: string, blockedTimeoutMs = 5000): Promise<DeleteDbResult> {
  if (typeof indexedDB === "undefined") return Promise.resolve("unsupported");
  return new Promise<DeleteDbResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (result: DeleteDbResult): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      resolve(result);
    };
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.deleteDatabase(name);
    } catch {
      resolve("error");
      return;
    }
    req.onsuccess = () => settle("deleted");
    req.onerror = () => settle("error");
    req.onblocked = () => {
      // Keep waiting — the delete completes as soon as the other holder
      // closes — but don't leave the caller's promise pending forever.
      timer = setTimeout(() => settle("blocked"), blockedTimeoutMs);
    };
  });
}

async function isInitialised(fs: FS): Promise<boolean> {
  try {
    await fs.promises.stat(GITDIR);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(fs: FS, path: string): Promise<void> {
  try {
    await fs.promises.mkdir(path);
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : undefined;
    if (code !== "EEXIST") throw err;
  }
}
