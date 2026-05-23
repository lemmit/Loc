// ---------------------------------------------------------------------------
// `WorkspaceSourcesController` — the framework-free core of the
// multi-file `.ddd` editing state.  React-only thin shell lives in
// `use-workspace-sources.ts`.
//
// Pulling the logic out of the hook gives us a unit-testable surface
// (no `renderHook` / `@testing-library/react` needed) and keeps the
// hook's body to "wire controller events to setState".  The contract
// is identical either way — see `use-workspace-sources.ts` for the
// consumer-facing documentation.
//
// Empty folders are tracked through the VFS's first-class `mkdir` /
// `rmdir` / `listDirs` surface (introduced in the VFS-directories
// refactor) — no sentinel files leak into the workspace.  A folder
// that contains a `.ddd` file is implicit (no dir entry needed; the
// file's path carries the folder structure); a folder explicitly
// created via the "New folder" UI lives as a real `kind:"dir"` entry
// in the VFS until either the user removes it or a real `.ddd` child
// appears inside it (in which case the explicit dir entry becomes
// redundant — the controller silently drops the "empty" flag on the
// next snapshot).
// ---------------------------------------------------------------------------

import type { Vfs } from "../vfs/types.js";

const WORKSPACE_PREFIX = "/workspace/";
export const DEFAULT_PATH = "/workspace/main.ddd";

export interface WorkspaceSourcesSnapshot {
  files: ReadonlyMap<string, string>;
  /** Workspace-relative folder paths that exist as empty folders
   *  — folders that have a real VFS dir entry but no `.ddd`
   *  descendants.  Folders that contain at least one `.ddd` file
   *  are NOT listed here — they're already visible via `files`.
   *  Workspace-relative form, no leading slash: `shared`,
   *  `audit/log`, … */
  emptyFolders: ReadonlySet<string>;
  activePath: string;
}

/** True iff `path` is a `.ddd` source under `/workspace/` (not e.g.
 *  a design-pack template under `/workspace/design/...`). */
export function isDddSource(path: string): boolean {
  return path.startsWith(WORKSPACE_PREFIX) && path.endsWith(".ddd");
}

/** Re-derive the `.ddd` source map from the VFS.  Pure projection —
 *  the controller holds no state the VFS doesn't also hold, so a
 *  refresh is always a full re-read (cheap at playground scale). */
export function snapshotSources(vfs: Vfs): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of vfs.list(WORKSPACE_PREFIX)) {
    if (!isDddSource(path)) continue;
    const content = vfs.read(path);
    if (content != null) out.set(path, content);
  }
  return out;
}

/** Re-derive the empty-folder set: every workspace dir entry that
 *  has no `.ddd` descendants.  A folder gains a `.ddd` child →
 *  silently drops out of the set on the next snapshot (the
 *  explicit dir entry stays in the VFS but is no longer "empty"
 *  from the workspace UI's POV). */
export function snapshotEmptyFolders(vfs: Vfs): Set<string> {
  const dirs = vfs.listDirs(WORKSPACE_PREFIX);
  if (dirs.length === 0) return new Set();
  // Mark every folder that has a `.ddd` descendant — those are not
  // empty for our purposes even though they have a real dir entry.
  const populatedFolders = new Set<string>();
  for (const path of vfs.list(WORKSPACE_PREFIX)) {
    if (!isDddSource(path)) continue;
    const rel = path.slice(WORKSPACE_PREFIX.length);
    let parent = rel;
    while (true) {
      const slash = parent.lastIndexOf("/");
      if (slash < 0) break;
      parent = parent.slice(0, slash);
      populatedFolders.add(parent);
    }
  }
  const out = new Set<string>();
  for (const dirPath of dirs) {
    const rel = dirPath.slice(WORKSPACE_PREFIX.length);
    // Exclude the bare `/workspace` ancestor that mkdirp materialises
    // implicitly — it's not a user-created empty folder.
    if (rel === "") continue;
    if (!populatedFolders.has(rel)) out.add(rel);
  }
  return out;
}

/** Pick the next `activePath` when the currently-active file has
 *  been deleted.  Prefers `/workspace/main.ddd` if it still exists,
 *  otherwise the lexicographically-first remaining file, otherwise
 *  `DEFAULT_PATH` (so the editor always has a target even with an
 *  empty workspace). */
export function pickFallbackActivePath(remainingPaths: Iterable<string>): string {
  const sorted = [...remainingPaths].sort();
  if (sorted.includes(DEFAULT_PATH)) return DEFAULT_PATH;
  return sorted[0] ?? DEFAULT_PATH;
}

