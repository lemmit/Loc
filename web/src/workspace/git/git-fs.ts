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