/** Listener fired whenever `files`, `emptyFolders`, or `activePath`
 *  changes.  The controller snapshots all of these into the event
 *  so consumers don't have to read the controller getters after
 *  the event fires (avoids inconsistencies if a second change
 *  lands synchronously). */
export type WorkspaceSourcesListener = (snapshot: WorkspaceSourcesSnapshot) => void;

/** Framework-free state container.  Subscribes to a `Vfs` for
 *  external changes and exposes write / delete / set-active
 *  operations.  React shell is `useWorkspaceSources`; consumers
 *  outside React (e2e automation, tests) can drive this directly. */
export class WorkspaceSourcesController {
  private files: ReadonlyMap<string, string>;
  private emptyFolders: ReadonlySet<string>;
  private activePath: string = DEFAULT_PATH;
  private readonly listeners = new Set<WorkspaceSourcesListener>();
  private unsubscribeVfs: (() => void) | null = null;

  constructor(private readonly vfs: Vfs | null) {
    this.files = vfs ? snapshotSources(vfs) : new Map();
    this.emptyFolders = vfs ? snapshotEmptyFolders(vfs) : new Set();
    if (vfs) {
      this.unsubscribeVfs = vfs.subscribe(WORKSPACE_PREFIX, () => {
        this.files = snapshotSources(vfs);
        this.emptyFolders = snapshotEmptyFolders(vfs);
        this.emit();
      });
    }
  }

  /** Tear down the VFS subscription.  Idempotent. */
  dispose(): void {
    if (this.unsubscribeVfs) {
      this.unsubscribeVfs();
      this.unsubscribeVfs = null;
    }
    this.listeners.clear();
  }

  /** Subscribe to changes.  Returns an unsubscribe function. */
  subscribe(listener: WorkspaceSourcesListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot the current state.  Immutable — the returned map is
   *  the same identity for repeated calls until the next change. */
  snapshot(): WorkspaceSourcesSnapshot {
    return {
      files: this.files,
      emptyFolders: this.emptyFolders,
      activePath: this.activePath,
    };
  }

  /** Change which file the editor shows.  Pure UI state, no VFS
   *  touch. */
  setActivePath(path: string): void {
    if (this.activePath === path) return;
    this.activePath = path;
    this.emit();
  }

  /** Write a single file to the VFS.  Throws on non-`.ddd` paths so
   *  design-pack writes don't accidentally route here. */
  write(path: string, content: string): void {
    if (!this.vfs) return;
    if (!isDddSource(path)) {
      throw new Error(
        `WorkspaceSourcesController.write: path must be a /workspace/*.ddd path; got "${path}"`,
      );
    }
    this.vfs.write(path, content);
    // The VFS subscription will fire and refresh `files`; the emit
    // happens there, not here, to coalesce with any other writes
    // batched into the same notification.
  }

  /** Create an empty folder via the VFS's first-class `mkdir`.
   *  `folder` is workspace-relative (no leading slash, e.g.
   *  `shared` or `audit/log`).  `mkdir` is mkdirp + idempotent —
   *  intermediate folders are auto-created, and a folder that
   *  already exists is a no-op. */
  createEmptyFolder(folder: string): void {
    if (!this.vfs) return;
    const cleaned = folder.replace(/^\/+/, "").replace(/\/+$/, "");
    if (cleaned === "") {
      throw new Error(
        `WorkspaceSourcesController.createEmptyFolder: folder name is required`,
      );
    }
    this.vfs.mkdir(`${WORKSPACE_PREFIX}${cleaned}`);
  }

  /** Delete a file from the VFS.  If the active file was deleted,
   *  re-points `activePath` to the fallback before emitting so
   *  consumers see a consistent snapshot. */
  delete(path: string): void {
    if (!this.vfs) return;
    const wasActive = this.activePath === path;
    this.vfs.delete(path);
    if (wasActive) {
      const remaining = [...this.files.keys()].filter((p) => p !== path);
      this.activePath = pickFallbackActivePath(remaining);
      // Emit immediately so the activePath update lands at the same
      // time as the files update (the VFS-driven refresh fires
      // synchronously inside vfs.delete, so files is already
      // current).
      this.emit();
    }
  }

  /** Delete an empty folder via the VFS's `rmdir`.  Throws if the
   *  folder still has `.ddd` content inside (the VFS layer enforces
   *  this).  No-op when the folder doesn't exist or is a file path.
   *  Workspace-relative form (`shared`, `audit/log`). */
  deleteEmptyFolder(folder: string): void {
    if (!this.vfs) return;
    const cleaned = folder.replace(/^\/+/, "").replace(/\/+$/, "");
    if (cleaned === "") return;
    this.vfs.rmdir(`${WORKSPACE_PREFIX}${cleaned}`);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }
}
